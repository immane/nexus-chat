/**
 * Desktop IPC Channel Configuration & Security Helpers
 *
 * Responsibilities:
 * - Defines the allow-list of IPC channels between main and renderer processes
 * - Provides typed wrappers and guards for IPC communication
 * - Manages BrowserWindow creation options with security invariants
 * - Resolves renderer target URL (dev server vs production build)
 *
 * Does NOT:
 * - Register IPC handlers (owned by main.ts)
 * - Import any Electron runtime modules
 *
 * Invariants:
 * - All IPC channels must be listed in IPC_CHANNELS before use
 * - Notification payloads are bounded to 120 chars title / 500 chars body
 * - BrowserWindow always uses contextIsolation=true, sandbox=true, nodeIntegration=false
 *
 * Related Modules:
 * - main.ts: consumes config options and IPC_CHANNELS
 * - preload.ts: consumes IPC_CHANNELS for allow-list enforcement
 */
import type { BrowserWindowConstructorOptions } from "electron";
import path from "node:path";

export const IPC_CHANNELS = {
  appGetVersion: "app:getVersion",
  notificationsShow: "notifications:show",
  windowMinimize: "window:minimize",
  windowMaximize: "window:maximize",
  windowClose: "window:close",
  clipboardWriteText: "clipboard:writeText",
  updatesCheck: "updates:check"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type NotificationInput = { title: string; body: string };
export type RendererTarget = { type: "dev"; url: string } | { type: "prod"; filePath: string };

/** Guards IPC channel against the allow-list; acts as a type-narrowing runtime check. */
export const isAllowedIpcChannel = (channel: string): channel is IpcChannel => Object.values(IPC_CHANNELS).includes(channel as IpcChannel);

/**
 * Bounds notification payloads to prevent IPC abuse.
 * Truncated to 120 title / 500 body — reasonable upper limits for desktop notifications.
 */
export const sanitizeNotificationInput = (input: NotificationInput): NotificationInput => ({
  title: input.title.slice(0, 120),
  body: input.body.slice(0, 500)
});

/**
 * Constructs BrowserWindow options with security-hardened defaults.
 *
 * Side Effects: None (pure function).
 *
 * Security Invariants:
 * - contextIsolation: true  — renderer shares no JavaScript context with preload
 * - nodeIntegration: false  — renderer cannot access Node.js APIs
 * - sandbox: true           — renderer runs with restricted Chromium sandbox
 * - webSecurity: true       — enforces same-origin policy
 */
export const getBrowserWindowOptions = (preloadPath: string): BrowserWindowConstructorOptions => ({
  width: 1280,
  height: 820,
  minWidth: 960,
  minHeight: 640,
  title: "Nexus Chat",
  backgroundColor: "#020617",
  show: false,
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true
  }
});

/**
 * Resolves the renderer entry point.
 * - When VITE_DEV_SERVER_URL is set, loads from the Vite dev server (hot-reload).
 * - Otherwise loads the production build from web/dist/index.html.
 */
export const resolveRendererTarget = (dirname: string, devServerUrl?: string): RendererTarget => {
  if (devServerUrl) return { type: "dev", url: devServerUrl };

  return { type: "prod", filePath: path.join(dirname, "../../web/dist/index.html") };
};
