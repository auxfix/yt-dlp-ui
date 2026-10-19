//! Download history persistence: JSON of entries in app-data dir, newest
//! first, capped. Same path-injectable pattern as settings.

pub const HISTORY_MAX: usize = 200;

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub mode: String,
    pub ok: bool,
    pub ts: i64,
    pub file_path: Option<String>,
}

pub struct HistoryStore {
    path: std::path::PathBuf,
}

impl HistoryStore {
    pub fn new(path: &std::path::Path) -> Self {
        Self {
            path: path.to_path_buf(),
        }
    }

    fn read(&self) -> Vec<HistoryEntry> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn load(&self) -> Vec<HistoryEntry> {
        self.read()
    }

    pub fn append(&self, entry: &HistoryEntry) {
        let mut entries = self.read();
        entries.insert(0, entry.clone());
        entries.truncate(HISTORY_MAX);
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_vec(&entries) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        let p = dir.join(format!(
            "ytui_history_test_{}_{}.json",
            tag,
            std::process::id()
        ));
        std::fs::remove_file(&p).ok();
        p
    }

    fn entry(title: &str, ok: bool) -> HistoryEntry {
        HistoryEntry {
            url: "https://youtu.be/x".into(),
            title: title.into(),
            mode: "audio".into(),
            ok,
            ts: 1_760_800_000_000,
            file_path: Some("/media/music/song.mp3".into()),
        }
    }

    #[test]
    fn missing_file_loads_empty() {
        let store = HistoryStore::new(&temp_path("missing"));
        assert!(store.load().is_empty());
    }

    #[test]
    fn append_then_load_roundtrip() {
        let path = temp_path("roundtrip");
        let store = HistoryStore::new(&path);
        store.append(&entry("one", true));
        store.append(&entry("two", false));

        let entries = store.load();
        assert_eq!(entries.len(), 2);
        // newest first
        assert_eq!(entries[0].title, "two");
        assert_eq!(entries[1].title, "one");
        assert!(!entries[0].ok);
        assert!(entries[1].ok);
    }

    #[test]
    fn corrupt_file_loads_empty() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "not json").unwrap();
        let store = HistoryStore::new(&path);
        assert!(store.load().is_empty());
    }

    #[test]
    fn capped_at_max_entries() {
        let path = temp_path("cap");
        let store = HistoryStore::new(&path);
        for i in 0..(HISTORY_MAX + 10) {
            store.append(&entry(&i.to_string(), true));
        }
        let entries = store.load();
        assert_eq!(entries.len(), HISTORY_MAX);
        assert_eq!(entries[0].title, (HISTORY_MAX + 9).to_string());
    }
}
