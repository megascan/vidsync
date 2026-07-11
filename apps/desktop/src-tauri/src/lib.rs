//! VidSync Tauri backend — room sync, local stream, events to UI.

mod api;
mod net;
mod protocol;
mod server;
mod session;
mod sync;
mod upnp;

use std::path::PathBuf;
use std::sync::Mutex;

use session::{ServeInfo, ServeOptions, ServeSession};
use sync::SyncEvent;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::protocol::ClientMessage;

const DEFAULT_API: &str = "https://api.vidsync.ratt.ing";

struct AppState {
    /// Outbound WS messages
    sync_tx: Mutex<Option<mpsc::UnboundedSender<ClientMessage>>>,
    sync_shutdown: Mutex<Option<mpsc::UnboundedSender<()>>>,
    serve: Mutex<Option<ServeSession>>,
    is_host: Mutex<bool>,
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn install_sync(app: &AppHandle, state: &AppState, handle: sync::SyncHandle) -> Result<(), String> {
    let sync::SyncHandle {
        out,
        mut events,
        shutdown,
    } = handle;

    *state.sync_tx.lock().map_err(err)? = Some(out);
    *state.sync_shutdown.lock().map_err(err)? = shutdown;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(ev) = events.recv().await {
            if let SyncEvent::Welcome { is_host, .. } = &ev {
                if let Some(st) = app.try_state::<AppState>() {
                    if let Ok(mut h) = st.is_host.lock() {
                        *h = *is_host;
                    }
                }
            }
            let done = matches!(ev, SyncEvent::Disconnected { .. });
            let _ = app.emit("sync-event", &ev);
            if done {
                break;
            }
        }
    });
    Ok(())
}

async fn leave_internal(state: &AppState) {
    if let Ok(mut g) = state.sync_shutdown.lock() {
        if let Some(tx) = g.take() {
            let _ = tx.send(());
        }
    }
    if let Ok(mut g) = state.sync_tx.lock() {
        *g = None;
    }
    let prev_serve = state.serve.lock().ok().and_then(|mut g| g.take());
    if let Some(s) = prev_serve {
        s.stop().await;
    }
    if let Ok(mut h) = state.is_host.lock() {
        *h = false;
    }
}

fn send_msg(state: &AppState, msg: ClientMessage) -> Result<(), String> {
    let g = state.sync_tx.lock().map_err(err)?;
    let tx = g.as_ref().ok_or_else(|| "not connected".to_string())?;
    tx.send(msg).map_err(|_| "sync channel closed".to_string())
}

#[tauri::command]
fn default_api() -> String {
    DEFAULT_API.into()
}

#[tauri::command]
async fn room_create(
    app: AppHandle,
    state: State<'_, AppState>,
    nickname: String,
    api_base: String,
) -> Result<String, String> {
    leave_internal(&state).await;
    let api = if api_base.trim().is_empty() {
        DEFAULT_API.into()
    } else {
        api_base
    };
    let (code, handle) = sync::create_and_join(&api, nickname)
        .await
        .map_err(|e| format!("{e:#}"))?;
    install_sync(&app, &state, handle)?;
    Ok(code)
}

#[tauri::command]
async fn room_join(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
    nickname: String,
    api_base: String,
) -> Result<(), String> {
    leave_internal(&state).await;
    let api = if api_base.trim().is_empty() {
        DEFAULT_API.into()
    } else {
        api_base
    };
    let handle = sync::join_room(&api, &code, nickname)
        .await
        .map_err(|e| format!("{e:#}"))?;
    install_sync(&app, &state, handle)?;
    Ok(())
}

#[tauri::command]
async fn room_leave(state: State<'_, AppState>) -> Result<(), String> {
    leave_internal(&state).await;
    Ok(())
}

#[tauri::command]
fn room_chat(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let t = text.trim().to_string();
    if t.is_empty() {
        return Ok(());
    }
    send_msg(&state, ClientMessage::Chat { text: t })
}

#[tauri::command]
fn host_play(state: State<'_, AppState>, position_ms: f64) -> Result<(), String> {
    send_msg(&state, ClientMessage::Play { position_ms })
}

#[tauri::command]
fn host_pause(state: State<'_, AppState>, position_ms: f64) -> Result<(), String> {
    send_msg(&state, ClientMessage::Pause { position_ms })
}

#[tauri::command]
fn host_seek(state: State<'_, AppState>, position_ms: f64, is_playing: bool) -> Result<(), String> {
    send_msg(
        &state,
        ClientMessage::Seek {
            position_ms,
            is_playing,
        },
    )
}

#[tauri::command]
fn host_heartbeat(
    state: State<'_, AppState>,
    position_ms: f64,
    is_playing: bool,
) -> Result<(), String> {
    send_msg(
        &state,
        ClientMessage::Heartbeat {
            position_ms,
            is_playing,
        },
    )
}

#[tauri::command]
async fn stream_start(
    state: State<'_, AppState>,
    path: String,
    port: u16,
    upnp: bool,
) -> Result<ServeInfo, String> {
    let prev = state.serve.lock().ok().and_then(|mut g| g.take());
    if let Some(s) = prev {
        s.stop().await;
    }

    let session = ServeSession::start(ServeOptions {
        file: PathBuf::from(path),
        port,
        bind: "0.0.0.0".into(),
        upnp,
        external_port: 0,
        lease_secs: 0,
        clipboard: true,
    })
    .await
    .map_err(|e| format!("{e:#}"))?;

    let info = session.info.clone();
    let url = info.primary_url().to_string();

    if state.is_host.lock().map(|x| *x).unwrap_or(false) {
        let _ = send_msg(
            &state,
            ClientMessage::QueueAdd {
                url,
                play_if_idle: true,
            },
        );
    }

    *state.serve.lock().map_err(err)? = Some(session);
    Ok(info)
}

#[tauri::command]
async fn stream_stop(state: State<'_, AppState>) -> Result<(), String> {
    let prev = state.serve.lock().ok().and_then(|mut g| g.take());
    if let Some(s) = prev {
        s.stop().await;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            sync_tx: Mutex::new(None),
            sync_shutdown: Mutex::new(None),
            serve: Mutex::new(None),
            is_host: Mutex::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            default_api,
            room_create,
            room_join,
            room_leave,
            room_chat,
            host_play,
            host_pause,
            host_seek,
            host_heartbeat,
            stream_start,
            stream_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
