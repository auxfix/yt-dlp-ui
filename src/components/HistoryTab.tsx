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
    <div>
      {entries === null && <div>Loading…</div>}
      {entries !== null && entries.length === 0 && (
        <div>No downloads yet</div>
      )}
      {entries !== null && entries.length > 0 && (
        <ul data-testid="history-list">
          {entries.map((e, i) => (
            <li key={i} data-testid={`entry-${i}`}>
              <span data-testid={`icon-${e.mode}`}>
                {e.mode === "audio" ? "🎵" : "🎬"}
              </span>{" "}
              <span title={`${e.url}${e.filePath ? `\n${e.filePath}` : ""}`}>
                {e.title}
              </span>{" "}
              <span>{fmtTime(e.ts)}</span>{" "}
              <span data-testid={e.ok ? "status-ok" : "status-fail"}>
                {e.ok ? "✓" : "✗"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
