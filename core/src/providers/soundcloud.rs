use super::Provider;
use crate::models::{StreamSource, Track};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use regex::Regex;
use serde_json::Value;
use tokio::sync::RwLock;

/// У SoundCloud нет публичной регистрации приложений с 2019 года, но веб-плеер
/// ходит в тот же api-v2 с client_id, зашитым в свой бандл. Достаём его оттуда
/// и кэшируем: ключ меняется раз в несколько недель.
pub struct SoundCloudProvider {
    http: reqwest::Client,
    client_id: RwLock<Option<String>>,
}

impl SoundCloudProvider {
    pub fn new(http: reqwest::Client) -> Self {
        Self {
            http,
            client_id: RwLock::new(None),
        }
    }

    async fn client_id(&self) -> Result<String> {
        if let Some(id) = self.client_id.read().await.clone() {
            return Ok(id);
        }

        let mut guard = self.client_id.write().await;
        if let Some(id) = guard.clone() {
            return Ok(id);
        }

        let id = self.scrape_client_id().await?;
        *guard = Some(id.clone());
        Ok(id)
    }

    /// Сбросить кэш — вызывается при 401, чтобы пережить ротацию ключа без перезапуска.
    async fn invalidate(&self) {
        *self.client_id.write().await = None;
    }

    async fn scrape_client_id(&self) -> Result<String> {
        let html = self
            .http
            .get("https://soundcloud.com/discover")
            .send()
            .await
            .context("soundcloud.com недоступен")?
            .text()
            .await?;

        let script_re = Regex::new(r#"<script[^>]+src="([^"]+\.js)""#).unwrap();
        let id_re = Regex::new(r#"client_id\s*:\s*"([a-zA-Z0-9]{32})""#).unwrap();

        // Ключ почти всегда в последнем бандле, поэтому идём с конца.
        let scripts: Vec<String> = script_re
            .captures_iter(&html)
            .map(|c| c[1].to_string())
            .filter(|u| u.starts_with("http"))
            .collect();

        for url in scripts.iter().rev() {
            let Ok(resp) = self.http.get(url).send().await else {
                continue;
            };
            let Ok(js) = resp.text().await else { continue };
            if let Some(c) = id_re.captures(&js) {
                return Ok(c[1].to_string());
            }
        }

        Err(anyhow!("не нашёл client_id в бандлах веб-плеера"))
    }
}

#[async_trait]
impl Provider for SoundCloudProvider {
    fn id(&self) -> &'static str {
        "soundcloud"
    }

    fn label(&self) -> &'static str {
        "SoundCloud"
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Track>> {
        let cid = self.client_id().await?;
        let url = format!(
            "https://api-v2.soundcloud.com/search/tracks?q={}&client_id={}&limit={}",
            urlencoding::encode(query),
            cid,
            limit
        );

        let resp = self.http.get(&url).send().await?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            self.invalidate().await;
            return Err(anyhow!("client_id протух, повторите поиск"));
        }
        let body: Value = resp.error_for_status()?.json().await?;

        let items = body
            .get("collection")
            .and_then(|c| c.as_array())
            .ok_or_else(|| anyhow!("неожиданный формат ответа"))?;

        Ok(items.iter().filter_map(parse_track).collect())
    }

    async fn resolve(&self, id: &str) -> Result<StreamSource> {
        let cid = self.client_id().await?;

        let meta: Value = self
            .http
            .get(format!(
                "https://api-v2.soundcloud.com/tracks/{id}?client_id={cid}"
            ))
            .header("Origin", "https://soundcloud.com")
            .header("Referer", "https://soundcloud.com/")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        // Без этого токена media-эндпоинт отвечает 404 на любой трек:
        // client_id пускает в каталог, а к дорожке пускает только track_authorization.
        let track_auth = meta
            .get("track_authorization")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .to_string();

        let transcodings = meta
            .pointer("/media/transcodings")
            .and_then(|t| t.as_array())
            .ok_or_else(|| anyhow!("у трека нет доступных дорожек (возможно, только по подписке)"))?;

        // progressive = обычный mp3 по одной ссылке с поддержкой Range.
        // HLS тоже есть, но его пришлось бы склеивать через ffmpeg — берём его
        // только если progressive не предложили.
        let pick = transcodings
            .iter()
            .find(|t| t.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("progressive"))
            .or_else(|| transcodings.first())
            .ok_or_else(|| anyhow!("пустой список дорожек"))?;

        let is_hls =
            pick.pointer("/format/protocol").and_then(|p| p.as_str()) == Some("hls");
        if is_hls {
            return Err(anyhow!(
                "трек отдаётся только по HLS — этот формат пока не поддерживается"
            ));
        }

        let redirect_url = pick
            .get("url")
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow!("у дорожки нет url"))?;

        let hop: Value = self
            .http
            .get(format!(
                "{redirect_url}?client_id={cid}&track_authorization={track_auth}"
            ))
            .header("Origin", "https://soundcloud.com")
            .header("Referer", "https://soundcloud.com/")
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;

        let url = hop.get("url").and_then(|u| u.as_str()).ok_or_else(|| {
            // Пустой ответ здесь означает, что трек недоступен в этом регионе
            // или снят правообладателем — на стороне клиента не лечится.
            anyhow!("SoundCloud не отдал ссылку — трек недоступен")
        })?;

        Ok(StreamSource {
            url: url.to_string(),
            headers: vec![],
            mime: pick
                .pointer("/format/mime_type")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string()),
        })
    }
}

fn parse_track(v: &Value) -> Option<Track> {
    let id = v.get("id")?.as_i64()?.to_string();
    let title = v.get("title")?.as_str()?.to_string();
    let artist = v
        .pointer("/user/username")
        .and_then(|u| u.as_str())
        .unwrap_or("Unknown")
        .to_string();

    // t500x500 даёт обложку нормального размера; по умолчанию отдаётся 100x100.
    let artwork = v
        .get("artwork_url")
        .and_then(|a| a.as_str())
        .map(|s| s.replace("-large.", "-t500x500."))
        .or_else(|| {
            v.pointer("/user/avatar_url")
                .and_then(|a| a.as_str())
                .map(|s| s.to_string())
        });

    Some(Track {
        id,
        provider: "soundcloud".into(),
        title,
        artist,
        album: None,
        duration_ms: v.get("duration").and_then(|d| d.as_u64()),
        artwork,
        web_url: v
            .get("permalink_url")
            .and_then(|u| u.as_str())
            .map(|s| s.to_string()),
    })
}
