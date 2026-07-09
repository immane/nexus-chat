/**
 * Desktop Configuration Tests
 *
 * Covers:
 * - BrowserWindow security invariants (contextIsolation, sandbox, etc.)
 * - Renderer target resolution (dev vs prod paths)
 * - IPC channel allow-list membership
 * - Notification payload bounds
 */
import { describe, expect, it } from "vitest";
import { getBrowserWindowOptions, IPC_CHANNELS, isAllowedIpcChannel, resolveRendererTarget, sanitizeNotificationInput } from "./config.js";

describe("desktop security config", () => {
  it("keeps renderer isolated from Node.js privileges", () => {
    const options = getBrowserWindowOptions("/tmp/preload.js");

    expect(options.webPreferences?.contextIsolation).toBe(true);
    expect(options.webPreferences?.nodeIntegration).toBe(false);
    expect(options.webPreferences?.sandbox).toBe(true);
    expect(options.webPreferences?.webSecurity).toBe(true);
    expect(options.webPreferences?.preload).toBe("/tmp/preload.js");
  });

  it("resolves dev and production renderer targets", () => {
    expect(resolveRendererTarget("/app/desktop/dist", "http://localhost:5173")).toEqual({ type: "dev", url: "http://localhost:5173" });
    expect(resolveRendererTarget("/app/desktop/dist")).toEqual({ type: "prod", filePath: "/app/web/dist/index.html" });
  });
});

describe("desktop IPC contract", () => {
  it("allows only explicit preload API channels", () => {
    expect(isAllowedIpcChannel(IPC_CHANNELS.notificationsShow)).toBe(true);
    expect(isAllowedIpcChannel("fs:readFile")).toBe(false);
    expect(Object.values(IPC_CHANNELS)).toEqual([
      "app:getVersion",
      "notifications:show",
      "window:minimize",
      "window:maximize",
      "window:close",
      "clipboard:writeText",
      "updates:check"
    ]);
  });

  it("bounds notification payloads before IPC dispatch", () => {
    const sanitized = sanitizeNotificationInput({ title: "t".repeat(200), body: "b".repeat(600) });

    expect(sanitized.title).toHaveLength(120);
    expect(sanitized.body).toHaveLength(500);
  });
});
