//! VidSync Tauri backend — room sync, multi-file media hub, events to UI.

mod api;
mod net;
mod protocol;
mod server;
mod session;
mod sync;
mod upnp;

use std::path::PathBuf;
use std::sync::Mutex;

use session::{MediaHub, ServeInfo};
use sync::SyncEvent;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

use crate::protocol::ClientMessage;

const DEFAULT_API: &str = "https://api.vidsync.ratt.ing";
const DEFAULT_PORT: u16 = 8765;

struct AppState {
    sync_tx: Mutex<Option<mpsc::UnboundedSender<ClientMessage>>>,
    sync_shutdown: Mutex<Option<mpsc::UnboundedSender<()>>>,
    /// Async mutex — hub methods await while registered.
    hub: tokio::sync::Mutex<Option<MediaHub>>,
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
            // Only permanent disconnect ends the event pump (user leave / room gone).
            // Transient drops emit Reconnecting and the sync task reconnects itself.
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
    let hub = {
        let mut g = state.hub.lock().await;
        g.take()
    };
    if let Some(h) = hub {
        h.stop().await;
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

/// Register local file on the hub and return share URL.
async fn register_file(state: &AppState, path: String) -> Result<ServeInfo, String> {
    let mut hub = state.hub.lock().await;
    if hub.is_none() {
        let started = MediaHub::start(DEFAULT_PORT, true)
            .await
            .map_err(|e| format!("{e:#}"))?;
        *hub = Some(started);
    }
    let path = PathBuf::from(path);
    hub.as_ref()
        .ok_or_else(|| "media hub not ready".to_string())?
        .add_file(path)
        .await
        .map_err(|e| format!("{e:#}"))
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

/// Open a local file: register on hub, add to room queue, switch everyone to it.
#[tauri::command]
async fn stream_start(
    state: State<'_, AppState>,
    path: String,
    #[allow(unused_variables)] port: u16,
    #[allow(unused_variables)] upnp: bool,
) -> Result<ServeInfo, String> {
    if !state.is_host.lock().map(|x| *x).unwrap_or(false) {
        return Err("only host can open videos".into());
    }
    let info = register_file(&state, path).await?;
    let url = info.primary_url().to_string();
    // set_url appends if new and switches current
    send_msg(&state, ClientMessage::SetUrl { url })?;
    session::try_clipboard(info.primary_url());
    Ok(info)
}

/// Register file and append to queue without forcing a switch.
#[tauri::command]
async fn queue_add_file(state: State<'_, AppState>, path: String) -> Result<ServeInfo, String> {
    if !state.is_host.lock().map(|x| *x).unwrap_or(false) {
        return Err("only host can queue videos".into());
    }
    let info = register_file(&state, path).await?;
    let url = info.primary_url().to_string();
    send_msg(
        &state,
        ClientMessage::QueueAdd {
            url,
            play_if_idle: true,
        },
    )?;
    Ok(info)
}

#[tauri::command]
fn queue_play(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    if !state.is_host.lock().map(|x| *x).unwrap_or(false) {
        return Err("only host can change the queue".into());
    }
    send_msg(&state, ClientMessage::QueuePlay { index })
}

#[tauri::command]
fn queue_remove(state: State<'_, AppState>, index: u32) -> Result<(), String> {
    if !state.is_host.lock().map(|x| *x).unwrap_or(false) {
        return Err("only host can change the queue".into());
    }
    send_msg(&state, ClientMessage::QueueRemove { index })
}

#[tauri::command]
fn queue_clear(state: State<'_, AppState>) -> Result<(), String> {
    if !state.is_host.lock().map(|x| *x).unwrap_or(false) {
        return Err("only host can change the queue".into());
    }
    send_msg(&state, ClientMessage::QueueClear {})
}

#[tauri::command]
async fn stream_stop(state: State<'_, AppState>) -> Result<(), String> {
    let hub = {
        let mut g = state.hub.lock().await;
        g.take()
    };
    if let Some(h) = hub {
        h.stop().await;
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
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            sync_tx: Mutex::new(None),
            sync_shutdown: Mutex::new(None),
            hub: tokio::sync::Mutex::new(None),
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
            queue_add_file,
            queue_play,
            queue_remove,
            queue_clear,
            stream_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
