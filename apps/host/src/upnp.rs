//! Temporary UPnP IGD TCP port mapping.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use anyhow::{anyhow, Context, Result};
use igd_next::aio::tokio::Tokio;
use igd_next::aio::Gateway;
use igd_next::{PortMappingProtocol, SearchOptions};
use tracing::info;

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
    info!("searching UPnP gateway…");
    let gateway = igd_next::aio::tokio::search_gateway(SearchOptions::default())
        .await
        .context("UPnP search_gateway (is UPnP/IGD enabled on the router?)")?;

    let external_ip = match gateway.get_external_ip().await {
        Ok(std::net::IpAddr::V4(v4)) => v4,
        Ok(other) => {
            return Err(anyhow!("gateway external IP not IPv4: {other}"));
        }
        Err(e) => return Err(anyhow!("get_external_ip: {e}")),
    };

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
        // Prefer same port, else any free external port
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
    info!(
        "UPnP mapped {external_ip}:{external_port} → {local_ip}:{local_port}"
    );

    Ok(Mapping {
        gateway,
        external_ip,
        external_port,
        gateway_addr,
    })
}
