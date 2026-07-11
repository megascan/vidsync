//! VidSync desktop — lobby, DO sync, local stream, native WebView player.
//! Also keeps headless `serve` for scripting.

mod api;
mod ext;
mod gui;
mod net;
mod player;
mod protocol;
mod server;
mod session;
mod sync;
mod upnp;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use session::{ServeOptions, ServeSession};

#[derive(Parser, Debug)]
#[command(
    name = "vidsync",
    version,
    about = "VidSync desktop watch party (lobby + stream + native player). GUI by default."
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Commands>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Open the desktop app (default)
    Gui,
    /// Headless: serve a file over HTTP (+ optional UPnP)
    Serve {
        file: PathBuf,
        #[arg(short, long, default_value_t = 8765)]
        port: u16,
        #[arg(long, default_value = "0.0.0.0")]
        bind: String,
        #[arg(long)]
        no_upnp: bool,
        #[arg(long, default_value_t = 0)]
        external_port: u16,
        #[arg(long, default_value_t = 0)]
        lease_secs: u32,
        #[arg(long)]
        no_clipboard: bool,
    },
    /// Stage Unblock extension (legacy web path)
    InstallExt {
        #[arg(long)]
        from: Option<PathBuf>,
        #[arg(long)]
        no_launch: bool,
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
            gui::run().map_err(|e| anyhow::anyhow!("GUI: {e}"))?;
            Ok(())
        }
        Some(Commands::Serve {
            file,
            port,
            bind,
            no_upnp,
            external_port,
            lease_secs,
            no_clipboard,
        }) => {
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(async {
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
                if let Some(u) = &session.info.public_url {
                    println!("  Public URL: {u}");
                }
                println!("  LAN URL: {}", session.info.lan_url);
                println!("  Ctrl+C to stop.");
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
