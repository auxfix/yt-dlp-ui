use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use downloader::{
    build_args, classify_is_cookie_issue, parse_error_line, parse_final_file, parse_progress_line,
    run_engine, DownloadMode, EngineConfig,
};
use history::{HistoryEntry, HistoryStore};
use serde::Serialize;
use settings::{Settings, SettingsStore};
use tauri::{AppHandle, Emitter, Manager, State};

mod downloader;
mod history;
mod settings;

struct AppState {
    store: Mutex<SettingsStore>,
    running: Arc<AtomicBool>,
    history: Arc<HistoryStore>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum DownloadEvent {
    Started {
        url: String,
    },
    Progress {
        pct: f64,
        speed: Option<String>,
        eta: Option<String>,
    },
    Finished {
        ok: bool,
        message: String,
        stderr_tail: String,
        cookie_issue: bool,
    },
}

const EVENT: &str = "download-event";

fn file_title(file: Option<&str>) -> Option<String> {
    file.and_then(|f| {
        std::path::Path::new(f)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
    })
}

fn history_entry(
    url: &str,
    mode: &str,
    ok: bool,
    message: &str,
    file_path: Option<String>,
) -> HistoryEntry {
    HistoryEntry {
        url: url.to_string(),
        title: file_title(file_path.as_deref()).unwrap_or_else(|| {
            if ok || message.is_empty() {
                url.to_string()
            } else {
                format!("{message}")
            }
        }),
        mode: mode.to_string(),
        ok,
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        file_path,
    }
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.store.lock().unwrap().load()
}

#[tauri::command]
fn set_settings(state: State<AppState>, settings: Settings) {
    state.store.lock().unwrap().save(&settings);
}

#[tauri::command]
fn set_cookie_file(state: State<AppState>, path: String) {
    let store = state.store.lock().unwrap();
    // merge over current settings so save_path survives
    let mut current = store.load();
    current.cookie_file = Some(path);
    store.save(&current);
}

#[tauri::command]
fn get_history(state: State<AppState>) -> Vec<HistoryEntry> {
    state.history.load()
}

#[tauri::command]
fn start_download(
    app: AppHandle,
    state: State<AppState>,
    url: String,
    mode: String,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A download is already running".into());
    }

    let dmode = match mode.as_str() {
        "audio" => DownloadMode::Audio,
        "video" => DownloadMode::Video,
        _ => {
            state.running.store(false, Ordering::SeqCst);
            return Err(format!("unknown mode: {mode}"));
        }
    };
    let settings = state.store.lock().unwrap().load();
    let config = EngineConfig {
        engine_path: "yt-dlp".into(), // packaged sidecar resolution lands in milestone 5
        save_path: settings.save_path,
        cookie_file: settings.cookie_file,
    };
    let args = build_args(&config, &url, dmode);

    let app = app.clone();
    let running = state.running.clone();
    let history = state.history.clone();
    std::thread::spawn(move || {
        let _ = app.emit(EVENT, DownloadEvent::Started { url: url.clone() });
        let mut last_error: Option<String> = None;
        let mut final_file: Option<String> = None;

        let mut cmd = std::process::Command::new("yt-dlp");
        cmd.args(&args);
        let result = run_engine(&mut cmd, &mut |line| {
            if let Some(p) = parse_progress_line(line) {
                let _ = app.emit(
                    EVENT,
                    DownloadEvent::Progress {
                        pct: p.pct,
                        speed: p.speed,
                        eta: p.eta,
                    },
                );
            }
            if let Some(err) = parse_error_line(line) {
                last_error = Some(err);
            }
            if let Some(file) = parse_final_file(line) {
                final_file = Some(file);
            }
        });

        let handle = match result {
            Ok(r) => r,
            // spawn error: likely no engine on PATH yet (packaged in milestone 5)
            Err(e) => {
                running.store(false, Ordering::SeqCst);
                history.append(&history_entry(
                    &url,
                    &mode,
                    false,
                    "could not start engine",
                    None,
                ));
                let _ = app.emit(
                    EVENT,
                    DownloadEvent::Finished {
                        ok: false,
                        message: format!("could not start engine: {e}"),
                        stderr_tail: String::new(),
                        cookie_issue: false,
                    },
                );
                return;
            }
        };

        let message = if handle.ok {
            String::new()
        } else {
            last_error.unwrap_or_else(|| "download failed".to_string())
        };
        history.append(&history_entry(&url, &mode, handle.ok, &message, final_file));
        let _ = app.emit(
            EVENT,
            DownloadEvent::Finished {
                ok: handle.ok,
                message,
                cookie_issue: classify_is_cookie_issue(&handle.stderr_tail),
                stderr_tail: handle.stderr_tail,
            },
        );
        running.store(false, Ordering::SeqCst);
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let store = SettingsStore::new(&config_dir.join("settings.json"));
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            app.manage(AppState {
                store: Mutex::new(store),
                running: Arc::new(AtomicBool::new(false)),
                history: Arc::new(HistoryStore::new(&data_dir.join("history.json"))),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            set_cookie_file,
            get_history,
            start_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
