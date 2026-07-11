//! Local network helpers.

use std::net::Ipv4Addr;

use local_ip_address::local_ip;

/// Best-effort primary LAN IPv4 (not 127.0.0.1).
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    match local_ip().ok()? {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() => Some(v4),
        _ => None,
    }
}
