//! Minimal egui window: pick file, start/stop stream, copy URLs.

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;

use eframe::egui::{self, Color32, RichText, Vec2};
use tokio::runtime::Runtime;

use crate::ext;
use crate::session::{ServeOptions, ServeSession};

enum WorkerCmd {
    Start {
        opts: ServeOptions,
        reply: Sender<Result<Box<ServeSession>, String>>,
    },
    Stop {
        session: Box<ServeSession>,
        reply: Sender<()>,
    },
    InstallExt {
        reply: Sender<Result<String, String>>,
    },
}

pub fn run() -> eframe::Result<()> {
    let (cmd_tx, cmd_rx) = mpsc::channel::<WorkerCmd>();
    thread::spawn(move || worker_loop(cmd_rx));

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([520.0, 420.0])
            .with_min_inner_size([400.0, 320.0])
            .with_title("VidSync Host"),
        ..Default::default()
    };

    eframe::run_native(
        "VidSync Host",
        options,
        Box::new(|cc| {
            // Slightly denser UI
            cc.egui_ctx.set_pixels_per_point(1.1);
            Ok(Box::new(HostApp::new(cmd_tx)))
        }),
    )
}

fn worker_loop(rx: Receiver<WorkerCmd>) {
    let rt = Runtime::new().expect("tokio runtime");
    while let Ok(cmd) = rx.recv() {
        match cmd {
            WorkerCmd::Start { opts, reply } => {
                let res = rt
                    .block_on(ServeSession::start(opts))
                    .map(Box::new)
                    .map_err(|e| format!("{e:#}"));
                let _ = reply.send(res);
            }
            WorkerCmd::Stop { session, reply } => {
                rt.block_on(session.stop());
                let _ = reply.send(());
            }
            WorkerCmd::InstallExt { reply } => {
                let res = ext::install(None, true, false).map_err(|e| format!("{e:#}"));
                let _ = reply.send(res);
            }
        }
    }
}

struct HostApp {
    cmd_tx: Sender<WorkerCmd>,
    file: Option<PathBuf>,
    port: String,
    use_upnp: bool,
    busy: bool,
    status: String,
    error: Option<String>,
    lan_url: Option<String>,
    wan_url: Option<String>,
    session: Option<Box<ServeSession>>,
    pending: Option<Receiver<Result<Box<ServeSession>, String>>>,
    pending_stop: Option<Receiver<()>>,
    pending_ext: Option<Receiver<Result<String, String>>>,
}

impl HostApp {
    fn new(cmd_tx: Sender<WorkerCmd>) -> Self {
        Self {
            cmd_tx,
            file: None,
            port: "8765".into(),
            use_upnp: true,
            busy: false,
            status: "Pick a video file, then Start.".into(),
            error: None,
            lan_url: None,
            wan_url: None,
            session: None,
            pending: None,
            pending_stop: None,
            pending_ext: None,
        }
    }

    fn poll(&mut self) {
        if let Some(rx) = &self.pending {
            match rx.try_recv() {
                Ok(Ok(session)) => {
                    self.lan_url = Some(session.info.lan_url.clone());
                    self.wan_url = session.info.wan_url.clone();
                    self.status = format!(
                        "Streaming {} on port {}",
                        session.info.file_name, session.info.local_port
                    );
                    self.session = Some(session);
                    self.busy = false;
                    self.pending = None;
                    self.error = None;
                }
                Ok(Err(e)) => {
                    self.error = Some(e);
                    self.status = "Failed to start.".into();
                    self.busy = false;
                    self.pending = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.error = Some("worker died".into());
                    self.busy = false;
                    self.pending = None;
                }
            }
        }
        if let Some(rx) = &self.pending_stop {
            match rx.try_recv() {
                Ok(()) => {
                    self.session = None;
                    self.lan_url = None;
                    self.wan_url = None;
                    self.status = "Stopped. Pick a file and Start again.".into();
                    self.busy = false;
                    self.pending_stop = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.pending_stop = None;
                }
            }
        }
        if let Some(rx) = &self.pending_ext {
            match rx.try_recv() {
                Ok(Ok(msg)) => {
                    self.status = msg.lines().next().unwrap_or("Extension staged.").into();
                    self.busy = false;
                    self.pending_ext = None;
                    self.error = None;
                }
                Ok(Err(e)) => {
                    self.error = Some(e);
                    self.busy = false;
                    self.pending_ext = None;
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    self.busy = false;
                    self.pending_ext = None;
                }
            }
        }
    }

    fn pick_file(&mut self) {
        let picked = rfd::FileDialog::new()
            .set_title("Choose video to stream")
            .add_filter(
                "Video",
                &["mp4", "webm", "mkv", "mov", "m4v", "avi", "ts", "m3u8"],
            )
            .add_filter("All files", &["*"])
            .pick_file();
        if let Some(p) = picked {
            self.file = Some(p);
            self.error = None;
            if self.session.is_none() {
                self.status = "File selected. Hit Start stream.".into();
            }
        }
    }

    fn start_stream(&mut self) {
        if self.busy || self.session.is_some() {
            return;
        }
        let Some(file) = self.file.clone() else {
            self.error = Some("Pick a file first.".into());
            return;
        };
        let port: u16 = match self.port.trim().parse() {
            Ok(p) => p,
            Err(_) => {
                self.error = Some("Port must be 0–65535.".into());
                return;
            }
        };

        let opts = ServeOptions {
            file,
            port,
            bind: "0.0.0.0".into(),
            upnp: self.use_upnp,
            external_port: 0,
            lease_secs: 0,
            clipboard: true,
        };

        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .cmd_tx
            .send(WorkerCmd::Start {
                opts,
                reply: reply_tx,
            })
            .is_err()
        {
            self.error = Some("worker not running".into());
            return;
        }
        self.busy = true;
        self.status = if self.use_upnp {
            "Starting server + UPnP…".into()
        } else {
            "Starting server…".into()
        };
        self.error = None;
        self.pending = Some(reply_rx);
    }

    fn stop_stream(&mut self) {
        if self.busy {
            return;
        }
        let Some(session) = self.session.take() else {
            return;
        };
        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .cmd_tx
            .send(WorkerCmd::Stop {
                session,
                reply: reply_tx,
            })
            .is_err()
        {
            self.error = Some("worker not running".into());
            return;
        }
        self.busy = true;
        self.status = "Stopping…".into();
        self.pending_stop = Some(reply_rx);
    }

    fn install_ext(&mut self) {
        if self.busy {
            return;
        }
        let (reply_tx, reply_rx) = mpsc::channel();
        if self
            .cmd_tx
            .send(WorkerCmd::InstallExt { reply: reply_tx })
            .is_err()
        {
            self.error = Some("worker not running".into());
            return;
        }
        self.busy = true;
        self.status = "Installing / launching Unblock extension…".into();
        self.pending_ext = Some(reply_rx);
    }
}

impl eframe::App for HostApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.poll();
        if self.busy {
            ctx.request_repaint_after(std::time::Duration::from_millis(100));
        }

        egui::CentralPanel::default().show(ctx, |ui| {
            ui.add_space(6.0);
            ui.heading(RichText::new("VidSync Host").strong());
            ui.label(
                RichText::new("Serve a local file · optional UPnP · Unblock helper")
                    .color(Color32::from_rgb(140, 145, 160))
                    .small(),
            );
            ui.add_space(10.0);
            ui.separator();
            ui.add_space(8.0);

            // File row
            ui.label(RichText::new("File").strong());
            ui.horizontal(|ui| {
                let label = self
                    .file
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "No file selected".into());
                ui.add(
                    egui::Label::new(RichText::new(label).monospace().small())
                        .wrap()
                        .sense(egui::Sense::click()),
                );
            });
            ui.horizontal(|ui| {
                if ui
                    .add_enabled(!self.busy && self.session.is_none(), egui::Button::new("Browse…"))
                    .clicked()
                {
                    self.pick_file();
                }
                if self.session.is_some() {
                    ui.label(
                        RichText::new("Stop stream to change file")
                            .small()
                            .color(Color32::from_rgb(140, 145, 160)),
                    );
                }
            });

            ui.add_space(10.0);

            // Options
            ui.horizontal(|ui| {
                ui.label("Port");
                ui.add(
                    egui::TextEdit::singleline(&mut self.port)
                        .desired_width(72.0)
                        .interactive(!self.busy && self.session.is_none()),
                );
                ui.checkbox(&mut self.use_upnp, "UPnP port-forward").on_hover_text(
                    "Temporary router map so friends outside your LAN can reach the stream",
                );
            });

            ui.add_space(12.0);

            // Actions
            ui.horizontal(|ui| {
                let can_start = !self.busy && self.session.is_none() && self.file.is_some();
                if ui
                    .add_enabled(
                        can_start,
                        egui::Button::new(RichText::new("Start stream").strong())
                            .min_size(Vec2::new(120.0, 28.0)),
                    )
                    .clicked()
                {
                    self.start_stream();
                }
                if ui
                    .add_enabled(
                        !self.busy && self.session.is_some(),
                        egui::Button::new("Stop").min_size(Vec2::new(72.0, 28.0)),
                    )
                    .clicked()
                {
                    self.stop_stream();
                }
                if ui
                    .add_enabled(
                        !self.busy,
                        egui::Button::new("Install Unblock").min_size(Vec2::new(120.0, 28.0)),
                    )
                    .clicked()
                {
                    self.install_ext();
                }
            });

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(8.0);

            ui.label(RichText::new("Share URL").strong());
            if let Some(wan) = &self.wan_url {
                url_row(ui, "WAN (UPnP)", wan);
            }
            if let Some(lan) = &self.lan_url {
                url_row(ui, "LAN", lan);
            }
            if self.lan_url.is_none() && self.wan_url.is_none() {
                ui.label(
                    RichText::new("URLs appear here after Start.")
                        .color(Color32::from_rgb(140, 145, 160))
                        .small(),
                );
            }

            ui.add_space(10.0);
            ui.label(
                RichText::new(&self.status)
                    .color(Color32::from_rgb(110, 200, 160))
                    .small(),
            );
            if let Some(err) = &self.error {
                ui.colored_label(Color32::from_rgb(230, 100, 100), err);
            }

            ui.add_space(8.0);
            ui.label(
                RichText::new(
                    "Paste URL into the VidSync room queue, then Stream with Unblock.",
                )
                .color(Color32::from_rgb(140, 145, 160))
                .small(),
            );
        });
    }
}

fn url_row(ui: &mut egui::Ui, label: &str, url: &str) {
    ui.horizontal(|ui| {
        ui.label(RichText::new(label).small().color(Color32::from_rgb(140, 145, 160)));
        ui.add(
            egui::Label::new(RichText::new(url).monospace().small())
                .wrap()
                .sense(egui::Sense::click()),
        );
        if ui.small_button("Copy").clicked() {
            crate::session::try_clipboard(url);
        }
    });
}
