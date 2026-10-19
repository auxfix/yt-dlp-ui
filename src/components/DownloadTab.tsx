import { useEffect, useState } from "react";
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

type Payload = StartPayload | ProgressPayload | FinishedPayload;

export default function DownloadTab() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("audio");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{ message: string; stderrTail: string } | null>(null);
  const [cookieBanner, setCookieBanner] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<Payload>("download-event", (e) => {
      const p = e.payload;
      switch (p.type) {
        case "started":
          setStatus("running");
          setProgress(null);
          setError(null);
          setCookieBanner(false);
          break;
        case "progress":
          setProgress({ pct: p.pct, speed: p.speed, eta: p.eta });
          break;
        case "finished":
          setStatus(p.ok ? "done" : "error");
          if (!p.ok) {
            setError({ message: p.message, stderrTail: p.stderrTail });
            setCookieBanner(p.cookieIssue);
          }
          break;
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const start = () => {
    if (!url.trim() || status === "running") {
      return;
    }
    invoke("start_download", { url: url.trim(), mode }).catch((e) => {
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

        <button className="primary download-btn" onClick={start} disabled={running || !url.trim()}>
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
    </div>
  );
}
