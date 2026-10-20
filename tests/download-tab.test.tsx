import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invokeMock = vi.fn();
const emitMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    _event: string,
    handler: (e: { payload: unknown }) => void
  ) => {
    emitMock.mockImplementation(emitMock);
    handlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

const handlers: Array<(e: { payload: unknown }) => void> = [];

import DownloadTab from "../src/components/DownloadTab";

function emit(payload: unknown) {
  act(() => {
    handlers.forEach((h) => h({ payload }));
  });
}

describe("Download tab", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    emitMock.mockReset();
    handlers.length = 0;
  });

  it("renders URL field, mp3/video toggle and Download button", () => {
    render(<DownloadTab />);
    expect(screen.getByLabelText(/url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mp3/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/video/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download/i })
    ).toBeInTheDocument();
  });

  it("button starts with mp3 pressed and passes mode to start_download", async () => {
    render(<DownloadTab />);
    const url = screen.getByLabelText(/url/i);
    fireEvent.change(url, { target: { value: "https://youtu.be/x" } });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_download", {
        url: "https://youtu.be/x",
        mode: "audio",
      })
    );
  });

  it("button switches to video mode", async () => {
    render(<DownloadTab />);
    fireEvent.click(screen.getByLabelText(/video/i));
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("start_download", {
        url: "https://youtu.be/x",
        mode: "video",
      })
    );
  });

  it("does not invoke with empty URL", async () => {
    render(<DownloadTab />);
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await new Promise((r) => setTimeout(r, 10));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("switches to running immediately on click, before any event", () => {
    render(<DownloadTab />);
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(screen.getByTestId("run-status")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /download/i })).toBeDisabled();
  });

  it("streams engine log lines while running", () => {
    render(<DownloadTab />);
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    emit({ type: "started", url: "https://youtu.be/x" });
    emit({ type: "log", line: "WARNING: Read timed out, retrying" });
    expect(screen.getByTestId("engine-log")).toHaveTextContent(
      "Read timed out"
    );
  });

  it("blocked preflight disables Download", () => {
    render(<DownloadTab blocked />);
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    expect(screen.getByRole("button", { name: /download/i })).toBeDisabled();
  });

  it("shows live percent and disables button while running", () => {    render(<DownloadTab />);
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    emit({ type: "started", url: "https://youtu.be/x" });
    emit({ type: "progress", pct: 45.2, speed: "5.60MiB/s", eta: "00:02" });
    expect(screen.getByText(/45.2%/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /download/i });
    expect(button).toBeDisabled();
  });

  it("re-enables button and marks done on finished event", () => {
    render(<DownloadTab />);
    fireEvent.change(screen.getByLabelText(/url/i), {
      target: { value: "https://youtu.be/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    emit({ type: "finished", ok: true, message: "", stderrTail: "" });
    expect(
      screen.getByRole("button", { name: /download/i })
    ).not.toBeDisabled();
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });

  it("shows one-line error and full stderr in details on failure", () => {
    render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "Sign in to confirm you're not a bot",
      stderrTail: "ERROR: Sign in to confirm...",
    });
    expect(
      screen.getByText("Sign in to confirm you're not a bot")
    ).toBeInTheDocument();
    const details = screen.getByText(/full engine output/i);
    fireEvent.click(details);
    expect(screen.getByText("ERROR: Sign in to confirm...")).toBeInTheDocument();
  });
});
