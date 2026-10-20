import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invokeMock = vi.fn();
const openMock = vi.fn();
const handlers: Array<(e: { payload: unknown }) => void> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_e: string, handler: (e: { payload: unknown }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

import App from "../src/App";

function emit(payload: unknown) {
  act(() => {
    handlers.forEach((h) => h({ payload }));
  });
}

// stateful backend double: set_cookie_file / set_settings mutate the store
function makeBackend(initial: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...initial };
  invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "get_settings":
        return Promise.resolve({ ...store });
      case "get_history":
        return Promise.resolve([]);
      case "set_settings":
        Object.assign(store, (args as { settings: Record<string, unknown> }).settings);
        return Promise.resolve(undefined);
      case "set_cookie_file":
        store.cookie_file = (args as { path: string }).path;
        return Promise.resolve(undefined);
      case "engine_version":
        return Promise.resolve({ version: "2026.10.10.233141", origin: "user" });
      case "health_check":
        return Promise.resolve({ ok: true, components: [] });
      case "update_engine":
        store.updatedTag = true;
        return Promise.resolve("2026.10.20.233405");
      default:
        return Promise.resolve(undefined);
    }
  });
  return store;
}

async function renderApp() {
  return render(<App />);
}

describe("yt-ui tabs shell", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    openMock.mockResolvedValue(null);
    handlers.length = 0;
    makeBackend({ save_path: null, cookie_file: null, engine_path: null });
  });

  it("shows Download, History and Settings tabs, starting on Download", async () => {
    await renderApp();
    for (const name of ["Download", "History", "Settings"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("keeps Download state while visiting other tabs", async () => {
    await renderApp();
    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://youtu.be/keep" },
    });
    fireEvent.click(screen.getByRole("tab", { name: /History/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Download/ }));
    expect(screen.getByLabelText("URL")).toHaveValue("https://youtu.be/keep");
  });

  it("settings tab lists save path, cookies and engine override", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    expect(await screen.findByLabelText("Save path")).toBeInTheDocument();
    expect(screen.getByLabelText("Cookie source")).toBeInTheDocument();
    expect(screen.getByLabelText("Engine")).toBeInTheDocument();
    expect(screen.getByTestId("engine-info")).toHaveTextContent(
      "2026.10.10.233141"
    );
  });

  it("preflight complains about missing components and blocks Download", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "health_check") {
        return Promise.resolve({
          ok: false,
          components: [
            {
              name: "ffmpeg",
              ok: false,
              detail: "missing or not executable: /bundle/engine/ffmpeg",
            },
            { name: "deno", ok: false, detail: "deno not found on PATH" },
          ],
        });
      }
      if (cmd === "get_history") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    await renderApp();
    const banner = await screen.findByTestId("preflight");
    expect(banner).toHaveTextContent(/ffmpeg/i);
    expect(banner).toHaveTextContent(/deno/i);
    expect(screen.getByRole("button", { name: /download/i })).toBeDisabled();
  });

  it("preflight Recheck re-runs the health check and clears once healthy", async () => {
    let healthy = false;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "health_check") {
        return Promise.resolve(
          healthy
            ? { ok: true, components: [] }
            : {
                ok: false,
                components: [
                  { name: "yt-dlp", ok: false, detail: "missing" },
                ],
              }
        );
      }
      if (cmd === "get_history") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    await renderApp();
    await screen.findByTestId("preflight");
    healthy = true;
    fireEvent.click(screen.getByRole("button", { name: /recheck/i }));
    await waitFor(() => {
      expect(screen.queryByTestId("preflight")).not.toBeInTheDocument();
    });
  });

  it("cookie source none is persisted and clears the cookie file", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    const select = await screen.findByLabelText("Cookie source");
    fireEvent.change(select, { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: {
          save_path: null,
          cookie_file: null,
          cookie_mode: "none",
          engine_path: null,
        },
      });
    });
  });

  it("settings are refetched when the tab opens, not stale from mount", async () => {
    // banner pick lands AFTER app mounted; settings tab must see it
    makeBackend({ save_path: "/some", cookie_file: null, engine_path: null });
    await renderApp();
    emit({
      type: "finished",
      ok: false,
      message: "db locked",
      stderrTail: "ERROR: could not copy chrome cookie database",
      cookieIssue: true,
    });
    openMock.mockResolvedValue("/home/me/cookies.txt");
    fireEvent.click(screen.getByRole("button", { name: /pick cookies.txt/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_cookie_file", {
        path: "/home/me/cookies.txt",
      });
    });
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    // fresh fetch must show the picked cookie, not the mount-time null
    await waitFor(async () => {
      expect(await screen.findByLabelText("Cookies file")).toHaveValue(
        "/home/me/cookies.txt"
      );
    });
  });

  it("settings save persists the full current state", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    const input = await screen.findByLabelText("Save path");
    fireEvent.change(input, { target: { value: "/home/me/Videos" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: {
          save_path: "/home/me/Videos",
          cookie_file: null,
          cookie_mode: "chrome",
          engine_path: null,
        },
      });
    });
  });

  it("engine override picker persists engine_path", async () => {
    openMock.mockResolvedValue("/opt/newengine/yt-dlp");
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: /browse engine/i }));
    await waitFor(() => {
      expect(openMock).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: {
          save_path: null,
          cookie_file: null,
          cookie_mode: "chrome",
          engine_path: "/opt/newengine/yt-dlp",
        },
      });
    });
  });

  it("clear engine override resets path and persists null", async () => {
    makeBackend({ save_path: null, cookie_file: null, engine_path: "/old/yt-dlp" });
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: /clear engine/i }));
    await waitFor(() => {
      expect(screen.getByLabelText("Engine")).toHaveValue("");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: {
          save_path: null,
          cookie_file: null,
          cookie_mode: "chrome",
          engine_path: null,
        },
      });
    });
  });

  it("save path browse stages a folder choice and Save persists it", async () => {
    openMock.mockResolvedValue("/home/me/picked_music");
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: /browse save path/i }));
    expect(await screen.findByLabelText("Save path")).toHaveValue(
      "/home/me/picked_music"
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: {
          save_path: "/home/me/picked_music",
          cookie_file: null,
          cookie_mode: "chrome",
          engine_path: null,
        },
      });
    });
  });

  it("cookies file browse persists immediately via set_cookie_file", async () => {
    openMock.mockResolvedValue("/home/me/cookies.txt");
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    fireEvent.change(await screen.findByLabelText("Cookie source"), {
      target: { value: "file" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /browse cookies/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_cookie_file", {
        path: "/home/me/cookies.txt",
      });
    });
    expect(await screen.findByLabelText("Cookies file")).toHaveValue(
      "/home/me/cookies.txt"
    );
  });

  it("update engine shows fresh version after update", async () => {
    const store = makeBackend({ save_path: null, cookie_file: null, engine_path: null });
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: /Settings/ }));
    await screen.findByTestId("engine-info");
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "engine_version")
        return Promise.resolve({ version: "2026.10.20.233405", origin: "user" });
      if (cmd === "update_engine") return Promise.resolve("2026.10.20.233405");
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "health_check")
        return Promise.resolve({ ok: true, components: [] });
      return Promise.resolve({ ...store });
    });
    fireEvent.click(screen.getByRole("button", { name: /update engine/i }));
    await waitFor(async () => {
      expect((await screen.findByTestId("engine-info")).textContent).toContain(
        "2026.10.20.233405"
      );
    });
  });
});
