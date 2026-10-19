import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DownloadTab from "./components/DownloadTab";

export interface Settings {
  save_path: string | null;
  cookie_file: string | null;
}

type Tab = "download" | "history";

function SettingsPanel({
  settings,
  onSave,
}: {
  settings: Settings;
  onSave: (s: Settings) => void;
}) {
  const [draft, setDraft] = useState<Settings>(settings);

  return (
    <section data-testid="settings-panel">
      <label>
        Save path
        <input
          value={draft.save_path ?? ""}
          onChange={(e) => setDraft({ ...draft, save_path: e.target.value })}
        />
      </label>
      <label>
        Cookies file
        <input
          value={draft.cookie_file ?? ""}
          onChange={(e) => setDraft({ ...draft, cookie_file: e.target.value })}
        />
      </label>
      <button onClick={() => onSave(draft)}>Save</button>
      <button onClick={() => setDraft(settings)}>Cancel</button>
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("download");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>({
    save_path: null,
    cookie_file: null,
  });

  useEffect(() => {
    invoke<Settings>("get_settings")
      .then((s) => setSettings(s))
      .catch(() => {
        /* fresh frontend dev without backend; defaults stand */
      });
  }, []);

  const saveSettings = (s: Settings) => {
    setSettings(s);
    invoke("set_settings", { settings: s }).catch(() => {
      /* surface later when commands carry errors */
    });
    setSettingsOpen(false);
  };

  return (
    <main>
      <nav>
        <button role="tab" aria-selected={tab === "download"} onClick={() => setTab("download")}>
          Download
        </button>
        <button role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
          History
        </button>
        <button aria-label="Settings" onClick={() => setSettingsOpen((o) => !o)}>
          ⚙ Settings
        </button>
      </nav>

      {settingsOpen && (
        <SettingsPanel settings={settings} onSave={saveSettings} />
      )}

      {tab === "download" ? (
        <div role="tabpanel">
          <DownloadTab />
        </div>
      ) : (
        <div role="tabpanel">History tab</div>
      )}
    </main>
  );
}
