// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    linux_compat::apply();

    vidsync_desktop_lib::run()
}

/// WebKitGTK + NVIDIA/Wayland workarounds (Tauri docs / tauri#9394).
/// Must run before the webview is created.
#[cfg(target_os = "linux")]
mod linux_compat {
    use std::env;

    pub fn apply() {
        // DMABUF path dies on many NVIDIA + recent WebKitGTK setups (blank window,
        // Error 71 on Wayland, crash on resize). User can override by exporting
        // WEBKIT_DISABLE_DMABUF_RENDERER=0 before launch.
        set_default("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

        // NVIDIA explicit sync ↔ Wayland protocol error 71.
        set_default("__NV_DISABLE_EXPLICIT_SYNC", "1");

        // Optional nuclear options (off by default; set in shell if still broken):
        //   WEBKIT_DISABLE_COMPOSITING_MODE=1
        //   GDK_BACKEND=x11
        //   VIDSYNC_FORCE_X11=1  → we set GDK_BACKEND=x11 for you
        if env::var_os("VIDSYNC_FORCE_X11").is_some() {
            set_default("GDK_BACKEND", "x11");
        }

        // AppImage often lacks a sane cwd; keep relative asset paths stable.
        if let Ok(exe) = env::current_exe() {
            if let Some(dir) = exe.parent() {
                let _ = env::set_current_dir(dir);
            }
        }
    }

    fn set_default(key: &str, value: &str) {
        if env::var_os(key).is_none() {
            // SAFETY: single-threaded before any other threads / webview init.
            unsafe { env::set_var(key, value) };
        }
    }
}
