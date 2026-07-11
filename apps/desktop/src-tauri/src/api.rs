//! REST against VidSync API.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::protocol::CLIENT_HEADER;

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRoomResponse {
    pub code: String,
    #[serde(rename = "wsUrl")]
    pub ws_url: String,
}

pub async fn create_room(api_base: &str) -> Result<CreateRoomResponse> {
    let base = api_base.trim_end_matches('/');
    let url = format!("{base}/rooms");
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("X-VidSync-Client", CLIENT_HEADER)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .context("create room request")?;

    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("create room HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).context("parse create room response")
}

pub fn ws_url_for_code(api_base: &str, code: &str) -> String {
    let base = api_base.trim_end_matches('/');
    let u = url::Url::parse(base).unwrap_or_else(|_| {
        url::Url::parse("https://api.vidsync.ratt.ing").expect("fallback")
    });
    let host = u.host_str().unwrap_or("api.vidsync.ratt.ing");
    let port = u.port();
    let scheme = if u.scheme() == "http" { "ws" } else { "wss" };
    match port {
        Some(p) => format!("{scheme}://{host}:{p}/rooms/{code}/ws"),
        None => format!("{scheme}://{host}/rooms/{code}/ws"),
    }
}

pub async fn health(api_base: &str) -> Result<()> {
    let base = api_base.trim_end_matches('/');
    let res = reqwest::Client::new()
        .get(format!("{base}/health"))
        .send()
        .await
        .context("health")?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(anyhow!("health {}", res.status()))
    }
}
