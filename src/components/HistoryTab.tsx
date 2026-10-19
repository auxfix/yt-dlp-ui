import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface HistoryEntry {
  url: string;
  title: string;
  mode: "audio" | "video" | string;
  ok: boolean;
  ts: number;
  filePath: string | null;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

export default function HistoryTab() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    invoke<HistoryEntry[]>("get_history")
      .then((entries) => setEntries(entries))
      .catch(() => setEntries([]));
  }, []);

  return (
    <div className={entries !== null && entries.length > 0 ? "history" : undefined}>
      {entries === null && <div className="history-empty">Loading…</div>}
      {entries !== null && entries.length === 0 && (
        <div className="history-empty">No downloads yet</div>
      )}
      {entries !== null && entries.length > 0 && (
        <ul className="history-list" data-testid="history-list">
          {entries.map((e, i) => (
            <li
              key={i}
              className={`history-row ${e.ok ? "ok" : "failed"}`}
              data-testid={`entry-${i}`}
            >
              <span className="status-dot" data-testid={e.ok ? "status-ok" : "status-fail"} />
              <span aria-hidden data-testid={`icon-${e.mode}`}>
                {e.mode === "audio" ? "🎵" : "🎬"}
              </span>
              <span
                className="title"
                title={`${e.url}${e.filePath ? `\n${e.filePath}` : ""}`}
              >
                {e.title}
              </span>
              <span className="when">{fmtTime(e.ts)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
