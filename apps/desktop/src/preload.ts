import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, isAllowedIpcChannel, sanitizeNotificationInput, type NotificationInput } from "./config.js";

export type NexusDesktopApi = {
  app: { getVersion: () => Promise<string> };
  notifications: { show: (title: string, body: string) => Promise<void> };
  window: { minimize: () => Promise<void>; maximize: () => Promise<void>; close: () => Promise<void> };
  clipboard: { writeText: (text: string) => Promise<void> };
  updates: { check: () => Promise<{ available: boolean; reason: string }> };
};

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
