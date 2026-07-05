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

export const isAllowedIpcChannel = (channel: string): channel is IpcChannel => Object.values(IPC_CHANNELS).includes(channel as IpcChannel);

export const sanitizeNotificationInput = (input: NotificationInput): NotificationInput => ({
  title: input.title.slice(0, 120),
  body: input.body.slice(0, 500)
});

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

export const resolveRendererTarget = (dirname: string, devServerUrl?: string): RendererTarget => {
  if (devServerUrl) return { type: "dev", url: devServerUrl };

  return { type: "prod", filePath: path.join(dirname, "../../web/dist/index.html") };
};
