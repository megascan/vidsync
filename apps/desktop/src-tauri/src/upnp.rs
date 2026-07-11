//! Temporary UPnP IGD TCP port mapping.
//!
//! This is **not** how most games get online. See DOCS/host-app.md:
//! games use STUN + UDP hole punching + relay fallback. UPnP is optional
//! “ask router to open a port” — often disabled / broken / CGNAT-blocked.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use igd_next::aio::tokio::Tokio;
use igd_next::aio::Gateway;
use igd_next::{PortMappingProtocol, SearchOptions};
use tracing::{info, warn};

pub struct Mapping {
    gateway: Gateway<Tokio>,
    pub external_ip: Ipv4Addr,
    pub external_port: u16,
    pub gateway_addr: SocketAddr,
}

impl Mapping {
    pub async fn remove(self) -> Result<()> {
        self.gateway
            .remove_port(PortMappingProtocol::TCP, self.external_port)
            .await
            .context("remove_port")?;
        Ok(())
    }
}

/// Map WAN TCP → local_ip:local_port. Prefer `prefer_external` if non-zero.
pub async fn map_tcp(
    local_ip: Ipv4Addr,
    local_port: u16,
    prefer_external: u16,
    lease_secs: u32,
) -> Result<Mapping> {
    info!("searching UPnP gateway (SSDP multicast)…");
    let gateway = search_gateway_best_effort(local_ip)
        .await
        .map_err(search_error_hint)?;

    let external_ip = match gateway.get_external_ip().await {
        Ok(std::net::IpAddr::V4(v4)) => v4,
        Ok(other) => {
            return Err(anyhow!("gateway external IP not IPv4: {other}"));
        }
        Err(e) => return Err(anyhow!("get_external_ip: {e}")),
    };

    // CGNAT / double-NAT check — UPnP “works” but still unreachable from internet
    if is_private_or_cgnat(external_ip) {
        warn!(
            "router external IP {external_ip} looks private/CGNAT — UPnP map won't help WAN peers"
        );
    }

    let local_addr = SocketAddr::V4(SocketAddrV4::new(local_ip, local_port));
    let desc = "VidSync Host";

    let external_port = if prefer_external != 0 {
        gateway
            .add_port(
                PortMappingProtocol::TCP,
                prefer_external,
                local_addr,
                lease_secs,
                desc,
            )
            .await
            .with_context(|| format!("add_port {prefer_external}"))?;
        prefer_external
    } else {
        match gateway
            .add_port(
                PortMappingProtocol::TCP,
                local_port,
                local_addr,
                lease_secs,
                desc,
            )
            .await
        {
            Ok(()) => local_port,
            Err(_) => gateway
                .add_any_port(PortMappingProtocol::TCP, local_addr, lease_secs, desc)
                .await
                .context("add_any_port")?,
        }
    };

    let gateway_addr = gateway.addr;
    info!("UPnP mapped {external_ip}:{external_port} → {local_ip}:{local_port}");

    Ok(Mapping {
        gateway,
        external_ip,
        external_port,
        gateway_addr,
    })
}

async fn search_gateway_best_effort(local_ip: Ipv4Addr) -> Result<Gateway<Tokio>, igd_next::SearchError> {
    // 1) Bind SSDP socket to LAN iface (fixes multi-homed / wrong default route)
    let bound = SearchOptions {
        bind_addr: SocketAddr::V4(SocketAddrV4::new(local_ip, 0)),
        timeout: Some(Duration::from_secs(8)),
        single_search_timeout: Some(Duration::from_secs(3)),
        ..Default::default()
    };
    match igd_next::aio::tokio::search_gateway(bound).await {
        Ok(g) => return Ok(g),
        Err(e) => {
            warn!("UPnP search on {local_ip} failed ({e}); retrying 0.0.0.0…");
        }
    }

    // 2) Default bind (all interfaces), longer wait
    let open = SearchOptions {
        timeout: Some(Duration::from_secs(12)),
        single_search_timeout: Some(Duration::from_secs(4)),
        ..Default::default()
    };
    igd_next::aio::tokio::search_gateway(open).await
}

fn search_error_hint(e: igd_next::SearchError) -> anyhow::Error {
    anyhow!(
        "UPnP/IGD discovery failed: {e}\n\
         \n\
         Router never answered SSDP (239.255.255.250:1900). Common causes:\n\
         • UPnP / IGD disabled on the router (default on many ISPs)\n\
         • Windows firewall / AP isolation / guest Wi‑Fi\n\
         • Double NAT or CGNAT (ISP shares one public IP — map does nothing)\n\
         • VPN active (SSDP never reaches home gateway)\n\
         \n\
         Games usually do NOT depend on UPnP alone — they use STUN + UDP hole\n\
         punching and fall back to a relay server. For VidSync (HTTP TCP file\n\
         stream) options: manual port-forward, same LAN only, or a tunnel\n\
         (Cloudflare Tunnel / ngrok / Tailscale Funnel)."
    )
}

fn is_private_or_cgnat(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        // RFC 6598 shared address space (CGNAT): 100.64.0.0/10
        || (ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64)
}
