import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
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

  const browseSavePath = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setDraft({ ...draft, save_path: picked });
    }
  };

  const browseCookies = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "cookies", extensions: ["txt"] }],
    });
    if (typeof picked === "string") {
      await invoke("set_cookie_file", { path: picked });
      setDraft({ ...draft, cookie_file: picked });
    }
  };

  return (
    <section data-testid="settings-panel">
      <label>
        Save path
        <input
          value={draft.save_path ?? ""}
          onChange={(e) => setDraft({ ...draft, save_path: e.target.value })}
        />
      </label>
      <button aria-label="Browse save path" onClick={browseSavePath}>
        Browse…
      </button>
      <label>
        Cookies file
        <input
          value={draft.cookie_file ?? ""}
          onChange={(e) => setDraft({ ...draft, cookie_file: e.target.value })}
        />
      </label>
      <button aria-label="Browse cookies" onClick={browseCookies}>
        Browse…
      </button>
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
