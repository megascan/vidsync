//! Local + public network helpers.

use std::net::Ipv4Addr;
use std::time::Duration;

use local_ip_address::local_ip;
use tracing::{info, warn};

/// Best-effort primary LAN IPv4 (not 127.0.0.1).
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    match local_ip().ok()? {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}

/// Discover WAN IPv4 via public HTTPS “what is my IP” services.
/// Works even when UPnP fails — needed for share URLs + manual port-forward.
pub async fn public_ipv4() -> Option<Ipv4Addr> {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .user_agent("vidsync-host/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!("public IP HTTP client: {e}");
            return None;
        }
    };

    // Multiple providers — first clean IPv4 wins
    const URLS: &[&str] = &[
        "https://api.ipify.org",
        "https://ipv4.icanhazip.com",
        "https://ifconfig.me/ip",
        "https://checkip.amazonaws.com",
    ];

    for url in URLS {
        match client.get(*url).send().await {
            Ok(res) if res.status().is_success() => {
                if let Ok(text) = res.text().await {
                    let trimmed = text.trim();
                    // Some services add a trailing newline / junk
                    let candidate = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed);
                    if let Ok(ip) = candidate.parse::<Ipv4Addr>() {
                        if is_usable_public(ip) {
                            info!("public IPv4 via {url}: {ip}");
                            return Some(ip);
                        }
                    }
                }
            }
            Ok(res) => warn!("public IP {url} → HTTP {}", res.status()),
            Err(e) => warn!("public IP {url} failed: {e}"),
        }
    }
    None
}

/// True if IPv4 looks usable as a global WAN address (not private/CGNAT).
pub fn is_globally_routable_v4(ip: Ipv4Addr) -> bool {
    is_usable_public(ip)
}

fn is_usable_public(ip: Ipv4Addr) -> bool {
    !ip.is_loopback()
        && !ip.is_private()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !ip.is_broadcast()
        // RFC 6598 CGNAT 100.64.0.0/10 — not globally routable inbound
        && !(ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
}
