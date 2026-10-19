import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface Settings {
  save_path: string | null;
  cookie_file: string | null;
  engine_path: string | null;
}

interface EngineInfo {
  version: string | null;
  origin: string;
}

const DEFAULTS: Settings = {
  save_path: null,
  cookie_file: null,
  engine_path: null,
};

export default function SettingsTab({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [engine, setEngine] = useState<EngineInfo | null>(null);

  // refetch on every open so backend-written changes (banner cookie picks,
  // engine updates) are never clobbered by a stale draft
  useEffect(() => {
    if (!active) {
      return;
    }
    invoke<Settings>("get_settings")
      .then((s) => setDraft({ ...DEFAULTS, ...s }))
      .catch(() => setDraft(DEFAULTS));
    invoke<EngineInfo>("engine_version")
      .then(setEngine)
      .catch(() => setEngine(null));
  }, [active]);

  const browseFolder = async (which: "save_path") => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setDraft((d) => ({ ...d, [which]: picked }));
    }
  };

  const browseCookies = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "cookies", extensions: ["txt"] }],
    });
    if (typeof picked === "string") {
      // persist immediately; banner flow depends on it landing even if the
      // settings draft is never saved
      await invoke("set_cookie_file", { path: picked });
      setDraft((d) => ({ ...d, cookie_file: picked }));
    }
  };

  const browseEngine = async () => {
    const picked = await open({ multiple: false });
    if (typeof picked === "string") {
      setDraft((d) => ({ ...d, engine_path: picked }));
    }
  };

  const save = () => {
    invoke("set_settings", { settings: draft }).catch(() => {});
  };

  const updateEngine = async () => {
    await invoke("update_engine");
    invoke<EngineInfo>("engine_version")
      .then(setEngine)
      .catch(() => setEngine(null));
  };

  return (
    <div className="settings" hidden={!active}>
      <div className="card">
        <h2>Downloads</h2>
        <label>
          <span>Save path</span>
          <input
            value={draft.save_path ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, save_path: e.target.value }))
            }
          />
          <button
            aria-label="Browse save path"
            onClick={() => browseFolder("save_path")}
          >
            Browse…
          </button>
        </label>
        <label>
          <span>Cookies file</span>
          <input
            value={draft.cookie_file ?? ""}
            onChange={(e) =>
              setDraft((d) => ({ ...d, cookie_file: e.target.value }))
            }
          />
          <button aria-label="Browse cookies" onClick={browseCookies}>
            Browse…
          </button>
        </label>
      </div>

      <div className="card">
        <h2>Engine</h2>
        <label>
          <span>Engine</span>
          <input
            value={draft.engine_path ?? ""}
            placeholder="auto — bundled or nightly-updated"
            onChange={(e) =>
              setDraft((d) => ({ ...d, engine_path: e.target.value }))
            }
          />
          <button aria-label="Browse engine" onClick={browseEngine}>
            Browse…
          </button>
          <button aria-label="Clear engine" onClick={() => setDraft((d) => ({ ...d, engine_path: null }))}>
            Clear
          </button>
        </label>
        <section data-testid="engine-info" className="engine-row">
          <span>
            Engine: {engine?.version ?? "unknown"} ({engine?.origin ?? "?"})
          </span>
          <button onClick={updateEngine}>Update engine</button>
        </section>
      </div>

      <div className="settings-actions">
        <button className="primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
