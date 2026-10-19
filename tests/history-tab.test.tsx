import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import HistoryTab from "../src/components/HistoryTab";

const ENTRY_OK = {
  url: "https://youtu.be/a",
  title: "Song One",
  mode: "audio",
  ok: true,
  ts: 1_760_800_000_000,
  filePath: "/music/Song One.mp3",
};

const ENTRY_FAIL = {
  url: "https://youtu.be/b",
  title: "https://youtu.be/b",
  mode: "video",
  ok: false,
  ts: 1_760_810_000_000,
  filePath: null,
};

describe("History tab", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue([]);
  });

  it("loads and lists entries newest first with mode icon, status and time", async () => {
    invokeMock.mockResolvedValue([ENTRY_OK, ENTRY_FAIL]);
    render(<HistoryTab />);
    await waitFor(async () => {
      expect(await screen.findByText("Song One")).toBeInTheDocument();
    });
    expect(screen.getByText("Song One")).toBeInTheDocument();
    expect(screen.getByText("https://youtu.be/b")).toBeInTheDocument();
    // mode icon contract stays: data-testid icon-<mode>
    expect(screen.getAllByTestId(/icon-/)).toHaveLength(2);
    expect(screen.getByTestId("icon-audio")).toBeInTheDocument();
    expect(screen.getByTestId("icon-video")).toBeInTheDocument();
    expect(screen.getByTestId("status-ok")).toBeInTheDocument();
    expect(screen.getByTestId("status-fail")).toBeInTheDocument();
    // failure row keeps URL context, success rows don't need it
    expect(screen.queryByText("https://youtu.be/a")).not.toBeInTheDocument();
  });

  it("shows empty state when no history", async () => {
    render(<HistoryTab />);
    await waitFor(async () => {
      expect(await screen.findByText(/no downloads yet/i)).toBeInTheDocument();
    });
  });

  it("shows error message on failure rows via title attribute", async () => {
    invokeMock.mockResolvedValue([
      { ...ENTRY_FAIL, title: "bot check hit" },
    ]);
    render(<HistoryTab />);
    await waitFor(async () => {
      expect(await screen.findByText("bot check hit")).toBeInTheDocument();
    });
  });
});
