/**
 * Electron Preload Script — IPC Security Boundary
 *
 * Responsibilities:
 * - Exposes a typed window.nexus API to the renderer via contextBridge
 * - Enforces the IPC channel allow-list — unknown channels are rejected at runtime
 * - Sanitizes notification payloads before crossing the IPC boundary
 *
 * Dependencies:
 * - config.ts (IPC_CHANNELS, isAllowedIpcChannel, sanitizeNotificationInput)
 *
 * Forbidden Dependencies:
 * - Any Node.js APIs beyond contextBridge and ipcRenderer
 * - Any Electron main-process modules (app, BrowserWindow, etc.)
 *
 * Invariants:
 * - Every IPC call passes through isAllowedIpcChannel — no unlisted channel can reach main
 * - Notification strings are truncated before IPC dispatch
 * - NexusDesktopApi is the single source of truth for the renderer's main-process access
 *
 * Extension Points:
 * - Add a new method to NexusDesktopApi, register the corresponding IPC handler in main.ts,
 *   and add the channel to IPC_CHANNELS in config.ts
 */
import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, isAllowedIpcChannel, sanitizeNotificationInput, type NotificationInput } from "./config.js";

export type NexusDesktopApi = {
  app: { getVersion: () => Promise<string> };
  notifications: { show: (title: string, body: string) => Promise<void> };
  window: { minimize: () => Promise<void>; maximize: () => Promise<void>; close: () => Promise<void> };
  clipboard: { writeText: (text: string) => Promise<void> };
  updates: { check: () => Promise<{ available: boolean; reason: string }> };
};

/**
 * Wraps ipcRenderer.invoke with an allow-list guard.
 *
 * This is the only IPC invocation path exposed to the renderer — every call
 * is validated against IPC_CHANNELS before reaching the main process.
 */
const invoke = <T>(channel: string, ...args: unknown[]) => {
  if (!isAllowedIpcChannel(channel)) throw new Error(`IPC channel is not allowed: ${channel}`);

  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
};

const notification = (title: string, body: string): NotificationInput => sanitizeNotificationInput({ title, body });

const nexusApi: NexusDesktopApi = {
  app: { getVersion: () => invoke<string>(IPC_CHANNELS.appGetVersion) },
  notifications: { show: (title: string, body: string) => invoke<void>(IPC_CHANNELS.notificationsShow, notification(title, body)) },
  window: {
    minimize: () => invoke<void>(IPC_CHANNELS.windowMinimize),
    maximize: () => invoke<void>(IPC_CHANNELS.windowMaximize),
    close: () => invoke<void>(IPC_CHANNELS.windowClose)
  },
  clipboard: { writeText: (text: string) => invoke<void>(IPC_CHANNELS.clipboardWriteText, text.slice(0, 20_000)) },
  updates: { check: () => invoke<{ available: boolean; reason: string }>(IPC_CHANNELS.updatesCheck) }
};

contextBridge.exposeInMainWorld("nexus", nexusApi);

declare global {
  interface Window {
    nexus: NexusDesktopApi;
  }
}
