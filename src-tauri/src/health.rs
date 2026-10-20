//! Preflight checks: before a download is attempted, verify the engine and its
//! siblings actually exist so the UI can complain with specifics instead of
//! failing mid-download (or crashing).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentHealth {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    pub ok: bool,
    pub components: Vec<ComponentHealth>,
}

impl HealthReport {
    pub fn from_components(components: Vec<ComponentHealth>) -> Self {
        let ok = components.iter().all(|c| c.ok);
        Self { ok, components }
    }
}

/// Platform binary name with the right extension.
pub fn binary_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// A file that exists and can actually be executed.
pub fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Locate a binary by scanning PATH entries (first match wins).
pub fn find_on_path(path_var: &OsStr, names: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable_file(candidate))
}

pub fn component(name: &str, path: &Path) -> ComponentHealth {
    if is_executable_file(path) {
        ComponentHealth {
            name: name.to_string(),
            ok: true,
            detail: path.display().to_string(),
        }
    } else {
        ComponentHealth {
            name: name.to_string(),
            ok: false,
            detail: format!("missing or not executable: {}", path.display()),
        }
    }
}

/// Engine + siblings in a bundled directory (ffmpeg/ffprobe/deno).
pub fn bundled_components(engine_path: &Path, engine_dir: &Path) -> Vec<ComponentHealth> {
    let mut out = vec![component("yt-dlp", engine_path)];
    for base in ["ffmpeg", "ffprobe", "deno"] {
        out.push(component(base, &engine_dir.join(binary_name(base))));
    }
    out
}

/// PATH-resolved dev fallback: verify names via PATH instead of a directory.
pub fn path_components(path_var: &OsStr) -> Vec<ComponentHealth> {
    ["yt-dlp", "ffmpeg", "ffprobe", "deno"]
        .into_iter()
        .map(|base| {
            let name = binary_name(base);
            match find_on_path(path_var, &[&name]) {
                Some(found) => ComponentHealth {
                    name: base.to_string(),
                    ok: true,
                    detail: found.display().to_string(),
                },
                None => ComponentHealth {
                    name: base.to_string(),
                    ok: false,
                    detail: format!("{name} not found on PATH"),
                },
            }
        })
        .collect()
}

/// yt-dlp's `--version` output is a date-like tag, e.g. "2026.10.10.233141".
/// Anything else (deno, ffmpeg, a half-written script) must be rejected as
/// the engine, not just "file exists".
pub fn looks_like_ytdlp(version_output: &str) -> bool {
    let first = version_output.lines().next().unwrap_or("").trim();
    let mut parts = first.split('.');
    let year = parts.next().unwrap_or("");
    let (Some(month), Some(day)) = (parts.next(), parts.next()) else {
        return false;
    };
    year.len() == 4
        && year.chars().all(|c| c.is_ascii_digit())
        && month.chars().all(|c| c.is_ascii_digit())
        && day.chars().all(|c| c.is_ascii_digit())
        && !month.is_empty()
        && !day.is_empty()
}

/// Run `<engine> --version` with a hard timeout (a wrong binary may hang).
/// Returns the trimmed stdout on success.
pub fn probe_engine_version(path: &Path, timeout: std::time::Duration) -> Option<String> {
    let mut child = std::process::Command::new(path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let out = child.wait_with_output().ok()?;
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return (!text.is_empty()).then_some(text);
            }
            Ok(Some(_)) => return None,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Err(_) => return None,
        }
    }
}

/// Full report for the resolved engine: binary presence + identity probe.
/// A file that merely exists and is executable (deno, ffmpeg, a stub script)
/// must not pass as yt-dlp.
pub fn verified_engine_components(
    engine_path: &Path,
    engine_dir: Option<&Path>,
) -> Vec<ComponentHealth> {
    let mut comps = match engine_dir {
        Some(dir) => bundled_components(engine_path, dir),
        None => path_components(&std::env::var_os("PATH").unwrap_or_default()),
    };
    let probe = probe_engine_version(engine_path, std::time::Duration::from_secs(3));
    if let Some(engine) = comps.iter_mut().find(|c| c.name == "yt-dlp") {
        match probe {
            Some(v) if looks_like_ytdlp(&v) => {
                engine.ok = true;
                engine.detail = v;
            }
            Some(v) => {
                engine.ok = false;
                engine.detail = format!("not yt-dlp (reported: {v})");
            }
            None => {
                engine.ok = false;
                engine.detail =
                    format!("engine did not answer --version: {}", engine_path.display());
            }
        }
    }
    comps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ytui_health_{}_{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn make_exec(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, b"#!/bin/sh\n").unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(not(unix))]
    fn make_exec(path: &Path) {
        std::fs::write(path, b"stub").unwrap();
    }

    #[test]
    fn missing_binary_is_flagged() {
        let c = component("yt-dlp", &temp_dir("missing").join("nope"));
        assert!(!c.ok);
        assert!(c.detail.contains("missing"));
    }

    #[test]
    fn executable_binary_passes() {
        let dir = temp_dir("exec");
        let p = dir.join(binary_name("yt-dlp"));
        make_exec(&p);
        assert!(is_executable_file(&p));
        let c = component("yt-dlp", &p);
        assert!(c.ok, "expected ok, detail={}", c.detail);
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_flagged() {
        let dir = temp_dir("noexec");
        let p = dir.join("yt-dlp");
        std::fs::write(&p, b"data").unwrap();
        assert!(!is_executable_file(&p));
    }

    #[test]
    fn find_on_path_scans_entries() {
        let dir = temp_dir("pathscan");
        let exe = dir.join(binary_name("ffmpeg"));
        make_exec(&exe);
        // include a nonexistent dir first to prove scanning continues
        let path_var =
            std::env::join_paths([PathBuf::from("/nonexistent/ytui"), dir.clone()]).unwrap();
        let found = find_on_path(&path_var, &[binary_name("ffmpeg").as_str()]).unwrap();
        assert_eq!(found, exe);
    }

    #[test]
    fn path_components_flag_missing_names() {
        let dir = temp_dir("pathextras");
        make_exec(&dir.join(binary_name("yt-dlp")));
        let path_var = std::env::join_paths([&dir]).unwrap();
        let comps = path_components(&path_var);
        let ytdlp = comps.iter().find(|c| c.name == "yt-dlp").unwrap();
        assert!(ytdlp.ok);
        let deno = comps.iter().find(|c| c.name == "deno").unwrap();
        assert!(!deno.ok, "deno should be reported missing");
    }

    #[test]
    fn report_is_ok_only_when_every_component_is() {
        let good = ComponentHealth {
            name: "a".into(),
            ok: true,
            detail: String::new(),
        };
        let bad = ComponentHealth {
            name: "b".into(),
            ok: false,
            detail: "nope".into(),
        };
        assert!(HealthReport::from_components(vec![good.clone()]).ok);
        assert!(!HealthReport::from_components(vec![good, bad]).ok);
    }

    #[test]
    fn bundled_components_expect_siblings_next_to_engine() {
        let dir = temp_dir("bundled");
        make_exec(&dir.join(binary_name("yt-dlp")));
        make_exec(&dir.join(binary_name("ffmpeg")));
        // ffprobe/deno intentionally absent
        let comps = bundled_components(&dir.join(binary_name("yt-dlp")), &dir);
        assert!(comps.iter().find(|c| c.name == "ffmpeg").unwrap().ok);
        assert!(!comps.iter().find(|c| c.name == "deno").unwrap().ok);
    }

    #[test]
    fn recognizes_ytdlp_version_output() {
        assert!(looks_like_ytdlp("2026.10.10.233141"));
        assert!(looks_like_ytdlp("2026.10.10.233141\n"));
        assert!(!looks_like_ytdlp("deno 2.9.7"));
        assert!(!looks_like_ytdlp("ffmpeg version N-127654"));
        assert!(!looks_like_ytdlp(""));
    }

    #[cfg(unix)]
    fn fake_engine(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("engine_under_test");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
        p
    }

    #[cfg(unix)]
    #[test]
    fn probe_reads_version_from_engine() {
        let dir = temp_dir("probe_ok");
        let engine = fake_engine(&dir, "echo 2026.10.10.233141");
        let v = probe_engine_version(&engine, std::time::Duration::from_secs(2)).unwrap();
        assert_eq!(v, "2026.10.10.233141");
    }

    #[cfg(unix)]
    #[test]
    fn probe_times_out_on_hanging_binary() {
        let dir = temp_dir("probe_hang");
        let engine = fake_engine(&dir, "sleep 10");
        let v = probe_engine_version(&engine, std::time::Duration::from_millis(150));
        assert_eq!(v, None);
    }

    #[cfg(unix)]
    #[test]
    fn deno_selected_as_engine_is_flagged_not_ytdlp() {
        let dir = temp_dir("deno_as_engine");
        let engine = fake_engine(&dir, "echo 'deno 2.9.7'");
        make_exec(&dir.join(binary_name("ffmpeg")));
        let comps = verified_engine_components(&engine, Some(&dir));
        let ytdlp = comps.iter().find(|c| c.name == "yt-dlp").unwrap();
        assert!(!ytdlp.ok, "deno must not pass as the engine");
        assert!(ytdlp.detail.contains("deno"), "detail was {}", ytdlp.detail);
    }

    #[cfg(unix)]
    #[test]
    fn real_ytdlp_override_passes_verification() {
        let dir = temp_dir("real_engine");
        let engine = fake_engine(&dir, "echo 2026.10.10.233141");
        make_exec(&dir.join(binary_name("ffmpeg")));
        make_exec(&dir.join(binary_name("ffprobe")));
        make_exec(&dir.join(binary_name("deno")));
        let comps = verified_engine_components(&engine, Some(&dir));
        assert!(comps.iter().all(|c| c.ok), "got {:?}", comps);
    }
}
