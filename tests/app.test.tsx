import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

async function renderApp() {
  const result = render(<App />);
  return result;
}

describe("yt-ui shell", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ save_path: null, cookie_file: null });
  });

  it("shows Download and History tabs and starts on Download", async () => {
    await renderApp();
    expect(screen.getByRole("tab", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "History" })).toBeInTheDocument();
    expect(screen.getByLabelText(/url/i)).toBeInTheDocument();
  });

  it("switches to History tab", async () => {
    await renderApp();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("History tab");
  });

  it("gear opens settings panel and shows save path input", async () => {
    invokeMock.mockResolvedValue({
      save_path: "/home/me/Music",
      cookie_file: null,
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(
      async () =>
        expect(await screen.findByLabelText("Save path")).toHaveValue(
          "/home/me/Music"
        ),
      { timeout: 5000 }
    );
  });

  it("settings save button persists via set_settings", async () => {
    invokeMock.mockResolvedValue({
      save_path: null,
      cookie_file: null,
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const input = await screen.findByLabelText("Save path");
    fireEvent.change(input, { target: { value: "/home/me/Videos" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: { save_path: "/home/me/Videos", cookie_file: null },
      });
    });
  });

  it("save path Browse button opens folder picker and applies choice", async () => {
    invokeMock.mockResolvedValue({ save_path: null, cookie_file: null });
    openMock.mockResolvedValue("/home/me/picked_music");
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: /browse save path/i }));
    await waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        expect.objectContaining({ directory: true })
      );
    });
    expect(await screen.findByLabelText("Save path")).toHaveValue(
      "/home/me/picked_music"
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: { save_path: "/home/me/picked_music", cookie_file: null },
      });
    });
  });

  it("cookies Browse button opens file picker and applies choice", async () => {
    invokeMock.mockResolvedValue({ save_path: null, cookie_file: null });
    openMock.mockResolvedValue("/home/me/cookies.txt");
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
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
});
