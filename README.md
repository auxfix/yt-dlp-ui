# yt-ui

A small desktop GUI wrapper around [yt-dlp](https://github.com/yt-dlp/yt-dlp) for downloading YouTube videos and mp3s locally. Personal-use MVP, built with **Tauri v2 + React + TypeScript**, works on **Linux and Windows**.

Features (v1 scope, see `PLAN.md` for the locked decisions):

- Paste a URL, pick **mp3** or **video**, hit Download — live %, speed and ETA.
- Bot-check resilience: reads Chrome cookies automatically, falls back to a `cookies.txt` file picker when that breaks (exported once, stored and reused).
- Bundled engine (`yt-dlp` nightly + `ffmpeg` + `deno`) shipped in the installer; an **Update engine** button pulls the newest nightly into app-data and overrides the bundled one — no PATH skills required from you.
- History of past downloads (successes ✅ and failures ✖ with the engine logs in the error details).
- Download | History | Settings tabs; settings persist save path, cookies file and an optional engine-binary override.

## Getting set up

Tauri's [prerequisites page](https://tauri.app/start/prerequisites/) covers the platform list; the short version:

- **All platforms:** Node.js ≥ 18, npm, Rust (stable; MSVC toolchain on Windows).
- **Linux:** `libwebkit2gtk-4.1-dev` (Debian/Ubuntu) or `webkit2gtk-4.1` (Arch), plus `binutils` and `patchelf` for AppImage bundling.

Then, from a fresh clone:

```bash
npm install
```

### Engine binaries (one per build OS)

The engine set is fetched by an OS-aware script — rerun it on whichever OS you ship from:

```bash
./scripts/fetch-engine.sh          # Linux
# on Windows run the same script under MSYS/Git-Bash:
# sh scripts/fetch-engine.sh
```

It pulls the yt-dlp nightly (stored as `src-tauri/engine/yt-dlp` / `yt-dlp.exe`), ffmpeg + ffprobe, and deno (required for yt-dlp's YouTube JS challenges).

### Building

```bash
npm run tauri build                # full installer/bundles (AppImage on Linux)
npm run tauri dev                  # dev mode (engine = bare `yt-dlp` on PATH)
```

## Testing

All gates must be green at all times; fixes land as a RED→GREEN pass per unit:

```bash
cd src-tauri && cargo test            # Rust: 43 tests
npx vitest run                        # front-end: 25 tests
cd src-tauri && cargo clippy --all-targets   # no warnings
npx tsc --noEmit                      # types clean
```

## Contributing

Contributions welcome — the app is small and opinionated on purpose, so a few ground rules:

1. **Read `PLAN.md` first.** It is the locked decisions list (engine delivery channel, cookie strategy, what's in vs deferred — e.g. no playlists/quality pickers in v1). Don't open PRs that re-litigate locked decisions; propose it as an issue first.
2. **Ship one slice per PR.** A fix/feature should carry its backend bit, its UI bit, and its tests together. Big multi-bucket PRs rot; keep it reviewable.
3. **Tests are RED→GREEN by habit.** Write the failing test first, then the fix. If you're deliberately changing a contract (e.g. the runner now feeding stderr to the parser), say so in the commit message.
4. **Don't regenerate engine assets.** `src-tauri/engine/` is filled by `scripts/fetch-engine.sh`; commit script changes, not re-fetched binaries — binaries are build-day inputs and live unpacked on the build machine.
5. **Commit style:** one-line summary, blank line, bullet body. Example: `fix(engine): --progress, ffmpeg-location, PATH for deno`.
6. **Cross-platform honesty:** changes to engine resolution, path handling, or arg building must be Windows-safe (`cfg!(windows)` gates, `PathBuf` joins, no Unix-only shell assumptions). There is no CI here, so the reviewer's Windows run is the safety net — call out what you couldn't test.
7. **Where the bugs live** ("my app doesn't do X" fixes): `src-tauri/src/downloader.rs` (arg builder/parser/runner), `src-tauri/src/lib.rs` (commands, events, engine resolution), `src/components/*.tsx` (the three tabs). The shell conventions (all tabs stay mounted; Settings refetches on open) are deliberate — see `src/App.tsx`.

## Project layout

```
src/                     React front end (DownloadTab, HistoryTab, SettingsTab)
src-tauri/src/           Rust commands, engine chain, yt-dlp plumbing
src-tauri/engine/        fetched binaries (build-day inputs)
scripts/fetch-engine.sh  engine set fetcher (run per build OS)
tests/                   vitest suites
PLAN.md                  locked decisions / milestone ledger
```
