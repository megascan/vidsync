//! Start/stop HTTP (+ UPnP) serve session for CLI and GUI.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::net;
use crate::server;
use crate::upnp;

#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub file: PathBuf,
    pub port: u16,
    pub bind: String,
    pub upnp: bool,
    pub external_port: u16,
    pub lease_secs: u32,
    pub clipboard: bool,
}

#[derive(Clone, Debug)]
pub struct ServeInfo {
    pub lan_url: String,
    pub wan_url: Option<String>,
    pub local_port: u16,
    pub file_name: String,
}

pub struct ServeSession {
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
    pub info: ServeInfo,
}

impl ServeSession {
    pub async fn start(opts: ServeOptions) -> Result<Self> {
        let file = opts
            .file
            .canonicalize()
            .with_context(|| format!("file not found: {}", opts.file.display()))?;
        if !file.is_file() {
            bail!("not a file: {}", file.display());
        }

        let token = server::random_token();
        let file_name = file
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".into());

        let state = Arc::new(server::AppState {
            path: file.clone(),
            token: token.clone(),
            mime: server::guess_mime(&file),
            file_name: file_name.clone(),
        });

        let listener = tokio::net::TcpListener::bind(format!("{}:{}", opts.bind, opts.port))
            .await
            .with_context(|| format!("bind {}:{}", opts.bind, opts.port))?;
        let local_port = listener.local_addr()?.port();
        let lan_ip = net::lan_ipv4().unwrap_or_else(|| std::net::Ipv4Addr::LOCALHOST);

        info!("serving {}", file.display());
        let lan_url = format!("http://{lan_ip}:{local_port}/s/{token}");

        let mut wan_url = None;
        let mut mapping: Option<upnp::Mapping> = None;

        if opts.upnp {
            match upnp::map_tcp(lan_ip, local_port, opts.external_port, opts.lease_secs).await {
                Ok(m) => {
                    let url = format!("http://{}:{}/s/{token}", m.external_ip, m.external_port);
                    info!(
                        "UPnP {} → {}:{}",
                        m.gateway_addr, m.external_port, local_port
                    );
                    wan_url = Some(url);
                    mapping = Some(m);
                }
                Err(e) => {
                    warn!("UPnP failed (LAN still works): {e:#}");
                }
            }
        }

        if opts.clipboard {
            let copy = wan_url.as_ref().unwrap_or(&lan_url);
            try_clipboard(copy);
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let app = server::router(state);

        let task = tokio::spawn(async move {
            let serve = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
                info!("shutting down…");
            });
            if let Err(e) = serve.await {
                warn!("server error: {e}");
            }
            if let Some(m) = mapping {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Err(e) = m.remove().await {
                    warn!("UPnP remove failed: {e:#}");
                } else {
                    info!("UPnP mapping removed");
                }
            }
        });

        Ok(Self {
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
            info: ServeInfo {
                lan_url,
                wan_url,
                local_port,
                file_name,
            },
        })
    }

    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for ServeSession {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        // task may still run briefly; process exit cleans sockets
    }
}

pub fn try_clipboard(url: &str) {
    match arboard::Clipboard::new().and_then(|mut c| c.set_text(url.to_string())) {
        Ok(()) => info!("copied URL to clipboard"),
        Err(e) => warn!("clipboard: {e}"),
    }
}
