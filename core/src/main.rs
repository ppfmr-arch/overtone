mod api;
mod models;
mod providers;
mod state;
mod stream;

use anyhow::Result;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MP_LOG")
                .unwrap_or_else(|_| "mp_core=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let app = state::App::boot().await?;

    // Порт 0 = пусть ОС выдаст свободный. Electron узнает его из строки
    // MPCORE_READY в stdout, поэтому никаких конфликтов с чужими сервисами.
    let port: u16 = std::env::var("MP_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let bound = listener.local_addr()?.port();

    // Ключ живёт ровно одну сессию и никуда не записывается: его знает только тот,
    // кто прочитал stdout ядра, то есть запустивший его Electron.
    let token: String = {
        use rand::Rng;
        let bytes: [u8; 16] = rand::thread_rng().gen();
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    };

    let router = api::router(app)
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(token.clone()),
            api::require_token,
        ))
        .layer(CorsLayer::permissive());

    // Единственный контракт с Electron. Печатаем и сбрасываем буфер сразу.
    println!("MPCORE_READY {bound} {token}");
    use std::io::Write;
    std::io::stdout().flush()?;
    tracing::info!("ядро слушает 127.0.0.1:{bound}");

    axum::serve(listener, router).await?;
    Ok(())
}
