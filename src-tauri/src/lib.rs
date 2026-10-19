use std::sync::Mutex;

use settings::{Settings, SettingsStore};
use tauri::{Manager, State};

mod settings;

struct AppState {
    store: Mutex<SettingsStore>,
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
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let store = SettingsStore::new(&config_dir.join("settings.json"));
            app.manage(AppState {
                store: Mutex::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_settings, set_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
