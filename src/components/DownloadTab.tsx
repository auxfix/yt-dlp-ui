import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
}

type Payload = StartPayload | ProgressPayload | FinishedPayload;

export default function DownloadTab() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("audio");
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<{ message: string; stderrTail: string } | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<Payload>("download-event", (e) => {
      const p = e.payload;
      switch (p.type) {
        case "started":
          setStatus("running");
          setProgress(null);
          setError(null);
          break;
        case "progress":
          setProgress({ pct: p.pct, speed: p.speed, eta: p.eta });
          break;
        case "finished":
          setStatus(p.ok ? "done" : "error");
          if (!p.ok) {
            setError({ message: p.message, stderrTail: p.stderrTail });
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

  const running = status === "running";

  return (
    <div>
      <label>
        URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/..."
        />
      </label>
      <label>
        <input
          type="radio"
          checked={mode === "audio"}
          onChange={() => setMode("audio")}
        />
        mp3
      </label>
      <label>
        <input
          type="radio"
          checked={mode === "video"}
          onChange={() => setMode("video")}
        />
        video
      </label>
      <button onClick={start} disabled={running || !url.trim()}>
        Download
      </button>

      {running && (
        <div data-testid="run-status">
          <span>Downloading…</span>
          {progress && (
            <span>
              {" "}
              {progress.pct.toFixed(1)}%
              {progress.speed ? ` · ${progress.speed}` : ""}
              {progress.eta ? ` · ETA ${progress.eta}` : ""}
            </span>
          )}
        </div>
      )}

      {status === "done" && <div>Done</div>}

      {error && (
        <div role="alert">
          <p className="error-line">{error.message}</p>
          <details>
            <summary>Full engine output</summary>
            <pre>{error.stderrTail}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
