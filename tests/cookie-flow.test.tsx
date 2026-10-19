import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const handlers: Array<(e: { payload: unknown }) => void> = [];
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_e: string, handler: (e: { payload: unknown }) => void) => {
    handlers.push(handler);
    return Promise.resolve(() => {});
  },
}));

import DownloadTab from "../src/components/DownloadTab";

function emit(payload: unknown) {
  act(() => {
    handlers.forEach((h) => h({ payload }));
  });
}

describe("cookie fallback flow", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    openMock.mockReset();
    handlers.length = 0;
  });

  it("cookie-issue failure shows guidance banner with pick button and close-chrome hint", () => {
    render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "Chrome cookie DB is locked",
      stderrTail: "ERROR: could not copy chrome cookie database: locked",
      cookieIssue: true,
    });
    expect(screen.getByText("Chrome cookie DB is locked")).toBeInTheDocument();
    expect(screen.getByText(/close chrome and retry/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /pick cookies.txt/i })
    ).toBeInTheDocument();
  });

  it("non-cookie failure does not show banner", () => {
    render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "HTTP Error 404",
      stderrTail: "ERROR: HTTP Error 404",
      cookieIssue: false,
    });
    expect(
      screen.queryByText(/close chrome and retry/i)
    ).not.toBeInTheDocument();
  });

  it("pick button opens dialog, persists cookie file, dismisses banner", async () => {
    openMock.mockResolvedValue("/home/me/cookies.txt");
    const { container } = render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "",
      stderrTail: "ERROR: failed to decrypt",
      cookieIssue: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /pick cookies.txt/i })
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("set_cookie_file", {
        path: "/home/me/cookies.txt",
      });
    });
    expect(
      screen.queryByText(/close chrome and retry/i)
    ).not.toBeInTheDocument();
  });

  it("cancelled picker keeps banner", async () => {
    openMock.mockResolvedValue(null);
    render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "",
      stderrTail: "ERROR: failed to decrypt",
      cookieIssue: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /pick cookies.txt/i })
    );
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(
      screen.getByText(/close chrome and retry/i)
    ).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "set_cookie_file",
      expect.anything()
    );
  });

  it("after picking, dismissal clears error but preserves re-download state", async () => {
    openMock.mockResolvedValue("/c.txt");
    render(<DownloadTab />);
    emit({
      type: "finished",
      ok: false,
      message: "",
      stderrTail: "x",
      cookieIssue: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /pick cookies.txt/i }));
    await waitFor(() =>
      expect(
        screen.queryByText(/close chrome and retry/i)
      ).not.toBeInTheDocument()
    );
    // engine full output details should remain visible for post-mortem
    expect(screen.getByText(/full engine output/i)).toBeInTheDocument();
  });
});
