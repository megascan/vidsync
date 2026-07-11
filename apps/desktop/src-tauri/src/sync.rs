//! WebSocket sync client → Room DO.
//!
//! Auto-reconnects on drop (DO hibernation / network blips). Stops on
//! user leave (`shutdown`) or server `room_closed`.

use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream};
use tracing::{info, warn};

use crate::protocol::{ClientMessage, ServerMessage};

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncEvent {
    Connected,
    Reconnecting {
        attempt: u32,
        reason: String,
    },
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
    /// App-level RTT sample (ms) + server clock for offset.
    Latency {
        rtt_ms: u32,
        server_time_ms: i64,
    },
    Error {
        code: String,
        message: String,
    },
    RoomClosed {
        reason: String,
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

enum SessionEnd {
    UserShutdown,
    RoomClosed,
    Dropped { reason: String, welcomed: bool },
}

/// One key per desktop process — sent on hello so the room DO can drop ghost
/// sockets from leave/rejoin or auto-reconnect races.
fn client_instance_key() -> String {
    use std::sync::OnceLock;
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| {
        use std::time::{SystemTime, UNIX_EPOCH};
        let t = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let r: u32 = rand::random();
        format!("d{t:x}{r:08x}")
    })
    .clone()
}

pub async fn connect(ws_url: String, nickname: String) -> Result<SyncHandle> {
    let (event_tx, event_rx) = mpsc::unbounded_channel();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<ClientMessage>();
    let (shutdown_tx, shutdown_rx) = mpsc::unbounded_channel::<()>();
    let client_key = client_instance_key();

    let (ws, _) = connect_async(&ws_url)
        .await
        .with_context(|| format!("ws connect {ws_url}"))?;

    tokio::spawn(async move {
        run_reconnect_loop(
            ws_url,
            nickname,
            client_key,
            Some(ws),
            out_rx,
            shutdown_rx,
            event_tx,
        )
        .await;
    });

    Ok(SyncHandle {
        out: out_tx,
        events: event_rx,
        shutdown: Some(shutdown_tx),
    })
}

async fn run_reconnect_loop(
    ws_url: String,
    nickname: String,
    client_key: String,
    mut primed: Option<WsStream>,
    mut out_rx: mpsc::UnboundedReceiver<ClientMessage>,
    mut shutdown_rx: mpsc::UnboundedReceiver<()>,
    event_tx: mpsc::UnboundedSender<SyncEvent>,
) {
    let mut attempt: u32 = 0;

    loop {
        let ws = if let Some(ws) = primed.take() {
            ws
        } else {
            match dial_with_cancel(&ws_url, &mut shutdown_rx).await {
                DialResult::Shutdown => {
                    let _ = event_tx.send(SyncEvent::Disconnected {
                        reason: "closed".into(),
                    });
                    return;
                }
                DialResult::Ok(ws) => ws,
                DialResult::Err(reason) => {
                    attempt = attempt.saturating_add(1);
                    let delay_ms = reconnect_delay_ms(attempt);
                    info!("ws dial failed ({reason}); retry #{attempt} in {delay_ms}ms");
                    let _ = event_tx.send(SyncEvent::Reconnecting {
                        attempt,
                        reason: reason.clone(),
                    });
                    tokio::select! {
                        _ = shutdown_rx.recv() => {
                            let _ = event_tx.send(SyncEvent::Disconnected {
                                reason: "closed".into(),
                            });
                            return;
                        }
                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                    }
                    continue;
                }
            }
        };

        // Drop stale heartbeats/seeks queued while offline so reconnect
        // doesn't flush an outage-length backlog as "now" anchors.
        drain_stale_control_msgs(&mut out_rx);

        match run_session(
            ws,
            &nickname,
            &client_key,
            &mut out_rx,
            &mut shutdown_rx,
            &event_tx,
        )
        .await
        {
            SessionEnd::UserShutdown => {
                let _ = event_tx.send(SyncEvent::Disconnected {
                    reason: "closed".into(),
                });
                return;
            }
            SessionEnd::RoomClosed => {
                let _ = event_tx.send(SyncEvent::Disconnected {
                    reason: "room_closed".into(),
                });
                return;
            }
            SessionEnd::Dropped { reason, welcomed } => {
                // After a healthy session, soft restart backoff (DO blips are brief)
                attempt = if welcomed {
                    1
                } else {
                    attempt.saturating_add(1)
                };
                let delay_ms = reconnect_delay_ms(attempt);
                info!("ws dropped ({reason}); reconnect #{attempt} in {delay_ms}ms");
                let _ = event_tx.send(SyncEvent::Reconnecting {
                    attempt,
                    reason: reason.clone(),
                });
                tokio::select! {
                    _ = shutdown_rx.recv() => {
                        let _ = event_tx.send(SyncEvent::Disconnected {
                            reason: "closed".into(),
                        });
                        return;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                }
            }
        }
    }
}

enum DialResult {
    Ok(WsStream),
    Err(String),
    Shutdown,
}

async fn dial_with_cancel(
    ws_url: &str,
    shutdown_rx: &mut mpsc::UnboundedReceiver<()>,
) -> DialResult {
    tokio::select! {
        _ = shutdown_rx.recv() => DialResult::Shutdown,
        res = connect_async(ws_url) => match res {
            Ok((ws, _)) => DialResult::Ok(ws),
            Err(e) => DialResult::Err(format!("{e}")),
        }
    }
}

fn reconnect_delay_ms(attempt: u32) -> u64 {
    // 200ms, 400, 800, 1.6s, 3.2s → cap 5s
    let exp = 200u64.saturating_mul(1u64 << attempt.min(6));
    exp.min(5_000)
}

/// Drop everything queued while offline (stale heartbeats rewind the room).
fn drain_stale_control_msgs(out_rx: &mut mpsc::UnboundedReceiver<ClientMessage>) {
    while out_rx.try_recv().is_ok() {}
}

async fn run_session(
    ws: WsStream,
    nickname: &str,
    client_key: &str,
    out_rx: &mut mpsc::UnboundedReceiver<ClientMessage>,
    shutdown_rx: &mut mpsc::UnboundedReceiver<()>,
    event_tx: &mpsc::UnboundedSender<SyncEvent>,
) -> SessionEnd {
    info!("ws session start");
    let _ = event_tx.send(SyncEvent::Connected);

    let (mut write, mut read) = ws.split();
    let mut welcomed = false;

    let hello = ClientMessage::Hello {
        nickname: Some(nickname.to_string()),
        client_time_ms: chrono_now(),
        platform: Some(host_platform().into()),
        client_key: Some(client_key.to_string()),
    };
    match serde_json::to_string(&hello) {
        Ok(hello_txt) => {
            if write.send(Message::Text(hello_txt.into())).await.is_err() {
                return SessionEnd::Dropped {
                    reason: "hello send failed".into(),
                    welcomed: false,
                };
            }
        }
        Err(e) => {
            return SessionEnd::Dropped {
                reason: format!("hello serialize: {e}"),
                welcomed: false,
            };
        }
    }

    // Immediate RTT sample (don't wait for first interval)
    {
        let boot = ClientMessage::Ping {
            client_time_ms: chrono_now(),
            rtt_ms: None,
        };
        if let Ok(s) = serde_json::to_string(&boot) {
            let _ = write.send(Message::Text(s.into())).await;
        }
    }

    // App ping for RTT/clock (2s). WebSocket Ping keeps NAT mappings (~15s).
    let mut app_ping_tick = tokio::time::interval(Duration::from_secs(2));
    app_ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    app_ping_tick.tick().await;
    let mut ws_ping_tick = tokio::time::interval(Duration::from_secs(15));
    ws_ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ws_ping_tick.tick().await;
    let mut last_rtt_ms: Option<u32> = None;

    loop {
        tokio::select! {
            _ = shutdown_rx.recv() => {
                let _ = write.close().await;
                return SessionEnd::UserShutdown;
            }
            _ = ws_ping_tick.tick() => {
                if write.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return SessionEnd::Dropped {
                        reason: "ws ping failed".into(),
                        welcomed,
                    };
                }
            }
            _ = app_ping_tick.tick() => {
                let ping = ClientMessage::Ping {
                    client_time_ms: chrono_now(),
                    rtt_ms: last_rtt_ms,
                };
                match serde_json::to_string(&ping) {
                    Ok(s) => {
                        if write.send(Message::Text(s.into())).await.is_err() {
                            return SessionEnd::Dropped {
                                reason: "app ping failed".into(),
                                welcomed,
                            };
                        }
                    }
                    Err(e) => warn!("serialize ping: {e}"),
                }
            }
            msg = out_rx.recv() => {
                match msg {
                    Some(m) => {
                        match serde_json::to_string(&m) {
                            Ok(s) => {
                                if write.send(Message::Text(s.into())).await.is_err() {
                                    return SessionEnd::Dropped {
                                        reason: "send failed".into(),
                                        welcomed,
                                    };
                                }
                            }
                            Err(e) => warn!("serialize client msg: {e}"),
                        }
                    }
                    None => {
                        let _ = write.close().await;
                        return SessionEnd::UserShutdown;
                    }
                }
            }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(t))) => {
                        match serde_json::from_str::<ServerMessage>(&t) {
                            Ok(ServerMessage::RoomClosed { reason, message, .. }) => {
                                let _ = event_tx.send(SyncEvent::RoomClosed {
                                    reason,
                                    message,
                                });
                                let _ = write.close().await;
                                return SessionEnd::RoomClosed;
                            }
                            Ok(ServerMessage::Pong {
                                client_time_ms,
                                server_time_ms,
                            }) => {
                                let now = chrono_now();
                                let rtt = (now - client_time_ms).max(0) as u32;
                                // EMA smooth — ignore absurd spikes
                                let rtt = rtt.min(60_000);
                                last_rtt_ms = Some(match last_rtt_ms {
                                    Some(prev) if prev > 0 => {
                                        ((prev as f64) * 0.65 + (rtt as f64) * 0.35).round() as u32
                                    }
                                    _ => rtt,
                                });
                                if let Some(smooth) = last_rtt_ms {
                                    let _ = event_tx.send(SyncEvent::Latency {
                                        rtt_ms: smooth,
                                        server_time_ms,
                                    });
                                }
                            }
                            Ok(sm) => {
                                if matches!(sm, ServerMessage::Welcome { .. }) {
                                    welcomed = true;
                                }
                                if let Some(ev) = map_server(sm) {
                                    if event_tx.send(ev).is_err() {
                                        return SessionEnd::UserShutdown;
                                    }
                                }
                            }
                            Err(e) => warn!("bad server msg: {e} raw={t}"),
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => {
                        return SessionEnd::Dropped {
                            reason: "socket closed".into(),
                            welcomed,
                        };
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        return SessionEnd::Dropped {
                            reason: format!("{e}"),
                            welcomed,
                        };
                    }
                }
            }
        }
    }
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
        // Handled inline in the read loop (updates last_rtt)
        ServerMessage::Pong { .. } => return None,
        ServerMessage::Error { code, message } => SyncEvent::Error { code, message },
        ServerMessage::RoomClosed { reason, message, .. } => SyncEvent::RoomClosed {
            reason,
            message,
        },
    })
}

fn chrono_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn host_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

pub async fn join_room(api_base: &str, code: &str, nickname: String) -> Result<SyncHandle> {
    let code = code.trim().to_uppercase();
    if code.len() != 8 {
        return Err(anyhow!("room code must be 8 characters"));
    }
    let ws = crate::api::ws_url_for_code(api_base, &code);
    connect(ws, nickname).await
}

pub async fn create_and_join(api_base: &str, nickname: String) -> Result<(String, SyncHandle)> {
    let created = crate::api::create_room(api_base).await?;
    let handle = connect(created.ws_url, nickname).await?;
    Ok((created.code, handle))
}
