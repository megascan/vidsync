//! Persistent multi-file media hub (one port/UPnP for the room).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use tokio::sync::oneshot;
use tracing::{info, warn};

use crate::net;
use crate::server::{self, FileEntry, FileRegistry};
use crate::upnp;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServeInfo {
    pub lan_url: String,
    pub public_url: Option<String>,
    pub upnp_mapped: bool,
    pub public_ip: Option<String>,
    pub local_port: u16,
    pub file_name: String,
    pub token: String,
}

impl ServeInfo {
    pub fn primary_url(&self) -> &str {
        self.public_url.as_deref().unwrap_or(self.lan_url.as_str())
    }
}

/// One HTTP server for many files. Survives opening additional videos.
pub struct MediaHub {
    registry: FileRegistry,
    lan_base: String,
    public_base: Option<String>,
    pub local_port: u16,
    pub upnp_mapped: bool,
    public_ip: Option<String>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    task: Option<tokio::task::JoinHandle<()>>,
}

impl MediaHub {
    pub async fn start(port: u16, upnp: bool) -> Result<Self> {
        let registry: FileRegistry = Arc::new(tokio::sync::RwLock::new(Default::default()));

        let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
            .await
            .with_context(|| format!("bind 0.0.0.0:{port}"))?;
        let local_port = listener.local_addr()?.port();
        let lan_ip = net::lan_ipv4().unwrap_or(std::net::Ipv4Addr::LOCALHOST);
        let lan_base = format!("http://{lan_ip}:{local_port}");

        let mut mapping: Option<upnp::Mapping> = None;
        let mut upnp_mapped = false;
        let mut external_port = local_port;
        let mut public_ip_from_upnp = None;

        if upnp {
            match upnp::map_tcp(lan_ip, local_port, 0, 0).await {
                Ok(m) => {
                    info!(
                        "UPnP {} → {}:{}",
                        m.gateway_addr, m.external_port, local_port
                    );
                    external_port = m.external_port;
                    public_ip_from_upnp = Some(m.external_ip);
                    upnp_mapped = true;
                    mapping = Some(m);
                }
                Err(e) => warn!("UPnP failed: {e:#}"),
            }
        }

        let public_ip = if let Some(ip) = public_ip_from_upnp {
            if net::is_globally_routable_v4(ip) {
                Some(ip)
            } else {
                net::public_ipv4().await
            }
        } else {
            net::public_ipv4().await
        };

        let public_base =
            public_ip.map(|ip| format!("http://{ip}:{external_port}"));
        let public_ip_str = public_ip.map(|ip| ip.to_string());

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let app = server::router(Arc::clone(&registry));

        let task = tokio::spawn(async move {
            let serve = axum::serve(listener, app).with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
                info!("media hub shutting down");
            });
            if let Err(e) = serve.await {
                warn!("server error: {e}");
            }
            if let Some(m) = mapping {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Err(e) = m.remove().await {
                    warn!("UPnP remove failed: {e:#}");
                }
            }
        });

        info!("media hub on {lan_base}");

        Ok(Self {
            registry,
            lan_base,
            public_base,
            local_port,
            upnp_mapped,
            public_ip: public_ip_str,
            shutdown_tx: Some(shutdown_tx),
            task: Some(task),
        })
    }

    /// Register a file; returns shareable URL. Does not rebind the port.
    pub async fn add_file(&self, path: PathBuf) -> Result<ServeInfo> {
        let file = path
            .canonicalize()
            .with_context(|| format!("file not found: {}", path.display()))?;
        if !file.is_file() {
            bail!("not a file: {}", file.display());
        }

        let token = server::random_token();
        let file_name = file
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".into());
        let mime = server::guess_mime(&file);

        self.registry.write().await.insert(
            token.clone(),
            FileEntry {
                path: file,
                mime,
                file_name: file_name.clone(),
            },
        );

        let lan_url = format!("{}/s/{token}", self.lan_base);
        let public_url = self
            .public_base
            .as_ref()
            .map(|b| format!("{b}/s/{token}"));

        info!("added file {file_name} → {lan_url}");

        Ok(ServeInfo {
            lan_url,
            public_url,
            upnp_mapped: self.upnp_mapped,
            public_ip: self.public_ip.clone(),
            local_port: self.local_port,
            file_name,
            token,
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

impl Drop for MediaHub {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

// Keep name for older call sites / clipboard helper
pub fn try_clipboard(url: &str) {
    match arboard::Clipboard::new().and_then(|mut c| c.set_text(url.to_string())) {
        Ok(()) => info!("copied URL to clipboard"),
        Err(e) => warn!("clipboard: {e}"),
    }
}
