import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type CookieMode = "chrome" | "none" | "file";

interface Settings {
  save_path: string | null;
  cookie_file: string | null;
  cookie_mode: CookieMode | null;
  engine_path: string | null;
}

interface EngineInfo {
  version: string | null;
  origin: string;
}

const DEFAULTS: Settings = {
  save_path: null,
  cookie_file: null,
  cookie_mode: "chrome",
  engine_path: null,
};

function normalize(s: Partial<Settings>): Settings {
  return {
    ...DEFAULTS,
    ...s,
    // a stored cookie file means file mode, even on legacy settings files
    cookie_mode: s.cookie_mode ?? (s.cookie_file ? "file" : "chrome"),
  };
}

export default function SettingsTab({ active }: { active: boolean }) {
  const [draft, setDraft] = useState<Settings>(DEFAULTS);
  const [engine, setEngine] = useState<EngineInfo | null>(null);

  // refetch on every open so backend-written changes (banner cookie picks,
  // engine updates) are never clobbered by a stale draft
  useEffect(() => {
    if (!active) {
      return;
    }
    invoke<Partial<Settings>>("get_settings")
      .then((s) => setDraft(normalize(s)))
      .catch(() => setDraft(DEFAULTS));
    invoke<EngineInfo>("engine_version")
      .then(setEngine)
      .catch(() => setEngine(null));
  }, [active]);

  const browseFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      setDraft((d) => ({ ...d, save_path: picked }));
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
      setDraft((d) => ({ ...d, cookie_file: picked, cookie_mode: "file" }));
    }
  };

  const changeCookieMode = (mode: CookieMode) => {
    setDraft((d) => ({
      ...d,
      cookie_mode: mode,
      // file wins over mode on the backend; clear it so the choice is honest
      cookie_file: mode === "file" ? d.cookie_file : null,
    }));
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
          <button aria-label="Browse save path" onClick={browseFolder}>
            Browse…
          </button>
        </label>
      </div>

      <div className="card">
        <h2>Cookies</h2>
        <label>
          <span>Cookie source</span>
          <select
            aria-label="Cookie source"
            value={draft.cookie_mode ?? "chrome"}
            onChange={(e) => changeCookieMode(e.target.value as CookieMode)}
          >
            <option value="chrome">Chrome (recommended)</option>
            <option value="none">None — download without cookies</option>
            <option value="file">cookies.txt file</option>
          </select>
        </label>
        {draft.cookie_mode === "file" && (
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
        )}
        <p className="hint">
          Chrome cookies help with bot checks. If Chrome's cookie store is
          locked, downloads retry once without cookies.
        </p>
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
          <button
            aria-label="Clear engine"
            onClick={() => setDraft((d) => ({ ...d, engine_path: null }))}
          >
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
