//! Engine binary resolution: prefer a newer engine downloaded into app-data
//! (nightly updater), then the bundled sidecar from resources, then bare
//! `yt-dlp` on PATH as a dev fallback.

use std::path::PathBuf;

#[derive(Debug, PartialEq)]
pub enum EngineOrigin {
    User(PathBuf),
    Bundled(PathBuf),
    Path(String),
}

pub struct EngineSources {
    pub user_engine: Option<PathBuf>,
    pub bundled_engine: Option<PathBuf>,
    pub fallback: String,
}

pub fn resolve_engine(sources: EngineSources) -> EngineOrigin {
    if let Some(user) = sources.user_engine.filter(|p| p.is_file()) {
        EngineOrigin::User(user)
    } else if let Some(bundled) = sources.bundled_engine.filter(|p| p.is_file()) {
        EngineOrigin::Bundled(bundled)
    } else {
        EngineOrigin::Path(sources.fallback)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mkfile(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, b"stub").unwrap();
        p
    }

    #[test]
    fn user_engine_wins_when_it_exists() {
        let user = mkfile(&std::env::temp_dir().join("ytui_res_user"), "yt-dlp");
        let bundled = mkfile(&std::env::temp_dir().join("ytui_res_bundled"), "yt-dlp");
        let resolved = resolve_engine(EngineSources {
            user_engine: Some(user.clone()),
            bundled_engine: Some(bundled),
            fallback: "yt-dlp".into(),
        });
        assert_eq!(resolved, EngineOrigin::User(user));
    }

    #[test]
    fn bundled_used_when_no_user_engine() {
        let bundled = mkfile(&std::env::temp_dir().join("ytui_res_bundled2"), "yt-dlp");
        let resolved = resolve_engine(EngineSources {
            user_engine: None,
            bundled_engine: Some(bundled.clone()),
            fallback: "yt-dlp".into(),
        });
        assert_eq!(resolved, EngineOrigin::Bundled(bundled));
    }

    #[test]
    fn missing_user_engine_falls_back_to_bundled() {
        let bundled = mkfile(&std::env::temp_dir().join("ytui_res_bundled3"), "yt-dlp");
        let resolved = resolve_engine(EngineSources {
            user_engine: Some(
                std::env::temp_dir()
                    .join("ytui_res_user_missing")
                    .join("yt-dlp"),
            ),
            bundled_engine: Some(bundled.clone()),
            fallback: "yt-dlp".into(),
        });
        assert_eq!(resolved, EngineOrigin::Bundled(bundled));
    }

    #[test]
    fn dev_fallback_is_path_lookup() {
        let resolved = resolve_engine(EngineSources {
            user_engine: None,
            bundled_engine: None,
            fallback: "yt-dlp".into(),
        });
        assert_eq!(resolved, EngineOrigin::Path("yt-dlp".into()));
    }
}
