---
lang: en
---

# 01 - Client Shell & UI Rendering Layer

> Design document for the Nexus Chat desktop application shell (Electron), Phase 1 terminal UI client, and React-based UI rendering layer.
> Covers process architecture, component tree, state management, interaction flows, and performance strategy.  
> Derived from [Frontend Architecture Research](../research/frontend-architecture.md).

---

## Table of Contents

1. [Electron Shell Architecture](#1-electron-shell-architecture)
   - 1.1 [Process Model](#11-process-model)
   - 1.2 [Main Process Responsibilities](#12-main-process-responsibilities)
   - 1.3 [Preload Script & IPC Bridge](#13-preload-script--ipc-bridge)
   - 1.4 [Renderer Process](#14-renderer-process)
   - 1.5 [Vite Plugin Electron Integration](#15-vite-plugin-electron-integration)
   - 1.6 [Multi-Window Strategy](#16-multi-window-strategy)
2. [React Application Structure](#2-react-application-structure)
   - 2.1 [Entry Point Hierarchy](#21-entry-point-hierarchy)
   - 2.2 [Route Table](#22-route-table)
   - 2.3 [Layout Components](#23-layout-components)
   - 2.4 [Code-Splitting Strategy](#24-code-splitting-strategy)
3. [Zustand State Management Architecture](#3-zustand-state-management-architecture)
   - 3.1 [Store Breakdown](#31-store-breakdown)
   - 3.2 [Selective Re-render via Selector Hooks](#32-selective-re-render-via-selector-hooks)
   - 3.3 [WebSocket Middleware Pattern](#33-websocket-middleware-pattern)
4. [Component Tree](#4-component-tree)
5. [Key Interaction Flows](#5-key-interaction-flows)
   - 5.1 [Sending a Message](#51-sending-a-message)
   - 5.2 [Receiving a Message](#52-receiving-a-message)
   - 5.3 [E2E Key Exchange on First DM](#53-e2e-key-exchange-on-first-dm)
   - 5.4 [Bot Slash Command](#54-bot-slash-command)
6. [Performance Strategy](#6-performance-strategy)
7. [Asset & Theme System](#7-asset--theme-system)
8. [Phase 1 TUI Command-Line Client](#8-phase-1-tui-command-line-client)

---

## 1. Electron Shell Architecture

### 1.1 Process Model

The application follows Electron's standard multi-process model with strict security boundaries:

```
┌──────────────────────────────────────────────────────────────┐
│  Main Process (Node.js)                                       │
│  ├── main.ts              Entry point, app lifecycle          │
│  ├── window-manager.ts    BrowserWindow creation & lifecycle  │
│  ├── tray.ts              System tray icon & context menu     │
│  ├── updater.ts           electron-updater integration        │
│  ├── notifications.ts     Native notification dispatch        │
│  ├── network-monitor.ts   Connectivity detection              │
│  └── ipc/
│      └── handlers.ts      IPC handler registration            │
├──────────────────────────────────────────────────────────────┤
│  Preload Script (contextBridge)                               │
│  └── preload.ts           Typed API exposed to renderer       │
├──────────────────────────────────────────────────────────────┤
│  Renderer Process (Chromium sandbox)                          │
│  ├── apps/web/            Vite-built React SPA                │
│  └── window.electronAPI   Type-safe IPC consumer              │
└──────────────────────────────────────────────────────────────┘
```

Security constraints:
- `contextIsolation: true` — renderer cannot access Node.js APIs directly.
- `sandbox: true` — renderer runs in an OS-level sandbox.
- All main process capabilities are gated through the preload script via `contextBridge.exposeInMainWorld`.

### 1.2 Main Process Responsibilities

#### Window Management

The `WindowManager` class owns the lifecycle of all `BrowserWindow` instances:

```typescript
// electron/window-manager.ts
class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private popupWindows = new Map<string, BrowserWindow>()

  createMainWindow(): BrowserWindow {
    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',            // macOS native title bar
      webPreferences: {
        preload: join(__dirname, 'preload.mjs'),
        contextIsolation: true,
        sandbox: true,
      },
    })

    if (import.meta.env.DEV) {
      this.mainWindow.loadURL('http://localhost:5173')
    } else {
      this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    return this.mainWindow
  }

  openPopup(id: string, url: string, opts?: Partial<BrowserWindowConstructorOptions>): BrowserWindow {
    const existing = this.popupWindows.get(id)
    if (existing && !existing.isDestroyed()) {
      existing.focus()
      return existing
    }
    const win = new BrowserWindow({
      width: 400,
      height: 600,
      parent: this.mainWindow!,
      ...opts,
      webPreferences: {
        preload: join(__dirname, 'preload.mjs'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    win.loadURL(url)
    win.on('closed', () => this.popupWindows.delete(id))
    this.popupWindows.set(id, win)
    return win
  }
}
```

#### System Tray

A tray icon provides quick access to show/hide the main window and quit the application:

```typescript
// electron/tray.ts
export function createTray(mainWindow: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '../assets/tray-icon.png'))
  const tray = new Tray(icon.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show/Hide', click: () =>
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])

  tray.setToolTip('Nexus Chat')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => mainWindow.show())
  return tray
}
```

#### Native Notifications

Messages arriving while the window is not focused generate OS-level notifications:

```typescript
// electron/notifications.ts
export function showNotification(
  title: string,
  body: string,
  onClick?: () => void,
): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({ title, body, silent: false })
  if (onClick) {
    notification.on('click', onClick)
  }
  notification.show()
}
```

Badge strategy:
- **macOS**: `app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '')`
- **Windows**: `mainWindow.setOverlayIcon(icon, 'Unread messages')`

#### Auto-Updater (electron-updater)

The updater employs a user-consent workflow: check automatically, download on user request, install on quit.

```typescript
// electron/updater.ts
export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    mainWindow.webContents.send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('update:progress', progress.percent)
  })

  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update:ready')
  })

  // Check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
  autoUpdater.checkForUpdates()
}
```

### 1.3 Preload Script & IPC Bridge

The preload script exposes a strictly typed API surface via `contextBridge`:

```typescript
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  // ── Window controls ──────────────────────────────────
  minimize:    () => ipcRenderer.invoke('window:minimize'),
  maximize:    () => ipcRenderer.invoke('window:maximize'),
  close:       () => ipcRenderer.invoke('window:close'),

  // ── File dialog ──────────────────────────────────────
  openFileDialog: (opts?: OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:open-file', opts),

  // ── Notifications ────────────────────────────────────
  onNotification: (callback: (data: NotificationData) => void) => {
    const handler = (_event: IpcRendererEvent, data: NotificationData) => callback(data)
    ipcRenderer.on('notification:new', handler)
    return () => ipcRenderer.removeListener('notification:new', handler)
  },

  // ── Clipboard ────────────────────────────────────────
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard:  () => ipcRenderer.invoke('clipboard:read'),

  // ── App metadata ─────────────────────────────────────
  getAppVersion:   () => ipcRenderer.invoke('app:version'),
  checkForUpdate:  () => ipcRenderer.invoke('app:check-update'),
  downloadUpdate:  () => ipcRenderer.invoke('app:download-update'),
  installUpdate:   () => ipcRenderer.invoke('app:install-update'),

  // ── Network events (main → renderer) ─────────────────
  onNetworkStatusChange: (callback: (status: { online: boolean }) => void) => {
    const handler = (_e: IpcRendererEvent, status: { online: boolean }) => callback(status)
    ipcRenderer.on('network:status-change', handler)
    return () => ipcRenderer.removeListener('network:status-change', handler)
  },
} as const

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
```

**Type declaration** for the renderer process:

```typescript
// src/types/electron.d.ts
import type { electronAPI } from '../../electron/preload'

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
```

**IPC design rules:**

| Rule | Rationale |
|------|-----------|
| Channel naming: `namespace:action` | Predictable, grep-friendly |
| Prefer `invoke`/`handle` (Promise-based) | Non-blocking; avoid `sendSync` |
| One-way events via `webContents.send` | For main→renderer push (e.g., notifications, update progress) |
| Every `on` listener returns a cleanup function | Prevent memory leaks on component unmount |

### 1.4 Renderer Process

The renderer loads the Vite-built React application from `apps/web`. In development, it connects to the Vite dev server at `localhost:5173`. In production, it loads the static files bundled into the Electron app.

The React app owns all UI rendering, routing, and client-side state. It communicates with the main process exclusively through `window.electronAPI`.

### 1.5 Vite Plugin Electron Integration

The project uses **vite-plugin-electron v1.0.4** with the `simple` API for zero-config startup:

```typescript
// vite.config.ts (simplified)
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'

export default defineConfig({
  plugins: [
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron', 'electron-updater', 'electron-store'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    ]),
    renderer(),
  ],
})
```

Key capabilities provided by the plugin:
- Hot restart of the main process on source changes during development.
- Automatic ESM compatibility shim (`__dirname` / `__filename`).
- `notBundle` plugin for externalizing dependencies during development to accelerate rebuilds.

### 1.6 Multi-Window Strategy

Nexus Chat adopts a **single main window + on-demand popup windows** model:

| Window | Trigger | Behavior |
|--------|---------|----------|
| **Main chat window** | App launch | Single `BrowserWindow` hosting the full React SPA; all workspace/channel switching happens in-window via React Router |
| **Settings popup** | User opens Settings | Independent `BrowserWindow` (400×600), parented to main window; loads a dedicated route |
| **Video/voice call** (future) | User initiates call | Detached popup so the call persists while navigating the main window |

Rationale:
- Single main window avoids the complexity of cross-window state synchronization.
- Popups for auxiliary workflows (settings, calls) keep them from interfering with the main chat view.
- All windows share the same preload script, so the IPC API is uniform.

---

## 2. React Application Structure

### 2.1 Entry Point Hierarchy

```
main.tsx          →  ReactDOM.createRoot, providers, global styles
  └── App.tsx      →  Router, layout shell, top-level error boundary
        └── Router  →  Route definitions (React Router v7)
              └── Pages  →  AuthPage | ChatPage | SettingsPage
```

**`main.tsx`** responsibilities:
- Mount the React tree into `#root`.
- Wrap with `<ThemeProvider>` (applies dark/light class on `<html>`).
- Wrap with `<QueryClientProvider>` (TanStack Query for server data, if used).
- Import global CSS (`styles/theme.css`).

**`App.tsx`** responsibilities:
- Instantiate React Router with the route table.
- Render the top-level `<ErrorBoundary>`.
- Optionally initialize WebSocket connection on mount.

### 2.2 Route Table

| Path | Page Component | Description |
|------|---------------|-------------|
| `/auth/login` | `AuthPage` (LoginForm) | Email/password login |
| `/auth/register` | `AuthPage` (RegisterForm) | Account creation |
| `/chat/:workspaceId/:channelId?` | `ChatPage` | Main chat UI; optional `channelId` for deep-linking |
| `/settings` | `SettingsPage` | Application settings |

Code structure:

```typescript
// src/router.tsx
const ChatPage = lazy(() => import('@/pages/chat'))
const AuthPage = lazy(() => import('@/pages/auth'))
const SettingsPage = lazy(() => import('@/pages/settings'))

export function AppRouter() {
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <Routes>
        <Route path="/auth/login" element={<AuthPage mode="login" />} />
        <Route path="/auth/register" element={<AuthPage mode="register" />} />
        <Route path="/chat/:workspaceId/:channelId?" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/auth/login" replace />} />
      </Routes>
    </Suspense>
  )
}
```

### 2.3 Layout Components

The primary layout shell is `WorkspaceLayout`, active within `ChatPage`:

```
┌─────────────────────────────────────────────────────────┐
│ WorkspaceLayout                                          │
│ ┌───────────┬──────────────────────┬──────────────────┐ │
│ │           │                      │                  │ │
│ │  Sidebar  │     Main Panel       │   Detail Panel   │ │
│ │  (260px)  │     (flex-1)         │   (320px, cond)  │ │
│ │           │                      │                  │ │
│ └───────────┴──────────────────────┴──────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- **Sidebar** (`WorkspaceSidebar`): Fixed 260px. Contains workspace switcher and channel list.
- **Main Panel**: Flex-grows to fill remaining space. Contains channel header, message list, and message input.
- **Detail Panel**: Conditionally rendered (320px). Shows channel info or member list when a channel header action is triggered.

The `DetailPanel` is toggled via `uiStore.detailPanel`, avoiding a separate route and preserving scroll position in the message list.

### 2.4 Code-Splitting Strategy

All page-level components are loaded via `React.lazy` + `<Suspense>`:

```typescript
const ChatPage     = lazy(() => import('@/pages/chat'))
const AuthPage     = lazy(() => import('@/pages/auth'))
const SettingsPage = lazy(() => import('@/pages/settings'))
```

Additionally, heavy interactive widgets are split at the component level:
- `EmojiPicker` — lazy-loaded on first focus of the emoji button.
- `FilePreview` (image/video viewer) — lazy-loaded on file click.
- `CommandPalette` (Cmd+K) — lazy-loaded on first keyboard invocation.

This ensures the initial bundle for the auth page is minimal (<100 KB gzipped), and the chat page's critical path (message list + input) loads without waiting for auxiliary components.

---

## 3. Zustand State Management Architecture

### 3.1 Store Breakdown

Each store is a standalone Zustand `create` call, split by domain:

#### `authStore`

| Field / Action | Type | Description |
|---------------|------|-------------|
| `accessToken` | `string \| null` | JWT access token |
| `refreshToken` | `string \| null` | JWT refresh token |
| `user` | `User \| null` | Current user profile (id, displayName, avatarUrl) |
| `isAuthenticated` | `boolean` | Derived: `accessToken !== null` |
| `login(email, password)` | `async () => void` | Authenticate, store tokens |
| `logout()` | `() => void` | Clear tokens, disconnect WS, navigate to /auth/login |
| `refreshSession()` | `async () => void` | Silent token refresh via refreshToken |

Tokens are persisted in `electron-store` (encrypted, keychain-backed) rather than Zustand persist middleware, because tokens are security-sensitive.

#### `workspaceStore`

| Field / Action | Type | Description |
|---------------|------|-------------|
| `workspaces` | `Workspace[]` | All workspaces the user belongs to |
| `currentWorkspaceId` | `string \| null` | Currently active workspace |
| `members` | `Record<string, Member[]>` | Members keyed by workspaceId |
| `setWorkspaces(ws)` | `(ws: Workspace[]) => void` | Set workspace list |
| `switchWorkspace(id)` | `(id: string) => void` | Switch active workspace |

#### `channelStore`

| Field / Action | Type | Description |
|---------------|------|-------------|
| `channels` | `Map<string, Channel>` | Channel entities keyed by id |
| `currentChannelId` | `string \| null` | Currently viewed channel |
| `unreadCounts` | `Record<string, number>` | Unread count per channel |
| `e2eFlags` | `Record<string, boolean>` | Whether channel has E2E session established |
| `switchChannel(id)` | `(id: string) => void` | Switch active channel, clear unread |
| `incrementUnread(channelId)` | `(id: string) => void` | Bump unread count |

#### `messageStore`

Uses normalized storage with a `Map` for O(1) lookups and a separate ordering array:

```typescript
interface MessageStoreState {
  messageMap:    Map<string, Message>        // id → Message
  channelOrder:  Record<string, string[]>    // channelId → [messageId, ...]
  cursors:       Record<string, { oldest?: string; newest?: string; hasMore: boolean }>

  upsertMessages:  (channelId: string, msgs: Message[]) => void
  loadOlderMessages: (channelId: string, beforeId: string) => Promise<void>
  appendNewMessage: (channelId: string, msg: Message) => void
  updateMessageStatus: (tempId: string, serverId: string, status: MessageStatus) => void
}
```

Key design decisions:
- **Map + order array** (normalized): O(1) lookup by id, ordered rendering via ID list.
- **Cursor-based pagination**: `cursors[channelId]` tracks the oldest/newest loaded message ID and whether more exist.
- **Deduplication on upsert**: If a message ID already exists in the Map, fields are merged (for status updates, edits); otherwise inserted in timestamp order.

Rendering selector (derives array from normalized storage):

```typescript
const selectMessages = (channelId: string) => (state: MessageStoreState): Message[] => {
  const order = state.channelOrder[channelId]
  if (!order) return []
  return order.map(id => state.messageMap.get(id)!).filter(Boolean)
}
```

#### `presenceStore`

| Field / Action | Type | Description |
|---------------|------|-------------|
| `onlineUsers` | `Set<string>` | Set of online user IDs |
| `typingIndicators` | `Record<string, string[]>` | ChannelId → array of typing user displayNames |
| `setUserOnline(userId, online)` | `Function` | Update single user presence |
| `setTyping(channelId, userId, isTyping)` | `Function` | Update typing indicator |

#### `signalStore`

Manages the E2EE encryption state:

| Field / Action | Type | Description |
|---------------|------|-------------|
| `preKeyBundles` | `Map<string, PreKeyBundle>` | Cached PreKeyBundles keyed by userId |
| `sessions` | `Map<string, SessionRecord>` | Active Signal sessions keyed by `channelId:userId` |
| `encryptionReady` | `Record<string, boolean>` | Whether E2E session is established per channel |
| `fetchPreKeyBundle(userId)` | `async () => void` | Fetch and cache a user's PreKeyBundle |
| `initiateSession(channelId, peerUserId)` | `async () => void` | X3DH key agreement |
| `encrypt(channelId, plaintext)` | `(ch, str) => Ciphertext` | Encrypt message for channel |
| `decrypt(channelId, ciphertext)` | `(ch, ct) => string` | Decrypt received message |

#### `uiStore`

| Field / Action | Type | Description |
|---------------|------|-------------|
| `sidebarCollapsed` | `boolean` | Whether left sidebar is collapsed |
| `detailPanelOpen` | `boolean` | Whether detail panel is visible |
| `theme` | `'light' \| 'dark' \| 'system'` | Active theme |
| `fontSize` | `'small' \| 'medium' \| 'large'` | Font size preference |
| `modalStack` | `string[]` | Stack of open modal IDs (for nested modal handling) |
| `toggleSidebar()` | `() => void` | Toggle sidebar |
| `setTheme(theme)` | `(t: Theme) => void` | Set theme preference |
| `pushModal(id)` / `popModal()` | `Function` | Modal stack management |

`uiStore` is the only store using `zustand/middleware/persist` (localStorage-backed), as it contains only non-sensitive preferences.

### 3.2 Selective Re-render via Selector Hooks

Every component subscribes to the narrowest possible slice of state to avoid cascade re-renders:

```typescript
// Only re-renders when this channel's messages change
const messages = useMessageStore(s => s.messageMap)

// Shallow comparison for object selectors
import { useShallow } from 'zustand/react/shallow'

const { messages, hasMore } = useMessageStore(
  useShallow(s => ({
    messages: selectMessages(channelId)(s),
    hasMore: s.cursors[channelId]?.hasMore ?? false,
  }))
)
```

Cross-store interactions use `store.getState()` rather than hooks, so side effects don't create unintended component subscriptions:

```typescript
// Inside messageStore appendNewMessage:
appendNewMessage: (channelId, msg) => {
  set(state => { /* update messageMap and channelOrder */ })
  // Cross-store: bump unread count without subscribing
  const { incrementUnread } = useChannelStore.getState()
  incrementUnread(channelId)
}
```

### 3.3 WebSocket Middleware Pattern

The WebSocket connection is managed via a Zustand middleware that encapsulates the lifecycle (connect, reconnect with exponential backoff, disconnect):

```typescript
// stores/ws-middleware.ts
export function websocketMiddleware<State extends { ws: WebSocket | null }>(
  url: string,
  onMessage: (event: MessageEvent, set: any, get: any) => void,
): StateCreator<State & WSActions> {
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0

  return (set, get, api) => ({
    ...api,
    ws: null,

    wsConnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return

      socket = new WebSocket(url)

      socket.onopen = () => {
        set({ ws: socket } as any)
        attempts = 0
      }

      socket.onmessage = (event) => onMessage(event, set, get)

      socket.onclose = () => {
        set({ ws: null } as any)
        const delay = Math.min(1000 * 2 ** attempts, 30000)
        attempts++
        reconnectTimer = setTimeout(() => {
          (get as any)().wsConnect()
        }, delay)
      }
    },

    wsDisconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
      attempts = 0
      set({ ws: null } as any)
    },

    wsSend: (event, payload) => {
      socket?.send(JSON.stringify({ event, payload }))
    },
  })
}
```

The `onMessage` callback dispatches to the appropriate store based on the WebSocket event type:

```
ws message → { event: "message:new", payload: {...} }
  ├── "message:new"        → messageStore.upsertMessages
  ├── "message:ack"        → messageStore.updateMessageStatus
  ├── "presence:update"    → presenceStore.setUserOnline
  ├── "typing:start"       → presenceStore.setTyping
  ├── "channel:created"    → channelStore.addChannel
  └── "signal:prekey"      → signalStore.fetchPreKeyBundle → initiateSession
```

---

## 4. Component Tree

The following diagram shows the full component hierarchy rendered by the React application:

```
App
├── AuthPage
│   ├── LoginForm
│   └── RegisterForm
├── ChatPage
│   ├── WorkspaceLayout
│   │   ├── WorkspaceSidebar
│   │   │   ├── WorkspaceSwitcher
│   │   │   └── ChannelList
│   │   │       ├── ChannelSection           (public channels)
│   │   │       │   └── ChannelItem
│   │   │       ├── ChannelSection           (private channels)
│   │   │       │   └── ChannelItem
│   │   │       └── DMSection
│   │   │           └── ChannelItem
│   │   ├── MainPanel
│   │   │   ├── ChannelHeader
│   │   │   │   ├── ChannelName
│   │   │   │   └── E2EBanner               (conditional: !encryptionReady)
│   │   │   ├── MessageList                 (react-virtuoso)
│   │   │   │   ├── DateDivider
│   │   │   │   └── MessageItem
│   │   │   │       ├── MessageAvatar
│   │   │   │       ├── MessageContent       (markdown/emoji)
│   │   │   │       └── MessageToolbar       (hover: react, edit, delete, copy)
│   │   │   └── MessageInput
│   │   │       ├── InputActionBar             (bot-registered actions:
│   │   │       │   file upload, polls, etc.)  │   (extension slot)
│   │   │       ├── TextEditor                 (Slate.js or textarea)
│   │   │       ├── EmojiPicker                (lazy-loaded)
│   │   │       └── SendButton
│   │   └── DetailPanel                      (conditional: uiStore.detailPanelOpen)
│   │       ├── ChannelInfo
│   │       └── MemberList
│   └── OfflineBanner                        (conditional: !isOnline)
└── SettingsPage
    ├── AppearanceSettings
    ├── NotificationSettings
    └── AccountSettings
```

### Memoization Points

| Component | Optimization | Reason |
|-----------|-------------|--------|
| `MessageItem` | `React.memo` with custom comparator on `id`, `text`, `status` | Rendered 50+ times per view; only re-render when content changes |
| `ChannelItem` | `React.memo` on `id`, `name`, `unreadCount` | Sidebar renders all channels; avoid re-rendering the entire list |
| `MessageAvatar` | `React.memo` on `userId` | Pure visual; change only when avatar URL or presence dot changes |
| `DateDivider` | `React.memo` on `date string` | Rendered once per day boundary; effectively static after mount |
| `MessageContent` | `React.memo` on `text` | Markdown rendering is expensive; re-render only on text change |
| `WorkspaceSwitcher` | `React.memo` on `workspaces`, `currentWorkspaceId` | Rarely changes |

---

## 5. Key Interaction Flows

### 5.1 Sending a Message

```
User types text + Enter
        │
        ▼
MessageInput.onSubmit(text)
        │
        ├── 1. Generate tempId (crypto.randomUUID())
        ├── 2. Create optimistic Message {id: tempId, status: 'sending'}
        │      └── messageStore.upsertMessages(channelId, [optimisticMsg])
        │           └── React re-renders MessageList with new bubble (status icon: clock)
        │
        ├── 3. Network check
        │      ├── Online  → wsSend('message:send', {tempId, channelId, text})
        │      └── Offline → offlineQueueStore.enqueue({tempId, channelId, text})
        │
        ▼
Server receives → validates → persists → broadcasts to channel members
        │
        ▼
Server → Client ACK: {event: "message:ack", tempId, serverId, timestamp}
        │
        ▼
messageStore.updateMessageStatus(tempId, serverId, 'sent')
        └── React re-renders: clock icon → check icon, tempId → serverId
```

### 5.2 Receiving a Message

```
WebSocket push: {event: "message:new", payload: {id, channelId, senderId, text, timestamp, ciphertext?}}
        │
        ├── 1. If ciphertext present → signalStore.decrypt(channelId, ciphertext) → plaintext
        │
        ├── 2. messageStore.upsertMessages(channelId, [message])
        │      └── Deduplication check: if id already in messageMap, skip or merge
        │      └── Insert in timestamp order into channelOrder
        │
        ├── 3. If channelId !== currentChannelId → channelStore.incrementUnread(channelId)
        │
        ├── 4. If window not focused → main process showNotification(title, body)
        │      └── Notification click → window.focus() + navigate to channel
        │
        └── 5. React re-renders MessageList (Virtuoso followOutput scrolls to bottom)
```

### 5.3 E2E Key Exchange on First DM

```
User opens DM with peer for the first time
        │
        ▼
signalStore.encryptionReady[channelId] === false
        │
        ▼
E2EBanner displayed: "End-to-end encryption is being set up..."
        │
        ├── 1. signalStore.fetchPreKeyBundle(peerUserId)
        │      └── GET /api/users/:peerUserId/prekey-bundle
        │      └── Store in signalStore.preKeyBundles.set(peerUserId, bundle)
        │
        ├── 2. signalStore.initiateSession(channelId, peerUserId)
        │      ├── X3DH key agreement using local identity key + peer's PreKeyBundle
        │      ├── Establish SessionRecord
        │      └── signalStore.sessions.set(`${channelId}:${peerUserId}`, session)
        │
        ├── 3. signalStore.encryptionReady[channelId] = true
        │
        └── E2EBanner dismisses; all subsequent messages encrypted via Signal session
```

### 5.4 Bot Slash Command

```
User types "/" in MessageInput
        │
        ▼
Autocomplete popup appears (filtered list of available slash commands)
        │
        ├── Commands sourced from botStore (installed bots' manifests):
        │   /botname <command> [args...]  ← dynamically populated by installed bots
        │   e.g. @PollBot: /poll "Q" "A" "B" · @RemindBot: /remind me <when> <msg>
        │        @AIBot: /ai ask|summarize|translate · @FileBot: /file upload|list
        │
        ▼
User selects command (click or Tab + Enter)
        │
        ▼
TextEditor inserts command template: "/botname "
        │
        ▼
User completes arguments and presses Enter
        │
        ▼
Interaction sent as `bot.command.invoke` with payload: {botName, command, args}
        │
        ▼
uiStore.commandPending → transient command status rendered (not persisted message)
        │
        ▼
wsSend('bot.command.invoke', {botName, command, args, channelId})
        │
        ▼
Server routes to bot engine → bot processes → response message pushed back via WS
        │
        ▼
Response appears as a new message in the channel (potentially with rich embeds)
```

---

## 6. Performance Strategy

### 6.1 Virtual Scrolling

`react-virtuoso` handles the message list with the following configuration:

```typescript
<Virtuoso
  ref={virtuosoRef}
  data={messages}
  startReached={loadOlder}               // infinite scroll upward for history
  followOutput={atBottom ? 'smooth' : false}  // auto-scroll to new messages
  initialTopMostItemIndex={messages.length - 1} // start at bottom
  increaseViewportBy={{ top: 200, bottom: 200 }} // pre-render padding
  itemContent={(_, msg) => <ChatMessageItem message={msg} />}
  components={{
    ScrollSeekPlaceholder: ({ height }) => (
      <div style={{ height }} className="bg-muted/20" />
    ),
  }}
/>
```

Key settings:
- **Bidirectional scrolling**: `startReached` for history, `followOutput` for new messages.
- **ScrollSeekPlaceholder**: Shows placeholder skeletons during fast scroll to avoid blank flicker.
- **Viewport padding** (200px): Pre-renders items just outside the viewport so scrolling into them is instant.

### 6.2 Zustand Selector Precision

Every component subscribes to the narrowest state slice:

```typescript
// ChannelItem only subscribes to its own channel's data
function ChannelItem({ channelId }: { channelId: string }) {
  const channel = useChannelStore(useShallow(s => {
    const ch = s.channels.get(channelId)
    return ch ? { id: ch.id, name: ch.name, type: ch.type } : null
  }))
  const unreadCount = useChannelStore(s => s.unreadCounts[channelId] ?? 0)
  // ...
}
```

### 6.3 React.memo

Applied to leaf components rendered in lists:

| Component | Custom Comparator |
|-----------|------------------|
| `MessageItem` | `prev.message.id === next.message.id && prev.message.text === next.message.text && prev.message.status === next.message.status` |
| `ChannelItem` | `prev.channelId === next.channelId && prev.unreadCount === next.unreadCount` |
| `MessageAvatar` | `prev.userId === next.userId` |

### 6.4 Image Lazy Loading

Message attachments use native `loading="lazy"` and an `IntersectionObserver`-based visibility detector:

```typescript
function MessageAttachment({ url, mimetype }: AttachmentProps) {
  const [inView, ref] = useInView({ triggerOnce: true, rootMargin: '200px' })

  if (mimetype.startsWith('image/')) {
    return (
      <div ref={ref}>
        {inView ? (
          <img src={url} loading="lazy" className="max-w-sm rounded-md" />
        ) : (
          <div className="h-32 w-48 bg-muted animate-pulse rounded-md" />
        )}
      </div>
    )
  }
  // ...
}
```

### 6.5 Code Splitting per Route

Route-level splitting ensures the auth page bundle is small and the chat page only loads what it needs:

```
Initial load (auth page):  ~80 KB gzipped  (React + auth components)
Chat page (lazy):          ~120 KB gzipped  (Virtuoso + message components + stores)
Settings page (lazy):      ~30 KB gzipped   (settings forms)
EmojiPicker (lazy):        ~25 KB gzipped   (emoji data)
```

### 6.6 Memory Control for Long Message Lists

Zustand keeps only the last **200 messages per channel** in memory; older messages live in IndexedDB:

```typescript
const MEMORY_WINDOW = 200

function trimMessageMemory(channelId: string): void {
  const { channelOrder, messageMap } = useMessageStore.getState()
  const ids = channelOrder[channelId] ?? []

  if (ids.length <= MEMORY_WINDOW) return

  const toRemove = ids.slice(0, ids.length - MEMORY_WINDOW)
  const newMap = new Map(messageMap)
  for (const id of toRemove) newMap.delete(id)

  useMessageStore.setState({
    messageMap: newMap,
    channelOrder: {
      ...channelOrder,
      [channelId]: ids.slice(ids.length - MEMORY_WINDOW),
    },
  })
}
```

`trimMessageMemory` is called after `loadOlderMessages` completes and when the user switches channels.

---

## 7. Asset & Theme System

### 7.1 Tailwind CSS v4 Design Tokens

Design tokens are defined via Tailwind v4's `@theme` directive in a single CSS file:

```css
/* src/styles/theme.css */
@import 'tailwindcss';

@theme {
  /* ── Brand ─────────────────────────────────────────── */
  --color-primary:            #6C5CE7;
  --color-primary-light:      #A29BFE;
  --color-primary-dark:       #4A3DB7;
  --color-primary-foreground: #FFFFFF;

  /* ── Semantic ──────────────────────────────────────── */
  --color-success:  #00B894;
  --color-warning:  #FDCB6E;
  --color-danger:   #E17055;
  --color-info:     #74B9FF;

  /* ── Neutral palette ───────────────────────────────── */
  --color-bg-base:    #FFFFFF;
  --color-bg-muted:   #F5F5F5;
  --color-bg-subtle:  #EBEBEB;
  --color-border:     #E0E0E0;
  --color-text-primary:    #1A1A2E;
  --color-text-secondary:  #636E72;
  --color-text-muted:      #B2BEC3;

  /* ── Dark mode overrides ───────────────────────────── */
  --color-bg-base-dark:     #1A1A2E;
  --color-bg-muted-dark:    #16213E;
  --color-bg-subtle-dark:   #0F3460;
  --color-border-dark:      #2D3436;
  --color-text-primary-dark:    #DFE6E9;
  --color-text-secondary-dark:  #B2BEC3;
  --color-text-muted-dark:      #636E72;

  /* ── Spacing ───────────────────────────────────────── */
  --spacing-chat-input: 56px;
  --spacing-sidebar:    260px;

  /* ── Border radius ─────────────────────────────────── */
  --radius-msg:    12px;
  --radius-avatar: 50%;
  --radius-card:   8px;

  /* ── Shadows ───────────────────────────────────────── */
  --shadow-msg:      0 1px 3px rgb(0 0 0 / 0.08);
  --shadow-sidebar:  1px 0 4px rgb(0 0 0 / 0.06);
  --shadow-popup:    0 4px 24px rgb(0 0 0 / 0.12);

  /* ── Typography ────────────────────────────────────── */
  --font-sans:  'Inter', 'SF Pro Text', system-ui, sans-serif;
  --font-mono:  'JetBrains Mono', 'SF Mono', monospace;

  /* ── Animations ────────────────────────────────────── */
  --animate-fade-in:  fade-in 150ms ease-out;
  --animate-slide-up: slide-up 200ms ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

### 7.2 Dark/Light Theme Switching

Theme switching uses CSS custom properties with Tailwind's `dark:` variant:

```typescript
// hooks/use-theme.ts
export function useTheme() {
  const theme = useUIStore(s => s.theme)
  const setTheme = useUIStore(s => s.setTheme)

  useEffect(() => {
    const root = document.documentElement

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      root.classList.toggle('dark', mq.matches)
      const handler = (e: MediaQueryListEvent) => root.classList.toggle('dark', e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    }

    root.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return { theme, setTheme }
}
```

In CSS, dark-mode token overrides are applied when the `.dark` class is present:

```css
.dark {
  --color-bg-base:    var(--color-bg-base-dark);
  --color-bg-muted:   var(--color-bg-muted-dark);
  --color-bg-subtle:  var(--color-bg-subtle-dark);
  --color-border:     var(--color-border-dark);
  --color-text-primary:    var(--color-text-primary-dark);
  --color-text-secondary:  var(--color-text-secondary-dark);
  --color-text-muted:      var(--color-text-muted-dark);
}
```

### 7.3 Icon Set

**Lucide React** (`lucide-react ^0.460`) is the exclusive icon library, consistent with the shadcn/ui ecosystem. Key principles:

- All icons imported individually to support tree-shaking: `import { Send, Paperclip, Smile } from 'lucide-react'`
- Icon sizes standardized via Tailwind classes: `size-4` (16px), `size-5` (20px), `size-6` (24px)
- Stroke width defaults to 2px; adjust via `strokeWidth` prop only when necessary (e.g., `strokeWidth={1.5}` for smaller sizes)

### 7.4 Component Variants (CVA)

`class-variance-authority` (cva) manages component style variants, integrated with `clsx` + `tailwind-merge` via a `cn()` utility:

```typescript
// src/lib/cn.ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

Example — message bubble variants:

```typescript
const messageBubble = cva(
  'relative max-w-[70%] rounded-msg px-3 py-2 text-sm leading-relaxed',
  {
    variants: {
      align: {
        left:  'bg-muted text-text-primary',
        right: 'bg-primary text-primary-foreground',
      },
      isFirst: { true: '', false: '' },
      isLast:  { true: '', false: '' },
    },
    compoundVariants: [
      { align: 'left',  isFirst: true, className: 'rounded-bl-sm' },
      { align: 'left',  isLast:  true, className: 'rounded-tl-sm' },
      { align: 'right', isFirst: true, className: 'rounded-br-sm' },
      { align: 'right', isLast:  true, className: 'rounded-tr-sm' },
    ],
  },
)
```

---

## 8. Phase 1 TUI Command-Line Client

The Phase 1 terminal client lives in `apps/tui` and uses the same shared contracts as the Electron/Web clients. It is intentionally smaller than the GUI: its primary value is fast keyboard-first usage, local development, and deterministic smoke tests for CI.

### 8.1 Scope

| Capability | Phase 1 Requirement |
|------------|---------------------|
| Auth | `nexus login/logout/whoami` against the same REST API as the web client |
| Navigation | List/select workspaces, channels, and 1:1 DMs |
| Messaging | Open a channel/DM, render recent messages, send text over WebSocket |
| E2E | Establish 1:1 DM sessions through `packages/signal`; send/read encrypted and read-once messages |
| Bots | Invoke slash commands in normal channels and render bot replies |
| CI smoke | Non-interactive `send`, `read`, `e2e-smoke`, and `bot-smoke` commands with deterministic exit codes |

### 8.2 Boundaries

- The TUI must import schemas and event names from `packages/shared`; no duplicate API types.
- The TUI must use `packages/signal` for encryption and decryption; no separate crypto implementation.
- Local token storage should prefer the OS keychain when available. `.env` or plaintext fallback is allowed only for local development and CI.
- The TUI is not a feature-specific admin tool. Admin and incident-response commands are deferred unless explicitly promoted into a later phase.

---

## Appendix: Technology Version Reference

| Category | Package | Version |
|----------|---------|---------|
| Runtime | electron | ^42.5.0 |
| UI | react, react-dom | ^19.0.0 |
| Build | vite | ^7.0.0 |
| Electron Integration | vite-plugin-electron | ^1.0.4 |
| State Management | zustand | ^5.0.0 |
| Virtual Scrolling | react-virtuoso | ^4.12.0 |
| Styling | tailwindcss | ^4.0.0 |
| | class-variance-authority | ^0.7.0 |
| | clsx | ^2.1.0 |
| | tailwind-merge | ^3.0.0 |
| Icons | lucide-react | ^0.460.0 |
| Persistence | idb-keyval | ^6.2.0 |
| | electron-store | ^10.0.0 |
| Auto-update | electron-updater | ^6.3.0 |
| Validation | zod | ^3.24.0 |
| Terminal UI | ink, commander | latest |
| Dates | date-fns | ^4.1.0 |
| Testing | vitest | ^3.0.0 |
| | @playwright/test | ^1.50.0 |

---

*This document defines the technical design for the Nexus Chat client shell and UI rendering layer. It should be updated when architectural decisions change.*
