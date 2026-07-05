import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, Notification, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowserWindowOptions, IPC_CHANNELS, resolveRendererTarget, sanitizeNotificationInput, type NotificationInput } from "./config.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

const createTray = () => {
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());
};

ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion());
ipcMain.handle(IPC_CHANNELS.notificationsShow, (_event, input: NotificationInput) => new Notification(sanitizeNotificationInput(input)).show());
ipcMain.handle(IPC_CHANNELS.windowMinimize, () => mainWindow?.minimize());
ipcMain.handle(IPC_CHANNELS.windowMaximize, () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle(IPC_CHANNELS.windowClose, () => mainWindow?.close());
ipcMain.handle(IPC_CHANNELS.clipboardWriteText, (_event, text: string) => clipboard.writeText(text.slice(0, 20_000)));
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
