//! WebSocket sync client → Room DO.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::protocol::{ClientMessage, ServerMessage};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncEvent {
    Connected,
    Disconnected {
        reason: String,
    },
    Welcome {
        session_id: String,
        is_host: bool,
        state: crate::protocol::PlaybackState,
        members: Vec<crate::protocol::Member>,
        server_time_ms: i64,
    },
    State {
        state: crate::protocol::PlaybackState,
        server_time_ms: i64,
    },
    Members {
        members: Vec<crate::protocol::Member>,
    },
    Chat {
        message: crate::protocol::ChatMessage,
    },
    Error {
        code: String,
        message: String,
    },
}

pub struct SyncHandle {
    pub out: mpsc::UnboundedSender<ClientMessage>,
    pub events: mpsc::UnboundedReceiver<SyncEvent>,
    pub shutdown: Option<mpsc::UnboundedSender<()>>,
}

impl SyncHandle {
    pub fn send(&self, msg: ClientMessage) {
        let _ = self.out.send(msg);
    }

    pub fn disconnect(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Connect and run until disconnect. Nickname sent on hello.
pub async fn connect(ws_url: String, nickname: String) -> Result<SyncHandle> {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ClientMessage>();
    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();

    let (ws, _) = connect_async(&ws_url)
        .await
        .with_context(|| format!("ws connect {ws_url}"))?;
    info!("ws connected {ws_url}");
    let _ = event_tx.send(SyncEvent::Connected);

    let (mut write, mut read) = ws.split();

    let hello = ClientMessage::Hello {
        nickname: Some(nickname),
        client_time_ms: chrono_now(),
    };
    let hello_txt = serde_json::to_string(&hello)?;
    write
        .send(Message::Text(hello_txt.into()))
        .await
        .context("send hello")?;

    let event_tx2 = event_tx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => {
                    let _ = write.close().await;
                    let _ = event_tx2.send(SyncEvent::Disconnected {
                        reason: "closed".into(),
                    });
                    break;
                }
                msg = out_rx.recv() => {
                    match msg {
                        Some(m) => {
                            match serde_json::to_string(&m) {
                                Ok(s) => {
                                    if write.send(Message::Text(s.into())).await.is_err() {
                                        let _ = event_tx2.send(SyncEvent::Disconnected {
                                            reason: "send failed".into(),
                                        });
                                        break;
                                    }
                                }
                                Err(e) => warn!("serialize client msg: {e}"),
                            }
                        }
                        None => break,
                    }
                }
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(Message::Text(t))) => {
                            match serde_json::from_str::<ServerMessage>(&t) {
                                Ok(sm) => {
                                    if let Some(ev) = map_server(sm) {
                                        if event_tx2.send(ev).is_err() {
                                            break;
                                        }
                                    }
                                }
                                Err(e) => warn!("bad server msg: {e} raw={t}"),
                            }
                        }
                        Some(Ok(Message::Ping(p))) => {
                            let _ = write.send(Message::Pong(p)).await;
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            let _ = event_tx2.send(SyncEvent::Disconnected {
                                reason: "socket closed".into(),
                            });
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => {
                            let _ = event_tx2.send(SyncEvent::Disconnected {
                                reason: format!("{e}"),
                            });
                            break;
                        }
                    }
                }
            }
        }
    });

    // Keepalive ping task not strictly needed — DO may use autoResponse
    let _ = Duration::from_secs(1);

    Ok(SyncHandle {
        out: out_tx,
        events: event_rx,
        shutdown: Some(shutdown_tx),
    })
}

fn map_server(sm: ServerMessage) -> Option<SyncEvent> {
    Some(match sm {
        ServerMessage::Welcome {
            session_id,
            is_host,
            state,
            members,
            server_time_ms,
        } => SyncEvent::Welcome {
            session_id,
            is_host,
            state,
            members,
            server_time_ms,
        },
        ServerMessage::State {
            state,
            server_time_ms,
        } => SyncEvent::State {
            state,
            server_time_ms,
        },
        ServerMessage::Members { members, .. } => SyncEvent::Members { members },
        ServerMessage::Chat { message } => SyncEvent::Chat { message },
        ServerMessage::Error { code, message } => SyncEvent::Error { code, message },
    })
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Join existing room code.
pub async fn join_room(api_base: &str, code: &str, nickname: String) -> Result<SyncHandle> {
    let code = code.trim().to_uppercase();
    if code.len() != 8 {
        return Err(anyhow!("room code must be 8 characters"));
    }
    let ws = crate::api::ws_url_for_code(api_base, &code);
    connect(ws, nickname).await
}

/// Create room then connect.
pub async fn create_and_join(api_base: &str, nickname: String) -> Result<(String, SyncHandle)> {
    let created = crate::api::create_room(api_base).await?;
    let handle = connect(created.ws_url, nickname).await?;
    Ok((created.code, handle))
}
