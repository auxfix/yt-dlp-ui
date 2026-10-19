import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
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
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Download tab");
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
    await waitFor(async () => {
      expect(
        await screen.findByLabelText(/Save path/i)
      ).toHaveValue("/home/me/Music");
    });
  });

  it("settings save button persists via set_settings", async () => {
    invokeMock.mockResolvedValue({
      save_path: null,
      cookie_file: null,
    });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const input = await screen.findByLabelText(/Save path/i);
    fireEvent.change(input, { target: { value: "/home/me/Videos" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/i }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_settings", {
        settings: { save_path: "/home/me/Videos", cookie_file: null },
      });
    });
  });
});
