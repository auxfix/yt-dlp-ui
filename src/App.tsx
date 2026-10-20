import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DownloadTab from "./components/DownloadTab";
import HistoryTab from "./components/HistoryTab";
import SettingsTab from "./components/SettingsTab";

type Tab = "download" | "history" | "settings";

interface ComponentHealth {
  name: string;
  ok: boolean;
  detail: string;
}

interface HealthReport {
  ok: boolean;
  components: ComponentHealth[];
}

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "download", icon: "⬇", label: "Download" },
  { id: "history", icon: "≡", label: "History" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

type Theme = "dark" | "light";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem("yt-ui-theme") === "light"
    ? "light"
    : "dark";
}

export default function App() {
  const [tab, setTab] = useState<Tab>("download");
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [health, setHealth] = useState<HealthReport | null>(null);

  const checkHealth = useCallback(() => {
    invoke<HealthReport>("health_check")
      .then(setHealth)
      .catch(() => setHealth(null)); // dev/no-backend: don't brick the UI
  }, []);

  useEffect(() => {
    checkHealth();
  }, [checkHealth]);

  const blocked = health !== null && !health.ok;
  const missing = health?.components.filter((c) => !c.ok) ?? [];

  // persist & apply the color scheme on the <html> element
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("yt-ui-theme", theme);
  }, [theme]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ▶
          </span>
          <div className="brand-text">
            <span className="brand-name">yt-ui</span>
            <span className="brand-tagline">YouTube downloader</span>
          </div>
        </div>

        <button
          className="theme-toggle"
          aria-label="Toggle color theme"
          title="Toggle color theme"
          onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        >
          {theme === "dark" ? "☀️" : "🌙"}
        </button>
      </header>

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "active" : ""}
            onClick={() => setTab(t.id)}
          >
            <span aria-hidden>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      {blocked && (
        <section className="card preflight-card" role="alert" data-testid="preflight">
          <h2>Missing components</h2>
          <ul className="preflight-list">
            {missing.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong> — {c.detail}
              </li>
            ))}
          </ul>
          <p className="hint">
            Downloads are disabled until this is fixed. Fetch the engine set with{" "}
            <code>scripts/fetch-engine.sh</code>, point Settings → Engine at a
            working binary, or use Update engine there.
          </p>
          <div className="settings-actions">
            <button onClick={checkHealth}>Recheck</button>
          </div>
        </section>
      )}

      {/* all tabs stay mounted so in-flight download state survives switching */}
      <main className="content">
        <section className="panel" hidden={tab !== "download"} role="tabpanel">
          <DownloadTab blocked={blocked} />
        </section>
        <section className="panel" hidden={tab !== "history"} role="tabpanel">
          <HistoryTab />
        </section>
        <section className="panel" hidden={tab !== "settings"} role="tabpanel">
          <SettingsTab active={tab === "settings"} />
        </section>
      </main>

      <footer className="app-footer">
        <span>yt-ui · yt-dlp frontend</span>
      </footer>
    </div>
  );
}
