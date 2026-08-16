use crate::state::AppState;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

/// Единая точка воспроизведения: `<audio src="/api/stream/ytmusic/VIDEOID">`.
///
/// Прокси нужен не ради красоты — googlevideo и SoundCloud требуют своих
/// заголовков и не выдают CORS, а прямая ссылка живёт минуты. Здесь же
/// прозрачно пробрасывается Range, без которого не работает перемотка.
pub async fn handler(
    State(app): State<AppState>,
    Path((provider_id, track_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let Some(provider) = app.registry.get(&provider_id) else {
        return (StatusCode::NOT_FOUND, format!("нет провайдера {provider_id}")).into_response();
    };

    let source = match provider.resolve(&track_id).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(provider = %provider_id, id = %track_id, error = %e, "резолв не удался");
            return (StatusCode::BAD_GATEWAY, e.to_string()).into_response();
        }
    };

    let range = headers.get(header::RANGE).cloned();

    if let Some(path) = source.url.strip_prefix("file://") {
        return serve_file(path, range).await;
    }

    let mut req = app.http.get(&source.url);
    for (k, v) in &source.headers {
        req = req.header(k, v);
    }
    if let Some(r) = &range {
        req = req.header(header::RANGE, r);
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut out = Response::builder().status(status);

    // Переносим только заголовки, влияющие на воспроизведение и перемотку.
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
    ] {
        if let Some(v) = upstream.headers().get(&name) {
            out = out.header(name, v);
        }
    }

    out.body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())
}

async fn serve_file(path: &str, range: Option<HeaderValue>) -> Response {
    let mut file = match tokio::fs::File::open(path).await {
        Ok(f) => f,
        Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    };
    let total = match file.metadata().await {
        Ok(m) => m.len(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let mime = mime_for(path);

    let Some((start, end)) = range.as_ref().and_then(|r| parse_range(r, total)) else {
        let stream = ReaderStream::new(file);
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, total)
            .header(header::ACCEPT_RANGES, "bytes")
            .body(Body::from_stream(stream))
            .unwrap();
    };

    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let len = end - start + 1;
    let stream = ReaderStream::new(file.take(len));

    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}"))
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Поддерживаем только форму `bytes=START-[END]` — единственную, которую шлёт Chromium.
fn parse_range(value: &HeaderValue, total: u64) -> Option<(u64, u64)> {
    let s = value.to_str().ok()?.strip_prefix("bytes=")?;
    let (a, b) = s.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let end = match b.trim() {
        "" => total.saturating_sub(1),
        v => v.parse::<u64>().ok()?.min(total.saturating_sub(1)),
    };
    (start <= end && start < total).then_some((start, end))
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_ascii_lowercase).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a" | "aac" | "alac") => "audio/mp4",
        Some("ogg" | "opus") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}
