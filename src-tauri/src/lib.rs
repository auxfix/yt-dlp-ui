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
mod engine;
mod history;
mod settings;
mod updater;

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

fn engine_file_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn current_engine(app: &AppHandle) -> engine::EngineOrigin {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    engine::resolve_engine(engine::EngineSources {
        user_engine: Some(data_dir.join(engine_file_name())),
        bundled_engine: app
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("engine").join(engine_file_name())),
        fallback: "yt-dlp".to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineInfo {
    version: Option<String>,
    origin: String,
}

#[tauri::command]
fn engine_version(app: AppHandle) -> EngineInfo {
    use std::process::Stdio;
    let engine = current_engine(&app);
    let mut invocation = match &engine {
        engine::EngineOrigin::User(p) => std::process::Command::new(p),
        engine::EngineOrigin::Bundled(p) => std::process::Command::new(p),
        engine::EngineOrigin::Path(s) => std::process::Command::new(s),
    };
    invocation.arg("--version").stdout(Stdio::piped());
    let version = invocation
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|v| !v.is_empty());
    let origin = match engine {
        engine::EngineOrigin::User(_) => "user",
        engine::EngineOrigin::Bundled(_) => "bundled",
        engine::EngineOrigin::Path(_) => "path",
    };
    EngineInfo {
        version,
        origin: origin.to_string(),
    }
}

#[tauri::command(async)]
fn update_engine(app: AppHandle) -> Result<String, String> {
    let os = if cfg!(windows) { "windows" } else { "linux" };
    let json = reqwest::blocking::Client::builder()
        .user_agent("yt-ui")
        .build()
        .map_err(|e| e.to_string())?
        .get(updater::latest_url())
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .text()
        .map_err(|e| e.to_string())?;
    let pick = updater::pick_asset(&json, os).ok_or("no asset for this OS")?;
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let dest = data_dir.join(engine_file_name());
    updater::download_to_file(&pick.url, &dest)?;
    Ok(pick.tag)
}

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
            // long robot-wall text pollutes the history list; truncate
            const TRUNC: usize = 80;
            let fallback = if ok || message.is_empty() {
                url.to_string()
            } else {
                message.chars().take(TRUNC).collect::<String>()
            };
            fallback
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
    let engine_override = settings
        .engine_path
        .clone()
        .filter(|p| !p.trim().is_empty())
        .map(std::path::PathBuf::from);
    let engine_path = engine_override.or_else(|| match current_engine(&app) {
        engine::EngineOrigin::User(p) => Some(p),
        engine::EngineOrigin::Bundled(p) => Some(p),
        engine::EngineOrigin::Path(_) => None,
    });
    let engine_dir = engine_path
        .as_ref()
        .and_then(|p| p.parent())
        .map(|p| p.to_string_lossy().to_string());
    let engine_path = engine_path.unwrap_or_else(|| std::path::PathBuf::from("yt-dlp"));
    let config = EngineConfig {
        engine_path,
        engine_dir,
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

        let mut cmd = std::process::Command::new(&config.engine_path);
        cmd.args(&args);
        // bundled siblings (ffmpeg/ffprobe/deno) must be findable by the
        // engine subprocesses; Tauri app bundles don't carry them on PATH
        if let Some(dir) = &config.engine_dir {
            let sep = if cfg!(windows) { ";" } else { ":" };
            let current = std::env::var_os("PATH").unwrap_or_default();
            let mut paths = vec![std::path::PathBuf::from(dir)];
            paths.extend(std::env::split_paths(&current));
            cmd.env(
                "PATH",
                std::env::join_paths(&paths)
                    .unwrap_or_else(|_| std::ffi::OsString::from(format!("{dir}{sep}"))),
            );
        }
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
                        stderr_tail: format!("could not start engine: {e}"),
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
            start_download,
            engine_version,
            update_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
