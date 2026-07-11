//! VidSync Host — stream a local file over HTTP with optional UPnP port map.
//! Also helps install the VidSync Unblock Chromium extension.

mod ext;
mod net;
mod server;
mod upnp;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use tracing::{info, warn};

#[derive(Parser, Debug)]
#[command(
    name = "vidsync-host",
    version,
    about = "Stream a local video for VidSync (HTTP + UPnP) and install Unblock extension"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Serve a file over HTTP (Range-capable). Optional UPnP temp port-forward.
    Serve {
        /// Path to the video (or any) file to stream
        file: PathBuf,

        /// Local listen port (0 = OS picks)
        #[arg(short, long, default_value_t = 8765)]
        port: u16,

        /// Bind address (default 0.0.0.0 — all interfaces)
        #[arg(long, default_value = "0.0.0.0")]
        bind: String,

        /// Skip UPnP gateway port mapping
        #[arg(long)]
        no_upnp: bool,

        /// Prefer this external port for UPnP (0 = same as local / any)
        #[arg(long, default_value_t = 0)]
        external_port: u16,

        /// UPnP lease seconds (0 = infinite until process exit cleanup)
        #[arg(long, default_value_t = 0)]
        lease_secs: u32,

        /// Also run extension install helper before serving
        #[arg(long)]
        install_ext: bool,

        /// Do not copy share URL to clipboard
        #[arg(long)]
        no_clipboard: bool,
    },

    /// Copy Unblock extension into a stable folder and open browser install UI
    InstallExt {
        /// Source extension dir (default: auto-detect monorepo / next to binary)
        #[arg(long)]
        from: Option<PathBuf>,

        /// Only stage files + print steps; do not launch browser
        #[arg(long)]
        no_launch: bool,

        /// Prefer Edge instead of Chrome
        #[arg(long)]
        edge: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        Commands::Serve {
            file,
            port,
            bind,
            no_upnp,
            external_port,
            lease_secs,
            install_ext,
            no_clipboard,
        } => {
            if install_ext {
                match ext::install(None, true, false) {
                    Ok(msg) => info!("{msg}"),
                    Err(e) => warn!("extension install helper failed: {e:#}"),
                }
            }
            run_serve(
                file,
                port,
                bind,
                no_upnp,
                external_port,
                lease_secs,
                !no_clipboard,
            )
            .await
        }
        Commands::InstallExt {
            from,
            no_launch,
            edge,
        } => {
            let msg = ext::install(from, !no_launch, edge)?;
            println!("{msg}");
            Ok(())
        }
    }
}

async fn run_serve(
    file: PathBuf,
    port: u16,
    bind: String,
    no_upnp: bool,
    external_port: u16,
    lease_secs: u32,
    clipboard: bool,
) -> Result<()> {
    let file = file
        .canonicalize()
        .with_context(|| format!("file not found: {}", file.display()))?;
    if !file.is_file() {
        bail!("not a file: {}", file.display());
    }

    let token = server::random_token();
    let state = Arc::new(server::AppState {
        path: file.clone(),
        token: token.clone(),
        mime: server::guess_mime(&file),
        file_name: file
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "video".into()),
    });

    let listener = tokio::net::TcpListener::bind(format!("{bind}:{port}"))
        .await
        .with_context(|| format!("bind {bind}:{port}"))?;
    let local_port = listener.local_addr()?.port();
    let lan_ip = net::lan_ipv4().unwrap_or_else(|| std::net::Ipv4Addr::LOCALHOST);

    info!("serving {}", file.display());
    info!("token path /s/{token}");

    let lan_url = format!("http://{lan_ip}:{local_port}/s/{token}");
    println!();
    println!("  LAN URL (same network):");
    println!("    {lan_url}");
    println!();

    // UPnP mapping — cleaned on Ctrl+C / process exit
    let mut mapping: Option<upnp::Mapping> = None;
    if !no_upnp {
        match upnp::map_tcp(lan_ip, local_port, external_port, lease_secs).await {
            Ok(m) => {
                let wan_url = format!("http://{}:{}/s/{token}", m.external_ip, m.external_port);
                println!("  WAN URL (UPnP mapped — friends offline LAN):");
                println!("    {wan_url}");
                println!();
                println!(
                    "  Gateway {} → {}:{} (lease {}s, removed on exit)",
                    m.gateway_addr,
                    m.external_port,
                    local_port,
                    if lease_secs == 0 {
                        "until exit".to_string()
                    } else {
                        lease_secs.to_string()
                    }
                );
                println!();
                if clipboard {
                    try_clipboard(&wan_url);
                }
                mapping = Some(m);
            }
            Err(e) => {
                warn!("UPnP failed (LAN still works): {e:#}");
                println!("  UPnP: unavailable — share the LAN URL only, or open port manually.");
                println!();
                if clipboard {
                    try_clipboard(&lan_url);
                }
            }
        }
    } else if clipboard {
        try_clipboard(&lan_url);
    }

    println!("  Paste URL into VidSync host queue, then Stream with Unblock.");
    println!("  Press Ctrl+C to stop and remove UPnP mapping.");
    println!();

    let app = server::router(state);

    let serve = axum::serve(listener, app).with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        info!("shutting down…");
    });

    let result = serve.await;
    if let Some(m) = mapping {
        // small grace so in-flight requests finish
        tokio::time::sleep(Duration::from_millis(50)).await;
        if let Err(e) = m.remove().await {
            warn!("UPnP remove failed: {e:#}");
        } else {
            info!("UPnP mapping removed");
        }
    }
    result.context("server error")
}

fn try_clipboard(url: &str) {
    match arboard::Clipboard::new().and_then(|mut c| c.set_text(url.to_string())) {
        Ok(()) => println!("  (URL copied to clipboard)"),
        Err(e) => warn!("clipboard: {e}"),
    }
}
