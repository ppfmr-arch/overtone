use crate::models::{Library, ProviderError, SearchResponse, Track};
use crate::state::AppState;
use axum::{
    extract::{Path, Query, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/providers", get(providers))
        .route("/api/search", get(search))
        .route("/api/stream/{provider}/{id}", get(crate::stream::handler))
        .route("/api/local/art/{id}", get(local_art))
        .route("/api/library", get(get_library).put(put_library))
        .route("/api/library/scan", post(scan))
        .route("/api/library/tracks", get(local_tracks))
        .with_state(state)
}

/// Ключ сессии. Порт локальный, но перебирается за секунды, а CORS здесь заведомо
/// разрешающий — иначе рендерер с `file://` не сможет ходить в API. Без ключа любая
/// открытая в браузере страница дотянулась бы до фонотеки: подменила бы корневые
/// папки, запустила скан диска и выкачала файлы через `/api/stream`.
///
/// Ключ принимается и в заголовке, и параметром `t`: `<audio src>` и `<img src>`
/// своих заголовков не ставят, им нужен адрес.
pub async fn require_token(
    State(expected): State<Arc<String>>,
    req: Request,
    next: Next,
) -> Response {
    let from_query = req.uri().query().and_then(|q| query_param(q, "t"));
    let from_header = req
        .headers()
        .get("x-mp-token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    match from_query.or(from_header) {
        Some(t) if constant_eq(&t, &expected) => next.run(req).await,
        _ => (StatusCode::UNAUTHORIZED, "нужен ключ сессии").into_response(),
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k != key {
            return None;
        }
        Some(urlencoding::decode(v).ok()?.into_owned())
    })
}

/// Сравнение без раннего выхода: цена — пара наносекунд, а рассуждать о том,
/// достижим ли тут тайминг-оракул, не приходится.
fn constant_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn health(State(app): State<AppState>) -> Json<serde_json::Value> {
    let _ = &app;
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn providers(State(app): State<AppState>) -> Json<serde_json::Value> {
    let list: Vec<_> = app
        .registry
        .all()
        .map(|p| json!({ "id": p.id(), "label": p.label() }))
        .collect();
    Json(json!(list))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    /// Список id провайдеров через запятую. Пусто = искать везде.
    #[serde(default)]
    providers: String,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    25
}

async fn search(State(app): State<AppState>, Query(q): Query<SearchQuery>) -> Response {
    let query = q.q.trim().to_string();
    if query.is_empty() {
        return Json(SearchResponse {
            tracks: vec![],
            errors: vec![],
        })
        .into_response();
    }

    let wanted: Vec<String> = q
        .providers
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // Источники опрашиваем параллельно: выдача упирается в самый медленный,
    // а не в их сумму.
    let futures: Vec<_> = app
        .registry
        .all()
        .filter(|p| wanted.is_empty() || wanted.iter().any(|w| w == p.id()))
        .map(|p| {
            let query = query.clone();
            async move { (p.id(), p.search(&query, q.limit).await) }
        })
        .collect();

    let results = futures_util::future::join_all(futures).await;

    let mut tracks: Vec<Track> = Vec::new();
    let mut errors: Vec<ProviderError> = Vec::new();
    for (id, res) in results {
        match res {
            Ok(mut t) => tracks.append(&mut t),
            Err(e) => errors.push(ProviderError {
                provider: id.to_string(),
                message: e.to_string(),
            }),
        }
    }

    // Перемешиваем источники по кругу, чтобы выдача не начиналась
    // двадцатью треками одного провайдера.
    tracks = interleave(tracks);

    Json(SearchResponse { tracks, errors }).into_response()
}

fn interleave(tracks: Vec<Track>) -> Vec<Track> {
    let mut groups: Vec<Vec<Track>> = Vec::new();
    for t in tracks {
        match groups.iter_mut().find(|g| g[0].provider == t.provider) {
            Some(g) => g.push(t),
            None => groups.push(vec![t]),
        }
    }
    let mut out = Vec::new();
    let mut i = 0;
    loop {
        let mut added = false;
        for g in &groups {
            if let Some(t) = g.get(i) {
                out.push(t.clone());
                added = true;
            }
        }
        if !added {
            break;
        }
        i += 1;
    }
    out
}

async fn local_art(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    match app.local.artwork(&id).await {
        Some((mime, bytes)) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "public, max-age=86400".into()),
            ],
            bytes,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn get_library(State(app): State<AppState>) -> Json<Library> {
    Json(app.library.read().await.clone())
}

async fn put_library(State(app): State<AppState>, Json(lib): Json<Library>) -> Response {
    let roots_changed = {
        let mut cur = app.library.write().await;
        let changed = cur.local_roots != lib.local_roots;
        *cur = lib;
        changed
    };

    if let Err(e) = app.save_library().await {
        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
    }

    if roots_changed {
        let roots = app.library.read().await.local_roots.clone();
        app.local.rescan(&roots).await;
    }

    Json(json!({ "ok": true })).into_response()
}

async fn scan(State(app): State<AppState>) -> Json<serde_json::Value> {
    let roots = app.library.read().await.local_roots.clone();
    let count = app.local.rescan(&roots).await;
    Json(json!({ "count": count }))
}

async fn local_tracks(State(app): State<AppState>) -> Json<Vec<Track>> {
    Json(app.local.all_tracks().await)
}
