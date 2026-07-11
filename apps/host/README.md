# vidsync-host

Serve a local video over HTTP (Range / seek-friendly), optional **UPnP** temp port-forward, and helper to stage the **VidSync Unblock** extension.

**GUI by default** (pick file → Start stream → copy URL). CLI still works for scripts.

## Build

```bash
cd apps/host
cargo build --release
# binary: target/release/vidsync-host.exe
```

## GUI

```bash
cargo run --release
# or
cargo run --release -- gui
```

- **Browse…** — native file picker  
- **Port** / **UPnP** toggle  
- **Start stream** / **Stop**  
- **Install Unblock** — stage extension + session load  
- Share URLs with **Copy**

## Serve a file (CLI)

```bash
# LAN + UPnP (default). URL copied to clipboard.
cargo run -- serve "D:\videos\movie.mp4"

# LAN only
cargo run -- serve ./clip.mp4 --no-upnp

# Custom port / external port / also open extension helper
cargo run -- serve ./clip.mp4 -p 9000 --external-port 9000 --install-ext
```

Prints:

- **LAN URL** — same Wi‑Fi / network  
- **WAN URL** — if UPnP IGD works on the router  

Paste URL into the VidSync room queue, then **Stream with Unblock**.

Stop with **Ctrl+C** — removes the UPnP mapping.

Stream path is secret: `http://IP:PORT/s/<token>` (not a directory listing of your disk).

## Install Unblock extension

Browsers block silent MV3 installs. This **stages** the unpacked extension and can launch Chrome/Edge with `--load-extension` for the session:

```bash
cargo run -- install-ext
cargo run -- install-ext --edge
cargo run -- install-ext --no-launch
cargo run -- install-ext --from ../../extensions/vidsync-unblock --no-launch
```

Staged to:

- Windows: `%LOCALAPPDATA%\VidSync\extension\vidsync-unblock`
- Linux: `~/.local/share/VidSync/extension/vidsync-unblock`

Permanent: Developer mode → Load unpacked → that folder.

## Notes

- Needs **Range** support on the client (browsers + Unblock player do).  
- UPnP must be enabled on the router; CGNAT / no IGD → WAN URL fails, LAN still works.  
- Exposes one file for as long as the process runs — treat the token URL as semi-secret.  
- Firewall may prompt for inbound TCP on first run.
