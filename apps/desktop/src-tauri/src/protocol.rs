//! Wire protocol (mirrors packages/shared).

use serde::{Deserialize, Serialize};

pub const HOST_HEARTBEAT_MS: u64 = 5000;
pub const CLIENT_HEADER: &str = "desktop/0.2.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    pub version: u64,
    pub video_url: Option<String>,
    pub is_playing: bool,
    pub position_ms: f64,
    pub server_anchor_ms: i64,
    pub host_session_id: Option<String>,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub queue: Vec<String>,
    #[serde(default)]
    pub queue_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub session_id: String,
    pub nickname: String,
    pub is_host: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub session_id: String,
    pub nickname: String,
    pub text: String,
    pub server_time_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello {
        nickname: Option<String>,
        #[serde(rename = "clientTimeMs")]
        client_time_ms: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        /// Process-stable id so DO can replace ghost sockets on rejoin/reconnect.
        #[serde(rename = "clientKey", skip_serializing_if = "Option::is_none")]
        client_key: Option<String>,
    },
    /// Add URL and switch to it (also appends to queue if new).
    SetUrl {
        url: String,
    },
    QueueAdd {
        url: String,
        #[serde(rename = "playIfIdle")]
        play_if_idle: bool,
    },
    QueueRemove {
        index: u32,
    },
    QueuePlay {
        index: u32,
    },
    QueueClear {},
    Play {
        #[serde(rename = "positionMs")]
        position_ms: f64,
    },
    Pause {
        #[serde(rename = "positionMs")]
        position_ms: f64,
    },
    Seek {
        #[serde(rename = "positionMs")]
        position_ms: f64,
        #[serde(rename = "isPlaying")]
        is_playing: bool,
    },
    Heartbeat {
        #[serde(rename = "positionMs")]
        position_ms: f64,
        #[serde(rename = "isPlaying")]
        is_playing: bool,
    },
    SetNickname {
        nickname: String,
    },
    Chat {
        text: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Welcome {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "isHost")]
        is_host: bool,
        state: PlaybackState,
        members: Vec<Member>,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: i64,
    },
    State {
        state: PlaybackState,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: i64,
    },
    Members {
        members: Vec<Member>,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: i64,
    },
    Chat {
        message: ChatMessage,
    },
    Error {
        code: String,
        message: String,
    },
    RoomClosed {
        reason: String,
        message: String,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: i64,
    },
}

pub fn expected_position_ms(state: &PlaybackState, now_ms: i64) -> f64 {
    if !state.is_playing {
        return state.position_ms;
    }
    (state.position_ms + (now_ms - state.server_anchor_ms) as f64).max(0.0)
}
