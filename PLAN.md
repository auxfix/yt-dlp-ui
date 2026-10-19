# PLAN.md — yt-ui v1

A Tauri desktop GUI wrapper around yt-dlp. Personal-use MVP, covering local download needs (mp3 / video) from YouTube.

## Status

- **Stage:** planned (no code yet)
- **Built via:** grill-me interview — all decisions below are locked.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Framework | Tauri v2 |
| Frontend | React + Vite + TypeScript |
| OS targets | Linux and Windows, both first-class (two builds) |
| Engine delivery | **B — bundle**: yt-dlp, ffmpeg/ffprobe, and deno shipped in the installer |
| Cookie strategy | (i) `--cookies-from-browser chrome` → on failure, cookies.txt file picker |
| Download concurrency | One at a time; Download button disabled while running |
| Cancel | Not in v1 (stuck download = quit app) |

### The B + "Update engine" reconciliation

Bundled yt-dlp goes stale in weeks (bot-detection moves weekly). Settings therefore includes an **"Update engine"** button: it downloads the latest **nightly** yt-dlp into app-data, and the app **prefers the app-data engine over the bundled one**, falling back to the bundled copy if the download fails. Bundled = baseline, app-data = fresher override.

### Rejected / deferred

- Cookies don't "expire every 10 minutes" — the failing is YouTube **bot-detection** ("Sign in to confirm you're not a bot"). Mitigation baked into defaults: live Chrome cookies + `--impersonate chrome` + recent engine (nightly updater).
- No Firefox cookie source in v1 (v1.1 candidate).
- No playlists, no queue, no cancel, no quality/bitrate pickers, no auto engine update-check.

## Architecture

```
┌─ Tauri v2 app ──────────────────────────────┐
│  React webview (Download | History, gear)   │
│        │ invoke()                           │
│  Rust commands:                             │
│   start_download(url, mode)                 │
│   get/set settings                          │
│   pick_cookie_file                          │
│   update_engine, engine_version             │
│        │ spawn                              │
│  yt-dlp (sidecar, --newline) + ffmpeg/deno  │
└─────────────────────────────────────────────┘
```

- Rust parses yt-dlp `--newline` stdout → progress % events → UI.
- Settings persisted as JSON in app-config dir (save path, cookies.txt path).
- History persisted as JSON in app-data dir.

## UI spec (v1)

**Tabs: `Download` | `History`, plus gear icon → Settings panel.**

### Download tab
- URL address field
- mp3 / video toggle
- Download button
- While running: **spinner + live %** (parsed from `--newline`)
- Button disabled while a job runs (queue = 1)
- Error: short one-line red message + full yt-dlp stderr collapsed in a `<details>`
- Success: reflected via history entry

### History tab
- Passive list only: title, type icon (mp3/video), timestamp, status
- Persisted across restarts
- No click-actions in v1

### Settings (gear panel)
- Save path (native folder picker)
- Cookies: current source status + "pick cookies.txt" re-pick button
- Engine: version shown + "Update engine" button (nightly → app-data)

## yt-dlp invocation flags (baked)

- `--newline` (progress parsing)
- `--impersonate chrome`
- Cookies: `--cookies-from-browser chrome`; on failure → `--cookies <picked file>`
- mp3: default yt-dlp mp3 preset (`-x --audio-format mp3`) — no bitrate picker
- video: `best`, capped ≤1080p (`-S res:1080`) — 4K intentionally excluded
- Filename template: `{title}`

### Cookie failure UX chain

1. Try `--cookies-from-browser chrome` (both OSes).
2. On failure → UI banner: "Couldn't read Chrome cookies. Pick your cookies.txt" → file picker → path saved in settings, used as `--cookies`.
3. If Chrome is running on Windows and blocks the cookie DB → same banner, message says "Close Chrome and retry, or use cookies.txt."

## Bundling

- Per-target binaries: `yt-dlp.exe` (Windows) / `yt-dlp_linux` (Linux), ffmpeg + ffprobe (yt-dlp/FFmpeg-Builds), deno.
- Installer stays as small as bundling allows (~300MB+ accepted trade-off).

### Build-day verification checklist (#1 risk)

- [ ] Linux standalone build ships `curl_cffi` (needed for `--impersonate chrome`); if not, switch binary asset or adjust flags.
- [ ] Linux build ships `secretstorage` (needed to decrypt Chromium cookies via Gnome keyring).
- [ ] `yt-dlp-ejs` + bundled deno works (full YouTube support requires a JS runtime).
- [ ] Windows: Chrome app-bound encryption / cookie DB lock handling → fallback banner path works.
- [ ] Engine works when Chrome is running (or clean error path).

## Definition of done (v1)

Fresh install on Linux **and** Windows → paste a YouTube URL → press Download → reliably get the mp3 or video wanted, even while YouTube throws bot-checks. The only manual step ever is pointing at a cookies.txt when Chrome-reading breaks.

## Milestones

1. Scaffold Tauri + React; tabs skeleton; settings JSON read/write.
2. Spawn yt-dlp; parse `--newline`; progress % events to webview; completion detection; stderr capture.
3. Cookie chain + fallback flow + cookies.txt picker + persisting it.
4. History JSON + History tab.
5. Bundle ffmpeg + deno; verify impersonate/cookie deps; Windows + Linux builds.
6. Definition-of-done test pass on both OSes.

## Known trade-offs (accepted, not open)

- Bundled engine goes stale; mitigated by the nightly "Update engine" button.
- No cancel button — stuck download requires quitting the app.
- Queue of 1; no playlists.
- Engine auto-update is manual (button only), no check on launch.
