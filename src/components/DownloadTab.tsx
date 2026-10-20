import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Mode = "audio" | "video";

interface Progress {
  pct: number;
  speed: string | null;
  eta: string | null;
}

type Status = "idle" | "running" | "done" | "error";

interface StartPayload {
  type: "started";
  url: string;
}
interface ProgressPayload {
  type: "progress";
  pct: number;
  speed: string | null;
  eta: string | null;
}
interface FinishedPayload {
  type: "finished";
  ok: boolean;
  message: string;
  stderrTail: string;
  cookieIssue: boolean;
}
interface LogPayload {
  type: "log";
  line: string;
}

type Payload = StartPayload | ProgressPayload | FinishedPayload | LogPayload;

// yt-dlp emits a progress line per chunk. Cap React updates to ~10/s so a
// fast download cannot starve the UI thread.
const PROGRESS_THROTTLE_MS = 100;

const LOG_LIMIT = 60;

export default function DownloadTab({ blocked = false }: { blocked?: boolean }) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("audio");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{ message: string; stderrTail: string } | null>(null);
  const [cookieBanner, setCookieBanner] = useState(false);

  const lastProgressAt = useRef(0);
  const pendingProgress = useRef<Progress | null>(null);
  const flushTimer = useRef<number | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const clearFlush = () => {
      if (flushTimer.current !== null) {
        window.clearTimeout(flushTimer.current);
        flushTimer.current = null;
      }
    };

    listen<Payload>("download-event", (e) => {
      const p = e.payload;
      switch (p.type) {
        case "started":
          clearFlush();
          pendingProgress.current = null;
          lastProgressAt.current = 0;
          setStatus("running");
          setProgress(null);
          setError(null);
          setCookieBanner(false);
          setLogLines([]);
          break;
        case "progress": {
          // leading edge applies immediately; the rest of the burst is
          // coalesced into one trailing update per throttle window
          const next = { pct: p.pct, speed: p.speed, eta: p.eta };
          pendingProgress.current = next;
          const now = performance.now();
          if (now - lastProgressAt.current >= PROGRESS_THROTTLE_MS) {
            lastProgressAt.current = now;
            setProgress(next);
          } else if (flushTimer.current === null) {
            flushTimer.current = window.setTimeout(() => {
              flushTimer.current = null;
              lastProgressAt.current = performance.now();
              if (pendingProgress.current) {
                setProgress(pendingProgress.current);
              }
            }, PROGRESS_THROTTLE_MS);
          }
          break;
        }
        case "finished":
          clearFlush();
          pendingProgress.current = null;
          setStatus(p.ok ? "done" : "error");
          if (!p.ok) {
            setError({ message: p.message, stderrTail: p.stderrTail });
            setCookieBanner(p.cookieIssue);
          }
          break;
        case "log":
          // keep only the tail so long downloads don't grow unbounded
          setLogLines((lines) => {
            const next = [...lines, p.line];
            return next.length > LOG_LIMIT
              ? next.slice(next.length - LOG_LIMIT)
              : next;
          });
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      clearFlush();
      unlisten?.();
    };
  }, []);

  const start = () => {
    if (!url.trim() || status === "running" || blocked) {
      return;
    }
    // optimistic: the engine can take a while to say anything at all
    setStatus("running");
    setProgress(null);
    setError(null);
    setLogLines([]);
    setCookieBanner(false);
    invoke("start_download", { url: url.trim(), mode }).catch((e) => {
      setStatus("error");
      setError({ message: String(e), stderrTail: String(e) });
    });
  };

  const pickCookieFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "cookies.txt", extensions: ["txt"] }],
    });
    if (typeof picked !== "string") {
      return; // user cancelled — banner stays
    }
    await invoke("set_cookie_file", { path: picked });
    setCookieBanner(false);
  };

  const running = status === "running";
  const pct = progress?.pct ?? null;

  return (
    <div className="download">
      <div className="card">
        <input
          className="url-input"
          aria-label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a YouTube link…"
          spellCheck={false}
        />

        <div className="mode-toggle" role="radiogroup" aria-label="Mode">
          <button
            className={mode === "audio" ? "pill active" : "pill"}
            aria-label="mp3"
            aria-pressed={mode === "audio"}
            onClick={() => setMode("audio")}
          >
            🎵 mp3
          </button>
          <button
            className={mode === "video" ? "pill active" : "pill"}
            aria-label="video"
            aria-pressed={mode === "video"}
            onClick={() => setMode("video")}
          >
            🎬 video
          </button>
        </div>

        <button
          className="primary download-btn"
          onClick={start}
          disabled={running || !url.trim() || blocked}
        >
          {running ? (
            <>
              <span className="spin" aria-hidden>⭯</span> Downloading…
            </>
          ) : (
            <>
              <span aria-hidden>⬇</span> Download
            </>
          )}
        </button>
        {blocked && (
          <p className="hint">Fix the missing components above to enable downloading.</p>
        )}
      </div>

      {running && (
        <div data-testid="run-status" className="card progress-card">
          <div className="progress-track">
            <div
              className={pct === null ? "progress-fill indeterminate" : "progress-fill"}
              style={pct === null ? undefined : { width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <div className="progress-meta">
            <span className="pct">{pct === null ? "starting…" : `${pct.toFixed(1)}%`}</span>
            {progress?.speed && <span className="meta-chip">{progress.speed}</span>}
            {progress?.eta && <span className="meta-chip">ETA {progress.eta}</span>}
          </div>
          {pct === null && (
            <p className="hint">Talking to YouTube — bot-check retries can take a minute.</p>
          )}
        </div>
      )}

      {status === "done" && (
        <div className="card done-card">
          ✅ <span>Done</span> — saved to your folder
        </div>
      )}

      {error && (
        <div className="card error-card" role="alert">
          {cookieBanner && (
            <div className="cookie-banner" data-testid="cookie-banner">
              <p>
                Couldn't read Chrome cookies. Close Chrome and retry, or pick
                your cookies.txt (exported once, stored and reused).
              </p>
              <button onClick={pickCookieFile}>Pick cookies.txt</button>
            </div>
          )}
          <div className="error-head">
            <span aria-hidden className="error-icon">⚠️</span>
            <p className="error-line">{error.message}</p>
          </div>
          <details>
            <summary>Full engine output</summary>
            <pre>{error.stderrTail}</pre>
          </details>
        </div>
      )}

      {logLines.length > 0 && (
        <details className="card log-card" open>
          <summary>Engine log</summary>
          <pre data-testid="engine-log">{logLines.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
