#!/usr/bin/env sh
# Fetch the engine set (yt-dlp + ffmpeg + deno) for the CURRENT build target
# into src-tauri/engine/. Only the current target's binaries are kept, so the
# resource bundle stays small. Linux CI runs this for linux builds; Windows
# builds run it again on Windows.
#
# Usage: scripts/fetch-engine.sh [linux|windows]
set -euo pipefail

target="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')}"
case "$target" in
  linux|*mingw*|*msys*|"windows") ;;
  *) echo "unsupported target: $target" >&2; exit 1 ;;
esac
case "$target" in
  *mingw*|*msys*) target="windows" ;;
  darwin*) echo "no macOS target in v1" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/src-tauri/engine"
os_lowercase="$target"
if [ "$target" = "windows" ]; then os_lowercase="windows"; fi

echo "Fetching engine set for: $target"
mkdir -p "$dest"

URL() { printf '%s' "$1"; }

# yt-dlp — nightly channel (see PLAN.md: stable is stale-by-design)
if [ "$target" = "windows" ]; then ytdlp_asset="yt-dlp.exe"; else ytdlp_asset="yt-dlp_linux"; fi
echo "- yt-dlp ($ytdlp_asset nightly)"
curl -fsSL -o "$dest/$ytdlp_asset" \
  "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/$ytdlp_asset"
if [ "$target" != "windows" ]; then chmod +x "$dest/$ytdlp_asset"; fi

# ffmpeg + ffprobe (yt-dlp's own builds)
if [ "$target" = "windows" ]; then
  echo "- ffmpeg (win64-gpl)"
  curl -fsSL -o "$dest/ffmpeg.zip" \
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
  (cd "$dest" && unzip -oq ffmpeg.zip && mv ffmpeg-master-latest-win64-gpl/bin/ff* . && rm -rf ffmpeg-master-latest-win64-gpl ffmpeg.zip)
else
  echo "- ffmpeg (linux64-gpl)"
  curl -fsSL -o "$dest/ffmpeg.tar.xz" \
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
  (cd "$dest" && tar xf ffmpeg.tar.xz --wildcards --strip-components=2 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg' 'ffmpeg-master-latest-linux64-gpl/bin/ffprobe' && rm -rf ffmpeg.tar.xz ffmpeg-master-latest-linux64-gpl)
  chmod +x "$dest/ffmpeg" "$dest/ffprobe" 2>/dev/null || true
fi

# deno — JS runtime required by yt-dlp-ejs for YouTube
if [ "$target" = "windows" ]; then deno_asset="deno-x86_64-pc-windows-msvc.zip"; else deno_asset="deno-x86_64-unknown-linux-gnu.zip"; fi
echo "- deno ($deno_asset)"
curl -fsSL -o "$dest/deno.zip" \
  "https://github.com/denoland/deno/releases/latest/download/$deno_asset"
(cd "$dest" && unzip -oq deno.zip && rm -f deno.zip)
if [ "$target" != "windows" ]; then chmod +x "$dest/deno"; fi

echo "Engine ready in $dest:"
ls -la "$dest"
