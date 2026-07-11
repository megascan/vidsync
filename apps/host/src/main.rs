//! VidSync Host — stream a local file over HTTP with optional UPnP port map.
//! GUI by default; CLI subcommands for scripting.

mod ext;
mod gui;
mod net;
mod server;
mod session;
mod upnp;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing::{info, warn};

use session::{ServeOptions, ServeSession};

#[derive(Parser, Debug)]
#[command(
    name = "vidsync-host",
    version,
    about = "Stream a local video for VidSync (HTTP + UPnP). Opens GUI when run with no args."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Open the file-picker GUI (default when no command is given)
    Gui,

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

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    match cli.cmd {
        None | Some(Commands::Gui) => {
            gui::run().map_err(|e| anyhow::anyhow!("GUI error: {e}"))?;
            Ok(())
        }
        Some(Commands::Serve {
            file,
            port,
            bind,
            no_upnp,
            external_port,
            lease_secs,
            install_ext,
            no_clipboard,
        }) => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
                if install_ext {
                    match ext::install(None, true, false) {
                        Ok(msg) => info!("{msg}"),
                        Err(e) => warn!("extension install helper failed: {e:#}"),
                    }
                }
                let session = ServeSession::start(ServeOptions {
                    file,
                    port,
                    bind,
                    upnp: !no_upnp,
                    external_port,
                    lease_secs,
                    clipboard: !no_clipboard,
                })
                .await?;

                println!();
                if let Some(ip) = &session.info.public_ip {
                    println!("  Public IP: {ip}");
                }
                if let Some(pub_url) = &session.info.public_url {
                    if session.info.upnp_mapped {
                        println!("  Public URL (UPnP open):");
                    } else {
                        println!("  Public URL (open TCP {} on router if remote friends):", session.info.local_port);
                    }
                    println!("    {pub_url}");
                    println!();
                } else {
                    println!("  Public IP: unknown (offline / blocked HTTPS probe)");
                    println!();
                }
                println!("  LAN URL (same network):");
                println!("    {}", session.info.lan_url);
                println!();
                if !session.info.upnp_mapped && !no_upnp {
                    println!("  UPnP: unavailable — public URL still shown for manual port-forward.");
                    println!();
                }
                println!("  Clipboard has: {}", session.info.primary_url());
                println!("  Paste into VidSync queue → Stream with Unblock.");
                println!("  Press Ctrl+C to stop.");
                println!();

                let _ = tokio::signal::ctrl_c().await;
                session.stop().await;
                Ok(())
            })
        }
        Some(Commands::InstallExt {
            from,
            no_launch,
            edge,
        }) => {
            let msg = ext::install(from, !no_launch, edge)?;
            println!("{msg}");
            Ok(())
        }
    }
}
