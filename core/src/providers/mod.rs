pub mod local;
pub mod soundcloud;
pub mod ytmusic;

use crate::models::{StreamSource, Track};
use anyhow::Result;
use async_trait::async_trait;

/// Всё, что нужно, чтобы подключить новый источник музыки.
/// Добавить Bandcamp/Deezer/Jamendo = реализовать этот трейт и одна строка в `Registry::new`.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Стабильный машинный id: попадает в `Track.provider` и в URL прокси.
    fn id(&self) -> &'static str;
    /// Название для UI.
    fn label(&self) -> &'static str;

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Track>>;

    /// Превратить нативный id трека в скачиваемую ссылку.
    /// Ссылки часто живут минуты и привязаны к IP — резолвим на каждое воспроизведение.
    async fn resolve(&self, id: &str) -> Result<StreamSource>;
}

pub struct Registry {
    providers: Vec<Box<dyn Provider>>,
}

impl Registry {
    pub fn new(http: reqwest::Client, local: local::LocalProvider) -> Self {
        Self {
            providers: vec![
                Box::new(ytmusic::YtMusicProvider::new(http.clone())),
                Box::new(soundcloud::SoundCloudProvider::new(http.clone())),
                Box::new(local),
            ],
        }
    }

    pub fn get(&self, id: &str) -> Option<&dyn Provider> {
        self.providers
            .iter()
            .find(|p| p.id() == id)
            .map(|p| p.as_ref())
    }

    pub fn all(&self) -> impl Iterator<Item = &dyn Provider> {
        self.providers.iter().map(|p| p.as_ref())
    }
}

// ---------------------------------------------------------------------------
// Общие хелперы парсинга, нужные нескольким провайдерам.
// ---------------------------------------------------------------------------

/// "3:45" / "1:02:03" -> миллисекунды. Всё, что не распарсилось, -> None.
pub fn parse_clock(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut secs: u64 = 0;
    for p in &parts {
        let n: u64 = p.trim().parse().ok()?;
        secs = secs * 60 + n;
    }
    Some(secs * 1000)
}

/// Рекурсивно собирает все значения по ключу `key` в дереве JSON.
/// Innertube меняет обёртки от релиза к релизу, но имена рендереров живут годами,
/// поэтому обход по имени переживает редизайны лучше, чем путь по индексам.
pub fn collect_by_key<'a>(v: &'a serde_json::Value, key: &str, out: &mut Vec<&'a serde_json::Value>) {
    match v {
        serde_json::Value::Object(map) => {
            for (k, val) in map {
                if k == key {
                    out.push(val);
                }
                collect_by_key(val, key, out);
            }
        }
        serde_json::Value::Array(arr) => {
            for val in arr {
                collect_by_key(val, key, out);
            }
        }
        _ => {}
    }
}

/// Первое строковое значение по ключу в поддереве — для `text`, `videoId` и т.п.
pub fn first_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    let mut out = Vec::new();
    collect_by_key(v, key, &mut out);
    out.into_iter().find_map(|x| x.as_str())
}
