use super::{collect_by_key, first_str, parse_clock, Provider};
use crate::models::{StreamSource, Track};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

const SEARCH_KEY: &str = "AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const PLAYER_KEY: &str = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/// Вкладки выдачи Innertube (base64 protobuf, различаются одним байтом типа).
/// Брать обе обязательно: «Songs» — это лицензированный каталог, а всё, что живёт
/// на YouTube пользовательскими загрузками — старый андеграунд, каверы, редкости, —
/// попадает только в «Videos». Без второй вкладки такие треки не находятся вовсе.
/// Общий фильтр без типа сюда не годится: он тянет ещё плейлисты и подкасты.
const FILTER_SONGS: &str = "EgWKAQIIAWoKEAkQBRAKEAMQBA==";
const FILTER_VIDEOS: &str = "EgWKAQIQAWoKEAkQBRAKEAMQBA==";

/// Клиенты, которых пробуем по очереди для получения ссылки на аудио.
/// Мобильные клиенты отдают `url` напрямую, без подписи и n-трансформа,
/// которые пришлось бы исполнять как JS. Порядок = убывание надёжности.
struct PlayerClient {
    name: &'static str,
    version: &'static str,
    /// X-YouTube-Client-Name
    id: u32,
    user_agent: &'static str,
    extra_context: Option<fn() -> Value>,
}

const PLAYER_CLIENTS: &[PlayerClient] = &[
    PlayerClient {
        name: "IOS_MUSIC",
        version: "8.12.2",
        id: 26,
        user_agent: "com.google.ios.youtubemusic/8.12.2 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)",
        extra_context: Some(|| {
            json!({
                "deviceMake": "Apple",
                "deviceModel": "iPhone16,2",
                "osName": "iPhone",
                "osVersion": "18.1.0.22B83",
                "platform": "MOBILE"
            })
        }),
    },
    PlayerClient {
        name: "ANDROID_MUSIC",
        version: "8.12.53",
        id: 21,
        user_agent: "com.google.android.apps.youtube.music/8.12.53 (Linux; U; Android 14) gzip",
        extra_context: Some(|| {
            json!({
                "androidSdkVersion": 34,
                "osName": "Android",
                "osVersion": "14",
                "platform": "MOBILE"
            })
        }),
    },
    PlayerClient {
        name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
        version: "2.0",
        id: 85,
        user_agent: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Safari/605.1.15",
        extra_context: None,
    },
];

pub struct YtMusicProvider {
    http: reqwest::Client,
}

impl YtMusicProvider {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    fn context(client: &PlayerClient) -> Value {
        let mut c = json!({
            "clientName": client.name,
            "clientVersion": client.version,
            "hl": "en",
            "gl": "US",
        });
        if let Some(extra) = client.extra_context {
            if let (Some(dst), Value::Object(src)) = (c.as_object_mut(), extra()) {
                dst.extend(src);
            }
        }
        json!({ "context": { "client": c } })
    }
}

#[async_trait]
impl Provider for YtMusicProvider {
    fn id(&self) -> &'static str {
        "ytmusic"
    }

    fn label(&self) -> &'static str {
        "YouTube Music"
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Track>> {
        // Две вкладки — два запроса, но параллельных: это дешевле, чем «ничего не найдено».
        let (songs, videos) = tokio::join!(
            self.search_tab(query, FILTER_SONGS),
            self.search_tab(query, FILTER_VIDEOS),
        );

        // Одна отвалившаяся вкладка не повод терять вторую.
        let tracks = match (songs, videos) {
            (Ok(a), Ok(b)) => [a, b].concat(),
            (Ok(list), Err(e)) | (Err(e), Ok(list)) => {
                tracing::debug!(error = %e, "одна из вкладок ytmusic не ответила");
                list
            }
            (Err(a), Err(b)) => return Err(a.context(format!("вторая вкладка тоже: {b}"))),
        };

        // Один и тот же ролик попадает в обе вкладки; первым идёт каталожный вариант.
        let mut seen = std::collections::HashSet::new();
        let tracks: Vec<Track> = tracks
            .into_iter()
            .filter(|t| seen.insert(t.id.clone()))
            .collect();

        // Ранжируем сами. Склеенные встык вкладки дают двадцать чужих «Last Breath»
        // из каталога раньше единственного точного «Absurd - Last Breath» из видео,
        // потому что внутри своей вкладки каждый список уже отсортирован.
        let terms = query_terms(query);
        let mut ranked: Vec<(u32, usize, Track)> = tracks
            .into_iter()
            .enumerate()
            .map(|(i, t)| (relevance(&t, &terms), i, t))
            .collect();
        // При равном счёте — исходный порядок, то есть каталог раньше видео.
        ranked.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

        Ok(ranked.into_iter().take(limit).map(|(_, _, t)| t).collect())
    }

    /// Прямую ссылку YouTube анонимным клиентам почти никогда не отдаёт —
    /// приложение играет такие треки через окно с самим сайтом (см. README).
    /// Здесь остаётся честная попытка: вдруг конкретный ролик открыт.
    async fn resolve(&self, id: &str) -> Result<StreamSource> {
        let mut last_err = None;

        for client in PLAYER_CLIENTS {
            match self.resolve_with(id, client).await {
                Ok(src) => return Ok(src),
                Err(e) => {
                    tracing::debug!(client = client.name, error = %e, "клиент не отдал поток");
                    last_err = Some(e);
                }
            }
        }

        Err(anyhow!(
            "YouTube не отдал прямую ссылку ({}). Такие треки играет окно music.youtube.com",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "причина неизвестна".into())
        ))
    }
}

impl YtMusicProvider {
    /// Одна вкладка выдачи. Лимит здесь не режем: отбор идёт после слияния.
    async fn search_tab(&self, query: &str, params: &str) -> Result<Vec<Track>> {
        let body = json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": "1.20250101.01.00",
                    "hl": "en",
                    "gl": "US",
                }
            },
            "query": query,
            "params": params,
        });

        let resp: Value = self
            .http
            .post(format!(
                "https://music.youtube.com/youtubei/v1/search?key={SEARCH_KEY}&prettyPrint=false"
            ))
            .header("Origin", "https://music.youtube.com")
            .header("Referer", "https://music.youtube.com/")
            .header("X-Goog-Api-Format-Version", "1")
            .header("X-YouTube-Client-Name", "67")
            .header("X-YouTube-Client-Version", "1.20250101.01.00")
            .json(&body)
            .send()
            .await
            .context("запрос к Innertube не прошёл")?
            .error_for_status()
            .context("Innertube вернул ошибку")?
            .json()
            .await
            .context("Innertube вернул не-JSON")?;

        let mut items = Vec::new();
        collect_by_key(&resp, "musicResponsiveListItemRenderer", &mut items);
        Ok(items.into_iter().filter_map(parse_item).collect())
    }

    async fn resolve_with(&self, id: &str, client: &PlayerClient) -> Result<StreamSource> {
        let mut body = Self::context(client);
        if let Some(obj) = body.as_object_mut() {
            obj.insert("videoId".into(), json!(id));
            obj.insert("contentCheckOk".into(), json!(true));
            obj.insert("racyCheckOk".into(), json!(true));
        }

        let resp: Value = self
            .http
            .post(format!(
                "https://youtubei.googleapis.com/youtubei/v1/player?key={PLAYER_KEY}&prettyPrint=false"
            ))
            .header("User-Agent", client.user_agent)
            .header("X-YouTube-Client-Name", client.id.to_string())
            .header("X-YouTube-Client-Version", client.version)
            .header("Origin", "https://www.youtube.com")
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let status = resp
            .pointer("/playabilityStatus/status")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");
        if status != "OK" {
            let reason = resp
                .pointer("/playabilityStatus/reason")
                .and_then(|v| v.as_str())
                .unwrap_or("без причины");
            return Err(anyhow!("playabilityStatus={status} ({reason})"));
        }

        let formats = resp
            .pointer("/streamingData/adaptiveFormats")
            .and_then(|v| v.as_array())
            .ok_or_else(|| anyhow!("нет adaptiveFormats"))?;

        let best = formats
            .iter()
            .filter(|f| {
                f.get("mimeType")
                    .and_then(|m| m.as_str())
                    .is_some_and(|m| m.starts_with("audio/"))
                    && f.get("url").and_then(|u| u.as_str()).is_some()
            })
            .max_by_key(|f| f.get("bitrate").and_then(|b| b.as_u64()).unwrap_or(0))
            .ok_or_else(|| {
                // Есть signatureCipher вместо url — расшифровка требует исполнения JS-плеера.
                anyhow!("аудиодорожки без прямой ссылки (нужна расшифровка подписи)")
            })?;

        Ok(StreamSource {
            url: best["url"].as_str().unwrap().to_string(),
            headers: vec![
                ("User-Agent".into(), client.user_agent.into()),
                ("Origin".into(), "https://www.youtube.com".into()),
            ],
            mime: best
                .get("mimeType")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string()),
        })
    }
}

/// Слова запроса в нижнем регистре, без пунктуации. Односимвольные отбрасываем:
/// они совпадают почти со всем и только размывают счёт.
fn query_terms(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.chars().count() > 1)
        .map(str::to_string)
        .collect()
}

/// Сколько слов запроса встретилось в «название + исполнитель».
fn relevance(track: &Track, terms: &[String]) -> u32 {
    let hay = format!("{} {}", track.title, track.artist).to_lowercase();
    terms.iter().filter(|t| hay.contains(t.as_str())).count() as u32
}

/// «21K views» стоит во вкладке видео ровно там же, где у песни альбом,
/// и без отсева уезжает в поле альбома.
fn is_view_count(s: &str) -> bool {
    let s = s.to_lowercase();
    s.ends_with("views") || s.ends_with("view") || s.contains("просмотр")
}

/// Разбор одной строки выдачи. Формат гибкий: колонок может быть 2 или 3,
/// а порядок «артист · альбом · длительность» плавает, поэтому берём
/// длительность как последний run вида mm:ss, а остальное — по позиции.
fn parse_item(item: &Value) -> Option<Track> {
    let video_id = first_str(item.get("overlay")?, "videoId")
        .or_else(|| first_str(item, "videoId"))?
        .to_string();

    let mut columns: Vec<Vec<String>> = Vec::new();
    let mut flex = Vec::new();
    collect_by_key(item, "musicResponsiveListItemFlexColumnRenderer", &mut flex);
    for col in flex {
        let runs = col
            .pointer("/text/runs")
            .and_then(|r| r.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get("text").and_then(|t| t.as_str()))
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !runs.is_empty() {
            columns.push(runs);
        }
    }

    let title = columns.first()?.join("").trim().to_string();
    if title.is_empty() {
        return None;
    }

    // Вторая колонка — «Артист · Альбом · 3:45», разделители тоже приходят как runs.
    // Режем строго по «•»: внутри одного поля бывают свои разделители, и если рубить
    // по ним тоже, то «Queen & Adam Lambert» распадётся, «&» встанет альбомом,
    // а настоящий альбом уедет за край.
    let subtitle: Vec<String> = columns
        .get(1)
        .map(|runs| {
            let mut fields = Vec::new();
            let mut cur = String::new();
            for run in runs {
                if matches!(run.trim(), "•" | "·") {
                    if !cur.trim().is_empty() {
                        fields.push(cur.trim().to_string());
                    }
                    cur.clear();
                } else {
                    cur.push_str(run);
                }
            }
            if !cur.trim().is_empty() {
                fields.push(cur.trim().to_string());
            }
            fields
        })
        .unwrap_or_default();

    let duration_ms = subtitle.iter().rev().find_map(|s| parse_clock(s));
    let meta: Vec<&String> = subtitle
        .iter()
        .filter(|s| parse_clock(s).is_none() && !is_view_count(s))
        .collect();

    // Первый элемент — почти всегда исполнитель. Иногда первым идёт тип («Song»),
    // тогда сдвигаемся на следующий.
    let mut meta_iter = meta.iter().peekable();
    if meta_iter
        .peek()
        .is_some_and(|s| matches!(s.as_str(), "Song" | "Video" | "Песня" | "Видео"))
    {
        meta_iter.next();
    }
    let artist = meta_iter
        .next()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Unknown".into());
    let album = meta_iter.next().map(|s| s.to_string());

    let artwork = {
        let mut thumbs = Vec::new();
        collect_by_key(item, "thumbnails", &mut thumbs);
        thumbs
            .into_iter()
            .filter_map(|t| t.as_array())
            .flat_map(|a| a.iter())
            .max_by_key(|t| t.get("width").and_then(|w| w.as_u64()).unwrap_or(0))
            .and_then(|t| t.get("url").and_then(|u| u.as_str()))
            .map(|s| s.to_string())
    };

    Some(Track {
        web_url: Some(format!("https://music.youtube.com/watch?v={video_id}")),
        id: video_id,
        provider: "ytmusic".into(),
        title,
        artist,
        album,
        duration_ms,
        artwork,
    })
}
