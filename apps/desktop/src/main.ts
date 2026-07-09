/**
 * Electron Main Process — Client Shell (Layer 1)
 *
 * Responsibilities:
 * - Creates and manages the BrowserWindow lifecycle
 * - Registers IPC handlers for renderer-invoked operations
 * - Manages system tray for background presence
 * - Handles app lifecycle events (ready, activate, window-all-closed)
 *
 * Does NOT:
 * - Run business logic or domain services
 * - Establish WebSocket connections (deferred to renderer or a future main-process gateway)
 * - Access the database or network
 *
 * Ownership:
 * - BrowserWindow instance lifecycle
 * - System tray lifecycle
 * - IPC handler registration
 *
 * Design Decisions:
 * - IPC handlers are registered at module scope (not inside app.whenReady) because
 *   Electron accepts handler registration before app readiness; they remain inert until invoked.
 * - Window starts hidden (show: false) and reveals on ready-to-show to prevent a white flash.
 * - Hides instead of closing on macOS to match the platform convention of staying alive
 *   until Cmd+Q or "Quit" from the tray menu.
 */
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowserWindowOptions, IPC_CHANNELS, resolveRendererTarget, sanitizeNotificationInput, type NotificationInput } from "./config.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

const createTray = () => {
  // System tray keeps the app alive in the background when the window is closed,
  // which is the expected behavior for an IM desktop client (stay present for notifications).
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("Nexus Chat");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show Nexus Chat", click: () => mainWindow?.show() },
      { label: "Hide", click: () => mainWindow?.hide() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() }
    ])
  );
};

const createWindow = async () => {
  mainWindow = new BrowserWindow(getBrowserWindowOptions(path.join(dirname, "preload.js")));
  const target = resolveRendererTarget(dirname, process.env.VITE_DEV_SERVER_URL);
  if (target.type === "dev") await mainWindow.loadURL(target.url);
  else await mainWindow.loadFile(target.filePath);
  // Reveal only after the renderer finishes its initial paint to avoid a blank white flash.
  mainWindow.once("ready-to-show", () => mainWindow?.show());
};

// IPC handlers — each maps directly to a NexusDesktopApi method defined in preload.ts.
// The channel string must appear in IPC_CHANNELS to be accepted by preload's guard.
ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());
ipcMain.handle(IPC_CHANNELS.notificationsShow, (_event, input: NotificationInput) => new Notification(sanitizeNotificationInput(input)).show());
ipcMain.handle(IPC_CHANNELS.windowMinimize, () => mainWindow?.minimize());
ipcMain.handle(IPC_CHANNELS.windowMaximize, () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle(IPC_CHANNELS.windowClose, () => mainWindow?.close());
ipcMain.handle(IPC_CHANNELS.clipboardWriteText, (_event, text: string) => clipboard.writeText(text.slice(0, 20_000)));
// Phase 1: auto-update provider is not configured. Placeholder returns unavailable
// so the renderer can show a disabled state rather than an error.
ipcMain.handle(IPC_CHANNELS.updatesCheck, () => ({ available: false, reason: "Auto-update provider is not configured for Phase 1." }));

app.whenReady().then(async () => {
  createTray();
  await createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
