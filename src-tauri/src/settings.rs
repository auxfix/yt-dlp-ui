//! Settings persistence: JSON file of `{ save_path, cookie_file }` in the app
//! config dir. Store behavior is path-injectable so tests use a temp dir.

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub save_path: Option<String>,
    pub cookie_file: Option<String>,
    /// "none" | "chrome" | "file"; absent (legacy) behaves as chrome.
    #[serde(default)]
    pub cookie_mode: Option<String>,
    /// Manual engine-binary override; empty string means "auto chain".
    #[serde(default)]
    pub engine_path: Option<String>,
}

pub struct SettingsStore {
    path: std::path::PathBuf,
}

impl SettingsStore {
    pub fn new(path: &std::path::Path) -> Self {
        Self {
            path: path.to_path_buf(),
        }
    }

    pub fn load(&self) -> Settings {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &Settings) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec_pretty(settings) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let base = std::env::temp_dir();
        let dir = base.join(format!("ytui_settings_test_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("settings.json")
    }

    #[test]
    fn missing_file_loads_defaults() {
        let path = temp_dir("missing");
        let store = SettingsStore::new(&path);
        let s = store.load();
        assert_eq!(s.save_path, None);
        assert_eq!(s.cookie_file, None);
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = temp_dir("roundtrip");
        let store = SettingsStore::new(&path);
        let mut s = store.load();
        s.save_path = Some("/home/me/Music".into());
        s.cookie_file = Some("/home/me/cookies.txt".into());
        store.save(&s);

        let reloaded = SettingsStore::new(&path).load();
        assert_eq!(reloaded.save_path.as_deref(), Some("/home/me/Music"));
        assert_eq!(
            reloaded.cookie_file.as_deref(),
            Some("/home/me/cookies.txt")
        );
    }

    #[test]
    fn corrupt_file_loads_defaults() {
        let path = temp_dir("corrupt");
        std::fs::write(&path, "{not json").unwrap();
        let store = SettingsStore::new(&path);
        let s = store.load();
        assert_eq!(s.save_path, None);
        assert_eq!(s.cookie_file, None);
    }

    #[test]
    fn partial_file_backfills_missing_fields() {
        let path = temp_dir("partial");
        std::fs::write(&path, r#"{ "save_path": "/x" }"#).unwrap();
        let store = SettingsStore::new(&path);
        let s = store.load();
        assert_eq!(s.save_path.as_deref(), Some("/x"));
        assert_eq!(s.cookie_file, None);
    }

    #[test]
    fn engine_path_override_persists() {
        let path = temp_dir("engine_override");
        let store = SettingsStore::new(&path);
        let mut s = store.load();
        assert_eq!(s.engine_path, None);
        s.engine_path = Some("/opt/newest/yt-dlp".into());
        store.save(&s);
        let reloaded = SettingsStore::new(&path).load();
        assert_eq!(reloaded.engine_path.as_deref(), Some("/opt/newest/yt-dlp"));
    }

    #[test]
    fn cookie_mode_persists_and_defaults_to_chrome_semantics() {
        let path = temp_dir("cookie_mode");
        let store = SettingsStore::new(&path);
        let mut s = store.load();
        assert_eq!(s.cookie_mode, None); // caller treats None as chrome
        s.cookie_mode = Some("none".into());
        store.save(&s);
        let reloaded = SettingsStore::new(&path).load();
        assert_eq!(reloaded.cookie_mode.as_deref(), Some("none"));
    }
}
