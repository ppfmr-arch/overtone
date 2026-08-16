use serde::{Deserialize, Serialize};

/// Единица воспроизведения. Одинакова для всех провайдеров — UI не знает,
/// откуда трек, кроме поля `provider` (нужно для бейджа и для резолва стрима).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Track {
    /// Нативный id внутри провайдера: videoId у ytmusic, числовой id у soundcloud,
    /// hex-хэш пути у local.
    pub id: String,
    pub provider: String,
    pub title: String,
    pub artist: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artwork: Option<String>,
    /// Ссылка на страницу трека в вебе — для пункта «открыть оригинал».
    #[serde(skip_serializing_if = "Option::is_none")]
    pub web_url: Option<String>,
}

/// Результат резолва: прямая ссылка на аудио + всё, что нужно, чтобы её скачать.
/// Отдаётся не в UI, а внутрь прокси — googlevideo-ссылки требуют своих заголовков.
#[derive(Clone, Debug)]
pub struct StreamSource {
    pub url: String,
    pub headers: Vec<(String, String)>,
    #[allow(dead_code)]
    pub mime: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Library {
    #[serde(default)]
    pub liked: Vec<Track>,
    #[serde(default)]
    pub playlists: Vec<Playlist>,
    /// Папки, которые сканирует локальный провайдер.
    #[serde(default)]
    pub local_roots: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct SearchResponse {
    pub tracks: Vec<Track>,
    /// Провайдеры, которые упали или ничего не вернули — UI показывает это
    /// ненавязчиво, чтобы пустая выдача одного источника не выглядела как баг.
    pub errors: Vec<ProviderError>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ProviderError {
    pub provider: String,
    pub message: String,
}
