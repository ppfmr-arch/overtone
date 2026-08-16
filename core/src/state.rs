use crate::models::Library;
use crate::providers::{local::LocalProvider, Registry};
use anyhow::Result;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

pub struct App {
    pub http: reqwest::Client,
    pub registry: Registry,
    pub local: LocalProvider,
    pub library: RwLock<Library>,
    pub library_path: PathBuf,
}

pub type AppState = Arc<App>;

impl App {
    pub async fn boot() -> Result<AppState> {
        let http = reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            )
            .timeout(std::time::Duration::from_secs(30))
            .build()?;

        let dir = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("Overtone");
        std::fs::create_dir_all(&dir)?;
        let library_path = dir.join("library.json");

        let library: Library = std::fs::read_to_string(&library_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let local = LocalProvider::new();
        // Прогреваем индекс на старте, чтобы локальный поиск работал сразу.
        if !library.local_roots.is_empty() {
            let n = local.rescan(&library.local_roots).await;
            tracing::info!(tracks = n, "локальная фонотека проиндексирована");
        }

        Ok(Arc::new(App {
            registry: Registry::new(http.clone(), local.clone()),
            http,
            local,
            library: RwLock::new(library),
            library_path,
        }))
    }

    pub async fn save_library(&self) -> Result<()> {
        let lib = self.library.read().await;
        let json = serde_json::to_string_pretty(&*lib)?;
        // Пишем через временный файл: обрыв на середине не должен убивать фонотеку.
        let tmp = self.library_path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &self.library_path)?;
        Ok(())
    }
}
