import { useState } from "react";
import DownloadTab from "./components/DownloadTab";
import HistoryTab from "./components/HistoryTab";
import SettingsTab from "./components/SettingsTab";

type Tab = "download" | "history" | "settings";

const TABS: Array<{ id: Tab; icon: string; label: string }> = [
  { id: "download", icon: "⬇", label: "Download" },
  { id: "history", icon: "≡", label: "History" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("download");

  return (
    <main>
      <header className="brand">
        <span className="brand-mark">▶</span> yt-ui
      </header>
      <nav className="tabs" role="tablist">
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

      {/* all tabs stay mounted so in-flight download state survives switching */}
      <section className="panel" hidden={tab !== "download"} role="tabpanel">
        <DownloadTab />
      </section>
      <section className="panel" hidden={tab !== "history"} role="tabpanel">
        <HistoryTab />
      </section>
      <section className="panel" hidden={tab !== "settings"} role="tabpanel">
        <SettingsTab active={tab === "settings"} />
      </section>
    </main>
  );
}
