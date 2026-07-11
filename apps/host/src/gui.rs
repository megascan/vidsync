//! VidSync desktop — home lobby + room (sync, stream, native WebView player).

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui::{self, Color32, RichText, Vec2};
use tokio::runtime::Runtime;

use crate::player::{NativePlayer, PlayerUserEvent};
use crate::protocol::{expected_position_ms, ClientMessage, Member, PlaybackState};
use crate::session::{ServeOptions, ServeSession};
use crate::sync::{self, SyncEvent, SyncHandle};

const DEFAULT_API: &str = "https://api.vidsync.ratt.ing";

enum WorkerCmd {
    Create {
        api: String,
        nick: String,
        reply: Sender<Result<(String, SyncHandle), String>>,
    },
    Join {
        api: String,
        code: String,
        nick: String,
        reply: Sender<Result<SyncHandle, String>>,
    },
    StartFile {
        path: PathBuf,
        port: u16,
        upnp: bool,
        reply: Sender<Result<Box<ServeSession>, String>>,
    },
    StopFile {
        session: Box<ServeSession>,
        reply: Sender<()>,
    },
}

pub fn run() -> eframe::Result<()> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCmd>();
    thread::spawn(move || worker_loop(cmd_rx));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([720.0, 520.0])
            .with_min_inner_size([560.0, 400.0])
            .with_title("VidSync"),
        ..Default::default()
    };

    eframe::run_native(
        "VidSync",
        options,
        Box::new(|cc| {
            cc.egui_ctx.set_pixels_per_point(1.1);
            Ok(Box::new(App::new(cmd_tx)))
        }),
    )
}

fn worker_loop(rx: Receiver<WorkerCmd>) {
    let rt = Runtime::new().expect("tokio");
    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCmd::Create { api, nick, reply } => {
                let r = rt
                    .block_on(sync::create_and_join(&api, nick))
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(r);
            }
            WorkerCmd::Join {
                api,
                code,
                nick,
                reply,
            } => {
                let r = rt
                    .block_on(sync::join_room(&api, &code, nick))
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(r);
            }
            WorkerCmd::StartFile {
                path,
                port,
                upnp,
                reply,
            } => {
                let r = rt
                    .block_on(ServeSession::start(ServeOptions {
                        file: path,
                        port,
                        bind: "0.0.0.0".into(),
                        upnp,
                        external_port: 0,
                        lease_secs: 0,
                        clipboard: true,
                    }))
                    .map(Box::new)
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(r);
            }
            WorkerCmd::StopFile { session, reply } => {
                rt.block_on(session.stop());
                let _ = reply.send(());
            }
        }
    }
}

enum Screen {
    Home,
    Room,
}

struct App {
    cmd_tx: Sender<WorkerCmd>,
    screen: Screen,
    api_base: String,
    nick: String,
    join_code: String,
    busy: bool,
    status: String,
    error: Option<String>,
    // room
    room_code: Option<String>,
    is_host: bool,
    session_id: Option<String>,
    members: Vec<Member>,
    playback: Option<PlaybackState>,
    chat_lines: Vec<String>,
    chat_draft: String,
    sync: Option<SyncHandle>,
    clock_offset_ms: i64,
    // media
    serve: Option<Box<ServeSession>>,
    stream_url: Option<String>,
    port: String,
    use_upnp: bool,
    pending_create: Option<Receiver<Result<(String, SyncHandle), String>>>,
    pending_join: Option<Receiver<Result<SyncHandle, String>>>,
    pending_file: Option<Receiver<Result<Box<ServeSession>, String>>>,
    pending_stop_file: Option<Receiver<()>>,
    // player (system WebView — no mpv)
    player: Option<NativePlayer>,
    last_applied_version: i64,
    last_hb: Instant,
    copied_flash: Option<Instant>,
}

impl App {
    fn new(cmd_tx: Sender<WorkerCmd>) -> Self {
        Self {
            cmd_tx,
            screen: Screen::Home,
            api_base: DEFAULT_API.into(),
            nick: std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_else(|_| "viewer".into()),
            join_code: String::new(),
            busy: false,
            status: "Create a room or join with a code.".into(),
            error: None,
            room_code: None,
            is_host: false,
            session_id: None,
            members: Vec::new(),
            playback: None,
            chat_lines: Vec::new(),
            chat_draft: String::new(),
            sync: None,
            clock_offset_ms: 0,
            serve: None,
            stream_url: None,
            port: "8765".into(),
            use_upnp: true,
            pending_create: None,
            pending_join: None,
            pending_file: None,
            pending_stop_file: None,
            player: None,
            last_applied_version: -1,
            last_hb: Instant::now() - Duration::from_secs(10),
            copied_flash: None,
        }
    }

    fn now_server_ms(&self) -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        let local = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        local + self.clock_offset_ms
    }

    fn ensure_player(&mut self) {
        if let Some(p) = &self.player {
            if p.is_alive() {
                p.show();
                return;
            }
        }
        match NativePlayer::start() {
            Ok(p) => {
                self.player = Some(p);
                self.status = "Player ready (system WebView).".into();
                self.error = None;
            }
            Err(e) => {
                self.error = Some(format!("{e:#}"));
            }
        }
    }

    fn copy_text(&mut self, ctx: &egui::Context, text: &str) {
        ctx.copy_text(text.to_string());
        crate::session::try_clipboard(text);
        self.copied_flash = Some(Instant::now());
        self.status = format!("Copied: {text}");
    }

    fn leave_room(&mut self) {
        if let Some(s) = self.sync.take() {
            s.disconnect();
        }
        if let Some(serve) = self.serve.take() {
            let (tx, rx) = mpsc::channel();
            let _ = self.cmd_tx.send(WorkerCmd::StopFile {
                session: serve,
                reply: tx,
            });
            self.pending_stop_file = Some(rx);
            self.busy = true;
        }
        self.player = None;
        self.room_code = None;
        self.session_id = None;
        self.is_host = false;
        self.members.clear();
        self.playback = None;
        self.chat_lines.clear();
        self.stream_url = None;
        self.last_applied_version = -1;
        self.screen = Screen::Home;
        self.status = "Left room.".into();
    }

    fn poll(&mut self) {
        // async replies
        if let Some(rx) = &self.pending_create {
            match rx.try_recv() {
                Ok(Ok((code, handle))) => {
                    self.room_code = Some(code.clone());
                    self.sync = Some(handle);
                    self.screen = Screen::Room;
                    self.busy = false;
                    self.pending_create = None;
                    self.status = format!("Room {code} — share code with friends.");
                    self.error = None;
                    self.ensure_player();
                }
                Ok(Err(e)) => {
                    self.error = Some(e);
                    self.busy = false;
                    self.pending_create = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.pending_create = None;
                }
            }
        }
        if let Some(rx) = &self.pending_join {
            match rx.try_recv() {
                Ok(Ok(handle)) => {
                    self.sync = Some(handle);
                    self.screen = Screen::Room;
                    self.busy = false;
                    self.pending_join = None;
                    self.status = "Joined room.".into();
                    self.error = None;
                    self.ensure_player();
                }
                Ok(Err(e)) => {
                    self.error = Some(e);
                    self.busy = false;
                    self.pending_join = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.pending_join = None;
                }
            }
        }
        if let Some(rx) = &self.pending_file {
            match rx.try_recv() {
                Ok(Ok(session)) => {
                    let url = session
                        .info
                        .primary_url()
                        .to_string();
                    self.stream_url = Some(url.clone());
                    self.serve = Some(session);
                    self.busy = false;
                    self.pending_file = None;
                    self.status = format!("Streaming — queued {url}");
                    if let Some(sync) = &self.sync {
                        if self.is_host {
                            sync.send(ClientMessage::QueueAdd {
                                url: url.clone(),
                                play_if_idle: true,
                            });
                        }
                    }
                    self.ensure_player();
                    if let Some(p) = &self.player {
                        let _ = p.load_url(&url);
                    }
                    self.copy_text_silent(&url);
                }
                Ok(Err(e)) => {
                    self.error = Some(e);
                    self.busy = false;
                    self.pending_file = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.pending_file = None;
                }
            }
        }
        if let Some(rx) = &self.pending_stop_file {
            if rx.try_recv().is_ok() {
                self.pending_stop_file = None;
                self.busy = false;
            }
        }

        // sync events
        let mut events = Vec::new();
        if let Some(sync) = &mut self.sync {
            while let Ok(ev) = sync.events.try_recv() {
                events.push(ev);
            }
        }
        for ev in events {
            self.on_sync(ev);
        }

        // host used controls inside the player window
        self.drain_player_user_events();

        // host heartbeat + follower drift
        self.tick_playback();
    }

    fn drain_player_user_events(&mut self) {
        if !self.is_host {
            return;
        }
        let Some(player) = &self.player else { return };
        let events = player.drain_user_events();
        for ev in events {
            let Some(sync) = &self.sync else { continue };
            match ev {
                PlayerUserEvent::Play { position_ms } => {
                    sync.send(ClientMessage::Play { position_ms });
                }
                PlayerUserEvent::Pause { position_ms } => {
                    sync.send(ClientMessage::Pause { position_ms });
                }
                PlayerUserEvent::Seek {
                    position_ms,
                    is_playing,
                } => {
                    sync.send(ClientMessage::Seek {
                        position_ms,
                        is_playing,
                    });
                }
            }
        }
    }

    fn copy_text_silent(&mut self, text: &str) {
        crate::session::try_clipboard(text);
        self.copied_flash = Some(Instant::now());
    }

    fn on_sync(&mut self, ev: SyncEvent) {
        match ev {
            SyncEvent::Connected => {
                self.status = "Connected.".into();
            }
            SyncEvent::Disconnected(r) => {
                self.error = Some(format!("Disconnected: {r}"));
                self.status = "Disconnected.".into();
            }
            SyncEvent::Welcome {
                session_id,
                is_host,
                state,
                members,
                server_time_ms,
            } => {
                self.session_id = Some(session_id);
                self.is_host = is_host;
                self.members = members;
                self.apply_clock(server_time_ms);
                self.apply_playback_state(state, true);
            }
            SyncEvent::State {
                state,
                server_time_ms,
            } => {
                self.apply_clock(server_time_ms);
                self.apply_playback_state(state, false);
            }
            SyncEvent::Members { members } => {
                self.members = members;
                if let Some(sid) = &self.session_id {
                    self.is_host = self
                        .members
                        .iter()
                        .any(|m| m.session_id == *sid && m.is_host);
                }
            }
            SyncEvent::Chat(m) => {
                self.chat_lines
                    .push(format!("{}: {}", m.nickname, m.text));
                if self.chat_lines.len() > 200 {
                    self.chat_lines.drain(0..50);
                }
            }
            SyncEvent::Error { code, message } => {
                self.error = Some(format!("{code}: {message}"));
            }
        }
    }

    fn apply_clock(&mut self, server_time_ms: i64) {
        use std::time::{SystemTime, UNIX_EPOCH};
        let local = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.clock_offset_ms = server_time_ms - local;
    }

    fn apply_playback_state(&mut self, state: PlaybackState, force: bool) {
        let version = state.version as i64;
        let url_changed = self
            .playback
            .as_ref()
            .map(|p| p.video_url != state.video_url)
            .unwrap_or(true);

        if !force && version == self.last_applied_version && !url_changed {
            self.playback = Some(state);
            return;
        }
        self.last_applied_version = version;

        // Followers always apply; host only on force (welcome) or URL change from queue
        let should_drive = !self.is_host || force || url_changed;

        if should_drive {
            if let Some(url) = state.video_url.clone() {
                self.ensure_player();
                if let Some(p) = &self.player {
                    let now = self.now_server_ms();
                    let pos = expected_position_ms(&state, now);
                    if url_changed || force {
                        let _ = p.load_url(&url);
                    }
                    let _ = p.seek_seconds(pos / 1000.0);
                    let _ = p.set_pause(!state.is_playing);
                }
            }
        }

        self.playback = Some(state);
    }

    fn tick_playback(&mut self) {
        if self.sync.is_none() {
            return;
        }
        if !self.is_host {
            // soft drift for followers every ~2s
            if self.last_hb.elapsed() < Duration::from_secs(2) {
                return;
            }
            self.last_hb = Instant::now();
            if let (Some(state), Some(p)) = (self.playback.as_ref(), self.player.as_ref()) {
                if p.applying_remote() {
                    return;
                }
                if state.video_url.is_some() {
                    let now = self.now_server_ms();
                    let target = expected_position_ms(state, now);
                    if let Ok(cur) = p.time_pos_ms() {
                        if (cur - target).abs() > 450.0 {
                            let _ = p.seek_seconds(target / 1000.0);
                        }
                    }
                    let _ = p.set_pause(!state.is_playing);
                }
            }
            return;
        }

        // host heartbeat
        if self.last_hb.elapsed() < Duration::from_millis(crate::protocol::HOST_HEARTBEAT_MS) {
            return;
        }
        self.last_hb = Instant::now();
        let playing = self.playback.as_ref().map(|p| p.is_playing).unwrap_or(false);
        if !playing {
            return;
        }
        if let (Some(p), Some(sync)) = (self.player.as_ref(), self.sync.as_ref()) {
            if let Ok(pos) = p.time_pos_ms() {
                let paused = p.is_paused().unwrap_or(false);
                sync.send(ClientMessage::Heartbeat {
                    position_ms: pos,
                    is_playing: !paused,
                });
            }
        }
    }

    fn host_play(&mut self) {
        if !self.is_host {
            return;
        }
        let pos = self
            .player
            .as_ref()
            .and_then(|m| m.time_pos_ms().ok())
            .unwrap_or(0.0);
        if let Some(p) = &self.player {
            let _ = p.set_pause(false);
        }
        if let Some(sync) = &self.sync {
            sync.send(ClientMessage::Play { position_ms: pos });
        }
    }

    fn host_pause(&mut self) {
        if !self.is_host {
            return;
        }
        let pos = self
            .player
            .as_ref()
            .and_then(|m| m.time_pos_ms().ok())
            .unwrap_or(0.0);
        if let Some(p) = &self.player {
            let _ = p.set_pause(true);
        }
        if let Some(sync) = &self.sync {
            sync.send(ClientMessage::Pause { position_ms: pos });
        }
    }

    fn pick_and_stream(&mut self) {
        if !self.is_host || self.busy {
            return;
        }
        let path = rfd::FileDialog::new()
            .set_title("Video to stream")
            .add_filter("Video", &["mp4", "webm", "mkv", "mov", "m4v", "avi", "ts"])
            .pick_file();
        let Some(path) = path else { return };
        let port: u16 = self.port.trim().parse().unwrap_or(8765);
        let (tx, rx) = mpsc::channel();
        if self
            .cmd_tx
            .send(WorkerCmd::StartFile {
                path,
                port,
                upnp: self.use_upnp,
                reply: tx,
            })
            .is_err()
        {
            self.error = Some("worker dead".into());
            return;
        }
        self.busy = true;
        self.status = "Starting file server…".into();
        self.pending_file = Some(rx);
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll();
        if self.busy || self.sync.is_some() {
            ctx.request_repaint_after(Duration::from_millis(200));
        }

        egui::CentralPanel::default().show(ctx, |ui| match self.screen {
            Screen::Home => self.ui_home(ui, ctx),
            Screen::Room => self.ui_room(ui, ctx),
        });
    }
}

impl App {
    fn ui_home(&mut self, ui: &mut egui::Ui, _ctx: &egui::Context) {
        ui.add_space(8.0);
        ui.heading(RichText::new("VidSync").strong().size(28.0));
        ui.label(
            RichText::new("Desktop watch party — no browser, no extension")
                .color(Color32::from_rgb(140, 145, 160)),
        );
        ui.add_space(12.0);
        ui.separator();
        ui.add_space(10.0);

        ui.horizontal(|ui| {
            ui.label("Nickname");
            ui.add(
                egui::TextEdit::singleline(&mut self.nick)
                    .desired_width(180.0)
                    .interactive(!self.busy),
            );
        });
        ui.horizontal(|ui| {
            ui.label("API");
            ui.add(
                egui::TextEdit::singleline(&mut self.api_base)
                    .desired_width(320.0)
                    .interactive(!self.busy),
            );
        });

        ui.add_space(14.0);
        ui.horizontal(|ui| {
            if ui
                .add_enabled(
                    !self.busy && !self.nick.trim().is_empty(),
                    egui::Button::new(RichText::new("Create room").strong())
                        .min_size(Vec2::new(130.0, 32.0))
                        .fill(Color32::from_rgb(46, 160, 120)),
                )
                .clicked()
            {
                let (tx, rx) = mpsc::channel();
                let _ = self.cmd_tx.send(WorkerCmd::Create {
                    api: self.api_base.clone(),
                    nick: self.nick.trim().to_string(),
                    reply: tx,
                });
                self.busy = true;
                self.status = "Creating room…".into();
                self.error = None;
                self.pending_create = Some(rx);
            }
        });

        ui.add_space(16.0);
        ui.label(RichText::new("Or join").strong());
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut self.join_code)
                    .desired_width(120.0)
                    .hint_text("ROOMCODE")
                    .interactive(!self.busy),
            );
            if ui
                .add_enabled(
                    !self.busy
                        && !self.nick.trim().is_empty()
                        && self.join_code.trim().len() >= 6,
                    egui::Button::new("Join").min_size(Vec2::new(80.0, 28.0)),
                )
                .clicked()
            {
                let code = self.join_code.trim().to_uppercase();
                self.room_code = Some(code.clone());
                let (tx, rx) = mpsc::channel();
                let _ = self.cmd_tx.send(WorkerCmd::Join {
                    api: self.api_base.clone(),
                    code,
                    nick: self.nick.trim().to_string(),
                    reply: tx,
                });
                self.busy = true;
                self.status = "Joining…".into();
                self.error = None;
                self.pending_join = Some(rx);
            }
        });

        ui.add_space(16.0);
        ui.label(
            RichText::new(
                "Player uses the system WebView (WebView2 / WKWebView / WebKit) — no extra downloads.",
            )
            .small()
            .color(Color32::from_rgb(140, 145, 160)),
        );

        ui.add_space(10.0);
        ui.label(
            RichText::new(&self.status)
                .color(Color32::from_rgb(110, 200, 160))
                .small(),
        );
        if let Some(e) = &self.error {
            ui.colored_label(Color32::from_rgb(230, 100, 100), e);
        }
    }

    fn ui_room(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let code = self.room_code.clone().unwrap_or_else(|| "????????".into());
        ui.horizontal(|ui| {
            ui.heading(RichText::new(format!("Room {code}")).strong());
            if self.is_host {
                ui.label(
                    RichText::new("HOST")
                        .small()
                        .color(Color32::from_rgb(46, 160, 120)),
                );
            } else {
                ui.label(
                    RichText::new("viewer")
                        .small()
                        .color(Color32::from_rgb(140, 145, 160)),
                );
            }
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Leave").clicked() {
                    self.leave_room();
                }
                let copy_label = if self
                    .copied_flash
                    .is_some_and(|t| t.elapsed().as_secs_f32() < 1.2)
                {
                    "Copied!"
                } else {
                    "Copy code"
                };
                if ui.button(copy_label).clicked() {
                    self.copy_text(ctx, &code);
                }
            });
        });
        ui.separator();

        egui::SidePanel::right("side")
            .resizable(true)
            .default_width(260.0)
            .show_inside(ui, |ui| {
                ui.label(RichText::new("In room").strong());
                for m in &self.members {
                    let tag = if m.is_host { " (host)" } else { "" };
                    let you = self
                        .session_id
                        .as_ref()
                        .map(|s| s == &m.session_id)
                        .unwrap_or(false);
                    ui.label(format!(
                        "• {}{}{}",
                        m.nickname,
                        tag,
                        if you { " ★" } else { "" }
                    ));
                }
                ui.add_space(8.0);
                ui.label(RichText::new("Queue").strong());
                if let Some(pb) = &self.playback {
                    if pb.queue.is_empty() {
                        ui.label(
                            RichText::new("Empty — host streams a file")
                                .small()
                                .color(Color32::from_rgb(140, 145, 160)),
                        );
                    }
                    for (i, u) in pb.queue.iter().enumerate() {
                        let active = pb.queue_index.map(|q| q as usize) == Some(i);
                        let short = if u.len() > 40 {
                            format!("{}…", &u[..40])
                        } else {
                            u.clone()
                        };
                        ui.label(
                            RichText::new(format!("{} {}", if active { "▶" } else { "·" }, short))
                                .small()
                                .monospace(),
                        );
                    }
                }
                ui.add_space(8.0);
                ui.label(RichText::new("Chat").strong());
                egui::ScrollArea::vertical()
                    .max_height(140.0)
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        for line in &self.chat_lines {
                            ui.label(RichText::new(line).small());
                        }
                    });
                ui.horizontal(|ui| {
                    let resp = ui.add(
                        egui::TextEdit::singleline(&mut self.chat_draft)
                            .desired_width(160.0)
                            .hint_text("Message…"),
                    );
                    if (ui.button("Send").clicked()
                        || (resp.lost_focus()
                            && ui.input(|i| i.key_pressed(egui::Key::Enter))))
                        && !self.chat_draft.trim().is_empty()
                    {
                        if let Some(sync) = &self.sync {
                            sync.send(ClientMessage::Chat {
                                text: self.chat_draft.trim().to_string(),
                            });
                        }
                        self.chat_draft.clear();
                    }
                });
            });

        ui.label(RichText::new("Playback").strong());
        if let Some(pb) = &self.playback {
            let url = pb.video_url.as_deref().unwrap_or("(no media)");
            ui.label(RichText::new(url).small().monospace());
            ui.label(
                RichText::new(format!(
                    "{} · {:.1}s · v{}",
                    if pb.is_playing { "Playing" } else { "Paused" },
                    pb.position_ms / 1000.0,
                    pb.version
                ))
                .small()
                .color(Color32::from_rgb(140, 145, 160)),
            );
        }

        ui.add_space(8.0);
        if self.is_host {
            ui.horizontal(|ui| {
                ui.label("Port");
                ui.add(
                    egui::TextEdit::singleline(&mut self.port)
                        .desired_width(60.0)
                        .interactive(self.serve.is_none() && !self.busy),
                );
                ui.checkbox(&mut self.use_upnp, "UPnP");
            });
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new(RichText::new("Stream local file…").strong())
                            .fill(Color32::from_rgb(46, 160, 120))
                            .min_size(Vec2::new(150.0, 28.0)),
                    )
                    .clicked()
                {
                    self.pick_and_stream();
                }
                if ui
                    .add_enabled(!self.busy, egui::Button::new("Play"))
                    .clicked()
                {
                    self.host_play();
                }
                if ui
                    .add_enabled(!self.busy, egui::Button::new("Pause"))
                    .clicked()
                {
                    self.host_pause();
                }
                if ui.button("Show player").clicked() {
                    self.ensure_player();
                }
            });
        } else {
            ui.label(
                RichText::new("Host controls playback. Video opens in the player window.")
                    .small()
                    .color(Color32::from_rgb(140, 145, 160)),
            );
            if ui.button("Show player").clicked() {
                self.ensure_player();
                if let Some(pb) = &self.playback {
                    if let Some(url) = &pb.video_url {
                        if let Some(p) = &self.player {
                            let pos = expected_position_ms(pb, self.now_server_ms());
                            let _ = p.load_url(url);
                            let _ = p.seek_seconds(pos / 1000.0);
                            let _ = p.set_pause(!pb.is_playing);
                        }
                    }
                }
            }
        }

        if let Some(url) = self.stream_url.clone() {
            ui.add_space(6.0);
            ui.label(RichText::new("Your stream URL").strong().small());
            ui.horizontal(|ui| {
                ui.add(
                    egui::TextEdit::singleline(&mut url.clone())
                        .desired_width(ui.available_width() - 70.0)
                        .font(egui::TextStyle::Monospace),
                );
                if ui.button("Copy URL").clicked() {
                    self.copy_text(ctx, &url);
                }
            });
        }

        ui.add_space(10.0);
        ui.label(
            RichText::new(&self.status)
                .color(Color32::from_rgb(110, 200, 160))
                .small(),
        );
        if let Some(e) = &self.error {
            ui.colored_label(Color32::from_rgb(230, 100, 100), e);
        }
    }
}
