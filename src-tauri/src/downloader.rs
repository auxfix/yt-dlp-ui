//! yt-dlp engine plumbing: arg building, `--newline` progress parsing, and
//! subprocess running. Pure pieces are unit-tested; the runner is exercised
//! against a fixture script, not a real yt-dlp.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Command;

pub static STDERR_TAIL_LIMIT: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DownloadMode {
    Audio,
    Video,
}

#[derive(Debug)]
pub struct EngineResult {
    pub ok: bool,
    pub stderr_tail: String,
}

/// Run the engine process: stream stdout AND stderr line-by-line into
/// `on_line` while it runs (slow retries must be visible, not silent),
/// capture the stderr tail, and report the exit status.
pub fn run_engine<F>(cmd: &mut Command, on_line: &mut F) -> std::io::Result<EngineResult>
where
    F: FnMut(&str) + Send,
{
    use std::process::Stdio;
    // freshly-written scripts can transiently refuse exec with ETXTBSY
    // (write-exclusion lingers a beat after fs::write returns); retry briefly
    let mut child = loop {
        match cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(child) => break child,
            Err(e) if e.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            Err(e) => return Err(e),
        }
    };

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // stderr reader and stdout reader both call the same parser; the lock is
    // held only for the callback, which is cheap (parse + emit)
    let shared = std::sync::Mutex::new(on_line);

    let (status, stderr_tail) = std::thread::scope(|scope| -> std::io::Result<_> {
        let stderr_handle = scope.spawn(|| {
            let mut tail = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut cb) = shared.lock() {
                    cb(&line);
                }
                tail.push_str(&line);
                tail.push('\n');
                let excess = tail.len().saturating_sub(STDERR_TAIL_LIMIT);
                if excess > 0 {
                    // trim on a char boundary; a byte cut mid-glyph panics
                    let mut excess = excess;
                    while excess < tail.len() && !tail.is_char_boundary(excess) {
                        excess += 1;
                    }
                    tail = tail[excess..].to_string();
                }
            }
            tail
        });

        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(mut cb) = shared.lock() {
                cb(&line);
            }
        }
        let status = child.wait()?;
        let tail = stderr_handle.join().unwrap_or_default();
        Ok((status, tail))
    })?;

    Ok(EngineResult {
        ok: status.success(),
        stderr_tail,
    })
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub engine_path: PathBuf,
    /// Directory holding the engine's siblings (ffmpeg, ffprobe, deno) when it
    /// came bundled; None when using fallback PATH engines.
    pub engine_dir: Option<String>,
    pub save_path: Option<String>,
    pub cookie_file: Option<String>,
    /// "none" | "chrome" | "file"; None behaves as "chrome" for back-compat.
    pub cookie_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub pct: f64,
    pub speed: Option<String>,
    pub eta: Option<String>,
}

/// Pull `pct`, `speed`, `eta` out of one yt-dlp `--newline` stdout line.
pub fn parse_progress_line(line: &str) -> Option<Progress> {
    let marker = line.find("[download]")?;
    let rest = &line[marker + "[download]".len()..];

    // e.g. "  45.2% of  10.34MiB at  5.60MiB/s ETA 00:02"
    let pct_pos = rest.find('%')?;
    let before = &rest[..pct_pos];
    let num_start = before
        .rfind(|c: char| c.is_ascii_digit() || c == '.')
        .map(|i| {
            let mut start = i;
            while start > 0
                && (before.as_bytes()[start - 1].is_ascii_digit()
                    || before.as_bytes()[start - 1] == b'.')
            {
                start -= 1;
            }
            start
        })?;
    let pct: f64 = rest[num_start..].split('%').next()?.parse().ok()?;

    let speed = rest
        .split(" at ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next().map(|s| s.to_string()));
    let eta = rest.split("ETA ").nth(1).map(|e| e.trim().to_string());

    Some(Progress {
        pct,
        speed: speed.filter(|s| s.ends_with("/s")),
        eta: eta.filter(|e| e.contains(':')),
    })
}

/// True when a failure stdout tail indicates a YouTube-cookie problem
/// (browser cookie reading failed, or the bot-check wall appeared).
pub fn classify_is_cookie_issue(stderr_tail: &str) -> bool {
    const MARKERS: [&str; 4] = [
        "could not copy chrome cookie database",
        "failed to decrypt",
        "unable to decrypt",
        "confirm you're not a bot",
    ];
    MARKERS
        .iter()
        .any(|m| stderr_tail.to_ascii_lowercase().contains(m))
}

/// Cookies are optional: when the chrome-cookie attempt fails for a
/// cookie-shaped reason, the download is retried once with no cookies at all
/// rather than surfacing a hard failure.
pub fn should_retry_without_cookies(used_chrome: bool, ok: bool, stderr_tail: &str) -> bool {
    used_chrome && !ok && classify_is_cookie_issue(stderr_tail)
}

/// Peel `ERROR: …` down to the human-readable message (bot-check text etc).
pub fn parse_error_line(line: &str) -> Option<String> {
    let mut msg = line.strip_prefix("ERROR: ")?.trim().to_string();
    if msg.starts_with('[')
        && let (Some(close), Some(open)) = (msg.find(']'), msg.find('['))
        && close > open
    {
        msg = msg[close + 1..].trim_start().to_string();
    }
    // Leftover per-video segment, e.g. "xyz: Sign in to confirm ..."
    if let Some(colon) = msg.find(": ") {
        let tail = msg[colon + 2..].to_string();
        if tail.contains(':') {
            // looks like a URL/time, not an identifier prefix — keep msg
        } else if !msg[..colon].contains(' ') {
            msg = tail;
        }
    }
    if msg.is_empty() {
        None
    } else {
        Some(msg)
    }
}

/// A lone path line with no `[prefix]` and one path-shaped thing on it is
/// what `--print after_move:filepath` emits — the final file on disk.
pub fn parse_final_file(line: &str) -> Option<String> {
    let t = line.trim();
    const NON_PATH: [&str; 3] = ["ERROR:", "WARNING", "Deprecated"];
    if t.is_empty() || t.starts_with('[') || NON_PATH.iter().any(|p| t.starts_with(p)) {
        return None;
    }
    Some(t.to_string())
}

/// Build the full argv for one download, per PLAN.md locked flags.
pub fn build_args(config: &EngineConfig, url: &str, mode: DownloadMode) -> Vec<String> {
    let mut args = vec![
        "--newline".to_string(),
        "--progress".to_string(),
        "--impersonate".to_string(),
        "chrome".to_string(),
        "--print".to_string(),
        "after_move:filepath".to_string(),
    ];
    if let Some(dir) = &config.engine_dir {
        // bundled ffmpeg/ffprobe/deno live next to the engine; Tauri resource
        // dirs are not on the PATH yt-dlp would search
        args.extend(["--ffmpeg-location".to_string(), dir.clone()]);
    }
    if let Some(file) = &config.cookie_file {
        args.extend(["--cookies".to_string(), file.clone()]);
    } else if config.cookie_mode.as_deref() != Some("none") {
        // default remains chrome (best bot-check resilience); "none" disables
        args.extend(["--cookies-from-browser".to_string(), "chrome".to_string()]);
    }
    if let Some(dir) = &config.save_path {
        args.extend(["-P".to_string(), dir.clone()]);
    }
    match mode {
        DownloadMode::Audio => args.extend([
            "-x".to_string(),
            "--audio-format".to_string(),
            "mp3".to_string(),
        ]),
        DownloadMode::Video => args.extend(["-S".to_string(), "res:1080".to_string()]),
    }
    args.push("--".to_string());
    args.push(url.to_string());
    args
}

#[cfg(test)]
mod final_file_tests {
    use super::*;

    fn config() -> EngineConfig {
        EngineConfig {
            engine_path: PathBuf::from("/fake/engine"),
            engine_dir: None,
            save_path: None,
            cookie_file: None,
            cookie_mode: None,
        }
    }

    #[test]
    fn args_ask_for_final_filepath() {
        let args = build_args(&config(), "u", DownloadMode::Audio);
        let i = args.iter().position(|a| a == "--print").unwrap();
        assert_eq!(args[i + 1], "after_move:filepath");
    }

    #[test]
    fn lone_path_line_is_final_file() {
        assert_eq!(
            parse_final_file("/media/music/song.mp3"),
            Some("/media/music/song.mp3".to_string())
        );
    }

    #[test]
    fn engine_lines_are_not_final_file() {
        assert_eq!(parse_final_file("[download] Destination: /a/b.mp4"), None);
        assert_eq!(parse_final_file(""), None);
        assert_eq!(parse_final_file("[youtube] abc: fetching"), None);
        assert_eq!(parse_final_file("ERROR: Sign in to confirm"), None);
        assert_eq!(
            parse_final_file("WARNING: [youtube] Read timed out, retrying"),
            None
        );
    }
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_percent_speed_and_eta() {
        let p =
            parse_progress_line("[download]  45.2% of  10.34MiB at  5.60MiB/s ETA 00:02").unwrap();
        assert_eq!(p.pct, 45.2);
        assert_eq!(p.speed.as_deref(), Some("5.60MiB/s"));
        assert_eq!(p.eta.as_deref(), Some("00:02"));
    }

    #[test]
    fn parses_final_line_without_speed_or_eta() {
        let p = parse_progress_line("[download] 100% of   10.34MiB in 00:03").unwrap();
        assert_eq!(p.pct, 100.0);
        assert!(p.speed.is_none());
        assert!(p.eta.is_none());
    }

    #[test]
    fn ignores_unrelated_lines() {
        assert!(parse_progress_line("[download] Destination: out.mp4").is_none());
        assert!(parse_progress_line("ERROR: something broke").is_none());
        assert!(parse_progress_line("").is_none());
    }

    #[test]
    fn extracts_error_message() {
        let msg = parse_error_line("ERROR: [youtube] xyz: Sign in to confirm you're not a bot");
        assert_eq!(msg, Some("Sign in to confirm you're not a bot".to_string()));
        assert!(parse_error_line("[download] normal line").is_none());
    }
}

#[cfg(test)]
mod runner_tests {
    use super::*;

    fn fixture_script(body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir();
        let script = dir.join(format!(
            "ytui_engine_fixture_{}_{}_{}",
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            body.len(),
            std::process::id()
        ));
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        script
    }

    #[test]
    fn collects_lines_and_success() {
        let script = fixture_script(
            "printf '[download]  1.0%% of 1MB\\n[download] 100%% of 1MB\\n'; echo err >&2",
        );
        let mut lines = Vec::new();
        let result = run_engine(&mut Command::new(&script), &mut |line| {
            lines.push(line.to_string())
        })
        .unwrap();
        assert_eq!(lines.len(), 3); // 2 stdout + stderr fed to callback too
        // stdout/stderr interleave freely now (live streaming); only the
        // relative order within one stream is guaranteed
        let download_lines: Vec<&String> =
            lines.iter().filter(|l| l.starts_with("[download]")).collect();
        assert_eq!(download_lines.len(), 2);
        assert!(download_lines[0].contains("1.0%"));
        assert!(download_lines[1].contains("100%"));
        assert!(lines.iter().any(|l| l == "err"));
        assert!(result.ok);
        assert!(result.stderr_tail.contains("err"));
    }

    #[test]
    fn failure_status_and_stderr_captured() {
        let script = fixture_script("printf 'partial'; echo 'ERROR: bot' >&2; exit 1");
        let mut got = Vec::new();
        let result = run_engine(&mut Command::new(&script), &mut |line| {
            got.push(line.to_string())
        })
        .unwrap();
        assert!(!result.ok);
        assert!(got.contains(&"partial".to_string()));
        assert!(got.iter().any(|l| l.contains("ERROR: bot")));
        assert!(result.stderr_tail.contains("ERROR: bot"));
    }

    #[test]
    fn spawn_failure_is_reported() {
        let result = run_engine(&mut Command::new("/nonexistent/yt-dlp"), &mut |_| {});
        assert!(result.is_err());
    }

    #[test]
    fn stderr_lines_reach_the_line_callback() {
        // yt-dlp puts ERROR: text on stderr; the parser must see it
        let script = fixture_script("echo 'ERROR: Sign in to confirm' >&2");
        let mut lines = Vec::new();
        let result = run_engine(&mut Command::new(&script), &mut |line| {
            lines.push(line.to_string())
        })
        .unwrap();
        assert!(result.ok);
        assert!(
            lines.iter().any(|l| l.contains("Sign in to confirm")),
            "stderr lines must reach the callback, got {:?}",
            lines
        );
    }

    #[test]
    fn stderr_streams_live_before_child_exits() {
        // a warning emitted mid-run must surface before the final stdout line,
        // otherwise the UI sits silent during slow YouTube retries
        let script = fixture_script(
            "echo 'WARNING: Read timed out, retrying' >&2; sleep 0.3; echo 'late-stdout'",
        );
        let mut lines = Vec::new();
        run_engine(&mut Command::new(&script), &mut |line| {
            lines.push(line.to_string())
        })
        .unwrap();
        let warn = lines
            .iter()
            .position(|l| l.contains("Read timed out"))
            .unwrap();
        let late = lines.iter().position(|l| l == "late-stdout").unwrap();
        assert!(warn < late, "stderr must stream live, got {:?}", lines);
    }

    #[test]
    fn multibyte_stderr_tail_does_not_panic() {
        // Cyrillic (2-byte chars) crossing the tail limit must not slice a
        // UTF-8 boundary when trimming
        let script = fixture_script("\ni=0; while [ $i -lt 4000 ]; do printf '\u{e6fc}\u{0935}'; i=$((i+1)); done >&2; echo done >&2; echo handled >&2");
        let result = run_engine(&mut Command::new(&script), &mut |_| {});
        assert!(result.is_ok() && result.unwrap().ok);
    }
}

#[cfg(test)]
mod classify_tests {
    use super::*;

    #[test]
    fn chrome_cookie_db_copy_failure_is_cookie_issue() {
        assert!(classify_is_cookie_issue(
            "ERROR: could not copy chrome cookie database: database is locked"
        ));
    }

    #[test]
    fn decryption_failure_is_cookie_issue() {
        assert!(classify_is_cookie_issue(
            "ERROR: [youtube] abc: failed to decrypt with DPAPI: unable to determine "
        ));
    }

    #[test]
    fn bot_check_is_cookie_issue() {
        assert!(classify_is_cookie_issue(
            "Sign in to confirm you're not a bot"
        ));
    }

    #[test]
    fn generic_http_error_is_not() {
        assert!(!classify_is_cookie_issue(
            "ERROR: HTTP Error 404: Not Found"
        ));
        assert!(!classify_is_cookie_issue(""));
    }
}

#[cfg(test)]
mod args_tests {
    use super::*;

    fn config(save: Option<&str>, cookie: Option<&str>) -> EngineConfig {
        EngineConfig {
            engine_path: PathBuf::from("/fake/engine"),
            engine_dir: None,
            save_path: save.map(|s| s.to_string()),
            cookie_file: cookie.map(|s| s.to_string()),
            cookie_mode: None,
        }
    }

    fn config_with_mode(mode: Option<&str>, cookie: Option<&str>) -> EngineConfig {
        EngineConfig {
            engine_path: PathBuf::from("/fake/engine"),
            engine_dir: None,
            save_path: None,
            cookie_file: cookie.map(|s| s.to_string()),
            cookie_mode: mode.map(|s| s.to_string()),
        }
    }

    #[test]
    fn video_download_flags() {
        let args = build_args(
            &config(None, None),
            "https://youtu.be/x",
            DownloadMode::Video,
        );
        assert!(args.contains(&"--newline".to_string()));
        assert!(args.contains(&"--progress".to_string()));
        assert!(args.contains(&"--impersonate".to_string()));
        assert!(args.contains(&"chrome".to_string()));
        assert!(args.contains(&"-S".to_string()));
        assert!(args.contains(&"res:1080".to_string()));
        // URL terminated with `--` so dash-leading input can't be options
        let url_pos = args.iter().position(|a| a.starts_with("https://")).unwrap();
        assert_eq!(args[url_pos - 1], "--");
        assert!(args.last().unwrap().starts_with("https://youtu.be"));
        assert!(!args.contains(&"-x".to_string()));
    }

    #[test]
    fn engine_dir_wires_ffmpeg_location() {
        let cfg = EngineConfig {
            engine_path: PathBuf::from("/bundle/engine/yt-dlp"),
            engine_dir: Some("/bundle/engine".into()),
            save_path: None,
            cookie_file: None,
            cookie_mode: None,
        };
        let args = build_args(&cfg, "u", DownloadMode::Video);
        let i = args.iter().position(|a| a == "--ffmpeg-location").unwrap();
        assert_eq!(args[i + 1], "/bundle/engine");
    }

    #[test]
    fn engine_dir_absent_omits_ffmpeg_location() {
        let cfg = EngineConfig {
            engine_path: PathBuf::from("yt-dlp"),
            engine_dir: None,
            save_path: None,
            cookie_file: None,
            cookie_mode: None,
        };
        let args = build_args(&cfg, "u", DownloadMode::Video);
        assert!(!args.contains(&"--ffmpeg-location".to_string()));
    }

    #[test]
    fn cookie_mode_none_adds_no_cookie_flags() {
        let args = build_args(
            &config_with_mode(Some("none"), None),
            "u",
            DownloadMode::Audio,
        );
        assert!(!args.contains(&"--cookies".to_string()));
        assert!(!args.contains(&"--cookies-from-browser".to_string()));
    }

    #[test]
    fn cookie_mode_chrome_uses_browser_flag() {
        let args = build_args(
            &config_with_mode(Some("chrome"), None),
            "u",
            DownloadMode::Audio,
        );
        let i = args
            .iter()
            .position(|a| a == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[i + 1], "chrome");
    }

    #[test]
    fn cookie_mode_unset_defaults_to_chrome() {
        let args = build_args(&config_with_mode(None, None), "u", DownloadMode::Audio);
        assert!(args.contains(&"--cookies-from-browser".to_string()));
    }

    #[test]
    fn cookie_file_wins_over_mode() {
        let args = build_args(
            &config_with_mode(Some("chrome"), Some("/tmp/cookies.txt")),
            "u",
            DownloadMode::Audio,
        );
        let i = args.iter().position(|a| a == "--cookies").unwrap();
        assert_eq!(args[i + 1], "/tmp/cookies.txt");
        assert!(!args.contains(&"--cookies-from-browser".to_string()));
    }

    #[test]
    fn retries_without_cookies_on_chrome_cookie_failure() {
        assert!(should_retry_without_cookies(
            true,
            false,
            "ERROR: could not copy chrome cookie database: database is locked"
        ));
    }

    #[test]
    fn no_retry_when_already_succeeded() {
        assert!(!should_retry_without_cookies(true, true, ""));
    }

    #[test]
    fn no_retry_on_unrelated_failure() {
        assert!(!should_retry_without_cookies(
            true,
            false,
            "ERROR: Video unavailable"
        ));
    }

    #[test]
    fn no_retry_when_cookies_were_not_chrome() {
        assert!(!should_retry_without_cookies(
            false,
            false,
            "ERROR: could not copy chrome cookie database"
        ));
    }

    #[test]
    fn mp3_extraction_flags() {
        let args = build_args(
            &config(None, None),
            "https://youtu.be/x",
            DownloadMode::Audio,
        );
        assert!(args.contains(&"-x".to_string()));
        assert!(args.contains(&"--audio-format".to_string()));
        let i = args.iter().position(|a| a == "--audio-format").unwrap();
        assert_eq!(args[i + 1], "mp3");
    }

    #[test]
    fn cookies_default_to_chrome_browser_store() {
        let args = build_args(&config(None, None), "u", DownloadMode::Video);
        let i = args
            .iter()
            .position(|a| a == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[i + 1], "chrome");
    }

    #[test]
    fn cookie_file_overrides_browser_store() {
        let args = build_args(
            &config(None, Some("/c/cookies.txt")),
            "u",
            DownloadMode::Video,
        );
        let i = args.iter().position(|a| a == "--cookies").unwrap();
        assert_eq!(args[i + 1], "/c/cookies.txt");
        assert!(!args.contains(&"--cookies-from-browser".to_string()));
    }

    #[test]
    fn save_path_sets_output_dir() {
        let args = build_args(
            &config(Some("/media/music"), None),
            "u",
            DownloadMode::Audio,
        );
        let i = args.iter().position(|a| a == "-P").unwrap();
        assert_eq!(args[i + 1], "/media/music");
    }
}
