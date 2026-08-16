use super::Provider;
use crate::models::{StreamSource, Track};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use lofty::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use walkdir::WalkDir;

const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "wma", "aiff", "alac",
];

#[derive(Default)]
struct Index {
    tracks: Vec<Track>,
    paths: HashMap<String, PathBuf>,
}

/// Локальная фонотека. Индекс живёт в памяти и перестраивается по команде из UI —
/// файловый watcher тут был бы избыточен: коллекция меняется редко.
#[derive(Clone)]
pub struct LocalProvider {
    index: Arc<RwLock<Index>>,
}

impl Default for LocalProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalProvider {
    pub fn new() -> Self {
        Self {
            index: Arc::new(RwLock::new(Index::default())),
        }
    }

    /// Пересобрать индекс по списку корневых папок. Возвращает число найденных треков.
    pub async fn rescan(&self, roots: &[String]) -> usize {
        let roots: Vec<PathBuf> = roots.iter().map(PathBuf::from).collect();

        // Обход диска и чтение тегов блокирующие — уводим с рантайма tokio.
        let index = tokio::task::spawn_blocking(move || {
            let mut idx = Index::default();
            for root in &roots {
                for entry in WalkDir::new(root)
                    .follow_links(false)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let path = entry.path();
                    let is_audio = path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_ascii_lowercase())
                        .is_some_and(|e| AUDIO_EXT.contains(&e.as_str()));
                    if !is_audio {
                        continue;
                    }
                    if let Some(track) = read_track(path) {
                        idx.paths.insert(track.id.clone(), path.to_path_buf());
                        idx.tracks.push(track);
                    }
                }
            }
            idx.tracks
                .sort_by(|a, b| (&a.artist, &a.title).cmp(&(&b.artist, &b.title)));
            idx
        })
        .await
        .unwrap_or_default();

        let count = index.tracks.len();
        *self.index.write().await = index;
        count
    }

    pub async fn all_tracks(&self) -> Vec<Track> {
        self.index.read().await.tracks.clone()
    }

    pub async fn path_of(&self, id: &str) -> Option<PathBuf> {
        self.index.read().await.paths.get(id).cloned()
    }

    /// Встроенная обложка как (mime, bytes). Отдаётся отдельным эндпоинтом,
    /// чтобы не раздувать JSON выдачи base64-картинками.
    pub async fn artwork(&self, id: &str) -> Option<(String, Vec<u8>)> {
        let path = self.path_of(id).await?;
        tokio::task::spawn_blocking(move || {
            let tagged = lofty::read_from_path(&path).ok()?;
            let pic = tagged.primary_tag().or_else(|| tagged.first_tag())?.pictures().first()?.clone();
            let mime = pic
                .mime_type()
                .map(|m| m.to_string())
                .unwrap_or_else(|| "image/jpeg".into());
            Some((mime, pic.data().to_vec()))
        })
        .await
        .ok()
        .flatten()
    }
}

#[async_trait]
impl Provider for LocalProvider {
    fn id(&self) -> &'static str {
        "local"
    }

    fn label(&self) -> &'static str {
        "Локальные файлы"
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Track>> {
        let q = query.to_lowercase();
        let idx = self.index.read().await;
        Ok(idx
            .tracks
            .iter()
            .filter(|t| {
                t.title.to_lowercase().contains(&q)
                    || t.artist.to_lowercase().contains(&q)
                    || t.album.as_deref().is_some_and(|a| a.to_lowercase().contains(&q))
            })
            .take(limit)
            .cloned()
            .collect())
    }

    async fn resolve(&self, id: &str) -> Result<StreamSource> {
        let path = self
            .path_of(id)
            .await
            .ok_or_else(|| anyhow!("файл не найден в индексе — пересканируйте папки"))?;
        Ok(StreamSource {
            // Локальные файлы прокси отдаёт напрямую с диска, различая схему по префиксу.
            url: format!("file://{}", path.to_string_lossy()),
            headers: vec![],
            mime: None,
        })
    }
}

fn read_track(path: &Path) -> Option<Track> {
    let id = hex_id(path);
    let stem = path.file_stem()?.to_string_lossy().to_string();

    let (title, artist, album, duration_ms) = match lofty::read_from_path(path) {
        Ok(tagged) => {
            let props_ms = tagged.properties().duration().as_millis() as u64;
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
            match tag {
                Some(t) => (
                    t.title().map(|s| s.to_string()).unwrap_or_else(|| stem.clone()),
                    t.artist().map(|s| s.to_string()).unwrap_or_else(|| "Unknown".into()),
                    t.album().map(|s| s.to_string()),
                    Some(props_ms),
                ),
                None => (stem.clone(), "Unknown".into(), None, Some(props_ms)),
            }
        }
        // Битые теги — не повод прятать файл: играть его всё равно можно.
        Err(_) => (stem.clone(), "Unknown".into(), None, None),
    };

    Some(Track {
        artwork: Some(format!("/api/local/art/{id}")),
        web_url: None,
        id,
        provider: "local".into(),
        title,
        artist,
        album,
        duration_ms,
    })
}

/// Путь -> hex. Обратимо и стабильно между запусками, в отличие от индекса в массиве.
fn hex_id(path: &Path) -> String {
    path.to_string_lossy()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
