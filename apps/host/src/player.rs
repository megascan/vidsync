//! Native cross-platform video player via system WebView.
//!
//! - Windows: WebView2 (bundled with modern Windows / Edge — no extra app download)
//! - macOS: WKWebView (built into the OS)
//! - Linux: WebKitGTK (distro package `webkit2gtk`, not a separate app download)
//!
//! Uses the OS media stack for codecs. No mpv/ffmpeg install required.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use tracing::{info, warn};
use wry::WebViewBuilder;

#[derive(Debug, Clone, Default)]
pub struct PlayerSnapshot {
    pub position_ms: f64,
    pub is_paused: bool,
    pub duration_ms: Option<f64>,
    pub url: Option<String>,
    pub ready: bool,
}

/// User gesture from the embedded player (host mirrors to DO).
#[derive(Debug, Clone)]
pub enum PlayerUserEvent {
    Play { position_ms: f64 },
    Pause { position_ms: f64 },
    Seek { position_ms: f64, is_playing: bool },
}

enum Cmd {
    Load(String),
    Play,
    Pause,
    SeekSec(f64),
    Show,
    Quit,
}

struct Shared {
    snap: Mutex<PlayerSnapshot>,
    user_events: Mutex<Vec<PlayerUserEvent>>,
    applying: AtomicBool,
    alive: AtomicBool,
}

pub struct NativePlayer {
    cmd_tx: std::sync::mpsc::Sender<Cmd>,
    shared: Arc<Shared>,
}

impl NativePlayer {
    pub fn start() -> Result<Self> {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<Cmd>();
        let shared = Arc::new(Shared {
            snap: Mutex::new(PlayerSnapshot::default()),
            user_events: Mutex::new(Vec::new()),
            applying: AtomicBool::new(false),
            alive: AtomicBool::new(false),
        });
        let shared_thread = Arc::clone(&shared);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<()>>();

        thread::Builder::new()
            .name("vidsync-player".into())
            .spawn(move || {
                if let Err(e) = run_player_loop(cmd_rx, shared_thread, ready_tx) {
                    warn!("player thread ended: {e:#}");
                }
            })
            .map_err(|e| anyhow!("spawn player thread: {e}"))?;

        match ready_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(_) => bail!(
                "Player window timed out. On Windows, install Microsoft Edge WebView2 Runtime. On Linux, install webkit2gtk."
            ),
        }

        info!("native WebView player ready");
        Ok(Self { cmd_tx, shared })
    }

    pub fn available() -> bool {
        true
    }

    pub fn load_url(&self, url: &str) -> Result<()> {
        self.shared.applying.store(true, Ordering::SeqCst);
        self.cmd_tx
            .send(Cmd::Load(url.to_string()))
            .map_err(|_| anyhow!("player gone"))?;
        let _ = self.cmd_tx.send(Cmd::Show);
        Ok(())
    }

    pub fn set_pause(&self, pause: bool) -> Result<()> {
        self.shared.applying.store(true, Ordering::SeqCst);
        self.cmd_tx
            .send(if pause { Cmd::Pause } else { Cmd::Play })
            .map_err(|_| anyhow!("player gone"))?;
        Ok(())
    }

    pub fn seek_seconds(&self, sec: f64) -> Result<()> {
        self.shared.applying.store(true, Ordering::SeqCst);
        self.cmd_tx
            .send(Cmd::SeekSec(sec.max(0.0)))
            .map_err(|_| anyhow!("player gone"))?;
        Ok(())
    }

    pub fn show(&self) {
        let _ = self.cmd_tx.send(Cmd::Show);
    }

    pub fn time_pos_ms(&self) -> Result<f64> {
        Ok(self.shared.snap.lock().unwrap().position_ms)
    }

    pub fn is_paused(&self) -> Result<bool> {
        Ok(self.shared.snap.lock().unwrap().is_paused)
    }

    pub fn applying_remote(&self) -> bool {
        self.shared.applying.load(Ordering::SeqCst)
    }

    pub fn drain_user_events(&self) -> Vec<PlayerUserEvent> {
        let mut g = self.shared.user_events.lock().unwrap();
        std::mem::take(&mut *g)
    }

    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::SeqCst)
    }
}

impl Drop for NativePlayer {
    fn drop(&mut self) {
        let _ = self.cmd_tx.send(Cmd::Quit);
    }
}

fn run_player_loop(
    cmd_rx: std::sync::mpsc::Receiver<Cmd>,
    shared: Arc<Shared>,
    ready_tx: std::sync::mpsc::Sender<Result<()>>,
) -> Result<()> {
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("VidSync Player")
        .with_inner_size(tao::dpi::LogicalSize::new(960.0, 540.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(320.0, 180.0))
        .build(&event_loop)
        .map_err(|e| anyhow!("player window: {e}"))?;

    let shared_ipc = Arc::clone(&shared);
    let html = player_html();

    let builder = WebViewBuilder::new()
        .with_html(&html)
        .with_ipc_handler(move |req| {
            handle_ipc(&shared_ipc, req.body());
        });

    #[cfg(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    ))]
    let webview_result = builder.build(&window);

    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    let webview_result = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        match window.default_vbox() {
            Some(vbox) => builder.build_gtk(vbox),
            None => Err(wry::Error::InitScriptError),
        }
    };

    let webview = match webview_result {
        Ok(w) => w,
        Err(e) => {
            let err = anyhow!(
                "WebView init failed: {e}. Windows: WebView2 Runtime. Linux: webkit2gtk package."
            );
            let _ = ready_tx.send(Err(anyhow!("{err:#}")));
            return Err(err);
        }
    };

    shared.alive.store(true, Ordering::SeqCst);
    let _ = ready_tx.send(Ok(()));

    let proxy = event_loop.create_proxy();
    let poll_shared = Arc::clone(&shared);
    thread::spawn(move || {
        while poll_shared.alive.load(Ordering::SeqCst) {
            let _ = proxy.send_event(());
            thread::sleep(Duration::from_millis(40));
        }
    });

    let mut cmd_rx = cmd_rx;
    let window = window;
    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;

        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                Cmd::Load(url) => {
                    if let Ok(mut s) = shared.snap.lock() {
                        s.url = Some(url.clone());
                    }
                    let js = format!(
                        "window.__vs && window.__vs.load({});",
                        serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into())
                    );
                    let _ = webview.evaluate_script(&js);
                    window.set_visible(true);
                    window.set_focus();
                    clear_applying_later(&shared, 400);
                }
                Cmd::Play => {
                    let _ = webview.evaluate_script("window.__vs && window.__vs.play();");
                    clear_applying_later(&shared, 200);
                }
                Cmd::Pause => {
                    let _ = webview.evaluate_script("window.__vs && window.__vs.pause();");
                    clear_applying_later(&shared, 200);
                }
                Cmd::SeekSec(sec) => {
                    let js = format!("window.__vs && window.__vs.seek({sec});");
                    let _ = webview.evaluate_script(&js);
                    clear_applying_later(&shared, 200);
                }
                Cmd::Show => {
                    window.set_visible(true);
                    window.set_focus();
                }
                Cmd::Quit => {
                    shared.alive.store(false, Ordering::SeqCst);
                    *control_flow = ControlFlow::Exit;
                    return;
                }
            }
        }

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // Hide — GUI can show again
                window.set_visible(false);
            }
            Event::LoopDestroyed => {
                shared.alive.store(false, Ordering::SeqCst);
            }
            _ => {}
        }
    });
}

fn clear_applying_later(shared: &Arc<Shared>, ms: u64) {
    let sh = Arc::clone(shared);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(ms));
        sh.applying.store(false, Ordering::SeqCst);
    });
}

fn handle_ipc(shared: &Shared, body: &str) {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return,
    };
    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let pos = v
        .get("positionMs")
        .and_then(|p| p.as_f64())
        .unwrap_or(0.0);
    let paused = v.get("paused").and_then(|p| p.as_bool()).unwrap_or(true);
    let duration = v.get("durationMs").and_then(|d| d.as_f64());

    match ty {
        "tick" => {
            if let Ok(mut s) = shared.snap.lock() {
                s.position_ms = pos;
                s.is_paused = paused;
                s.duration_ms = duration;
                s.ready = true;
            }
        }
        "play" | "pause" | "seek" => {
            if shared.applying.load(Ordering::SeqCst) {
                return;
            }
            let ev = match ty {
                "play" => PlayerUserEvent::Play { position_ms: pos },
                "pause" => PlayerUserEvent::Pause { position_ms: pos },
                _ => PlayerUserEvent::Seek {
                    position_ms: pos,
                    is_playing: !paused,
                },
            };
            if let Ok(mut q) = shared.user_events.lock() {
                q.push(ev);
            }
            if let Ok(mut s) = shared.snap.lock() {
                s.position_ms = pos;
                s.is_paused = paused;
            }
        }
        "ready" => {
            if let Ok(mut s) = shared.snap.lock() {
                s.ready = true;
            }
        }
        _ => {}
    }
}

fn player_html() -> String {
    r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VidSync Player</title>
<style>
  html,body{margin:0;height:100%;background:#0b0c0f;color:#e8eaed;font:13px/1.4 system-ui,sans-serif}
  body{display:flex;flex-direction:column}
  header{padding:8px 12px;border-bottom:1px solid #272a33;display:flex;justify-content:space-between;gap:8px;flex-shrink:0}
  header strong{color:#6ee7b7;letter-spacing:.04em;font-size:12px}
  #status{color:#8b90a0;font-size:11px}
  #stage{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#000}
  video{width:100%;height:100%;max-height:100%;background:#000;object-fit:contain}
</style>
</head>
<body>
<header>
  <strong>VIDSYNC</strong>
  <span id="status">Ready</span>
</header>
<div id="stage">
  <video id="v" playsinline controls></video>
</div>
<script>
(function(){
  const v = document.getElementById('v');
  const status = document.getElementById('status');
  let applying = false;
  let lastControl = 0;

  function ipcSend(obj){
    try {
      window.ipc.postMessage(JSON.stringify(obj));
    } catch (e) {
      try {
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage(JSON.stringify(obj));
        }
      } catch (_) {}
    }
  }

  function setStatus(s){ status.textContent = s; }

  function emitUser(type){
    if (applying) return;
    const now = Date.now();
    if (now - lastControl < 80) return;
    lastControl = now;
    ipcSend({
      type: type,
      positionMs: Math.round((v.currentTime||0)*1000),
      paused: !!v.paused,
      durationMs: Number.isFinite(v.duration) ? Math.round(v.duration*1000) : null
    });
  }

  window.__vs = {
    load: function(url){
      applying = true;
      v.src = url;
      v.load();
      setStatus('Loading…');
      setTimeout(function(){ applying = false; }, 400);
    },
    play: function(){
      applying = true;
      v.play().catch(function(){ setStatus('Click play (autoplay blocked)'); });
      setTimeout(function(){ applying = false; }, 250);
    },
    pause: function(){
      applying = true;
      v.pause();
      setTimeout(function(){ applying = false; }, 250);
    },
    seek: function(sec){
      applying = true;
      if (Number.isFinite(sec)) v.currentTime = Math.max(0, sec);
      setTimeout(function(){ applying = false; }, 250);
    }
  };

  v.addEventListener('loadedmetadata', function(){
    setStatus(Number.isFinite(v.duration)
      ? ('Ready · ' + Math.round(v.duration/60) + ' min')
      : 'Ready');
    ipcSend({type:'ready'});
  });
  v.addEventListener('error', function(){ setStatus('Media error — check URL / codec support'); });
  v.addEventListener('play', function(){ if (!applying) { setStatus('Playing'); emitUser('play'); }});
  v.addEventListener('pause', function(){ if (!applying) { setStatus('Paused'); emitUser('pause'); }});
  v.addEventListener('seeked', function(){ if (!applying) emitUser('seek'); });

  setInterval(function(){
    ipcSend({
      type: 'tick',
      positionMs: Math.round((v.currentTime||0)*1000),
      paused: !!v.paused,
      durationMs: Number.isFinite(v.duration) ? Math.round(v.duration*1000) : null
    });
  }, 500);

  ipcSend({type:'ready'});
})();
</script>
</body>
</html>"#
        .to_string()
}
