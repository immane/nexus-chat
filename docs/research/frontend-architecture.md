---
lang: en
---

# Nexus Chat - Frontend Architecture Research Report

> Slack-like IM desktop app · Electron + React + Vite + Zustand + Tailwind CSS  
> Research date: June 2026 · Versions as of mid-2026

---

## Table of Contents

1. [Electron + React + Vite Integration](#1-electron--react--vite-integration)
2. [React Rendering Performance Optimization](#2-react-rendering-performance-optimization)
3. [Zustand State Management Best Practices](#3-zustand-state-management-best-practices)
4. [Tailwind CSS Componentization Practices](#4-tailwind-css-componentization-practices)
5. [Performance Monitoring & Measurement](#5-performance-monitoring--measurement)
6. [Offline-First Strategy](#6-offline-first-strategy)
7. [Recommended Dependency Version List](#appendix-recommended-dependency-version-list)

---

## 1. Electron + React + Vite Integration

### 1.1 Comparison: vite-plugin-electron vs electron-vite

As of June 2026, the Electron community has three mainstream Vite integration paths:

| Solution                    | Positioning                    | Stars | Latest Version | Vite Compat |
| --------------------------- | ------------------------------ | ----- | -------------- | ----------- |
| **vite-plugin-electron**    | Vite plugin (flexible integration) | 893   | v1.0.4         | Vite 7/8    |
| **electron-vite**           | Standalone build tool (presets)    | ~4K   | v3.x           | Built-in Vite |
| **Electron Forge + Vite**   | Official recommendation (full pipeline) | ~6.5K | -              | Plugin support |

**Conclusion: Recommend `vite-plugin-electron` v1.0.4**

Rationale:

- Seamless integration with existing Vite projects, no need for a new CLI
- Supports Vite 8's Environment API (`multi-env` mode), future-proof
- Provides both `simple` API (zero-config startup) and `flat` API (advanced customization)
- `notBundle` plugin can externalize dependencies during development, greatly accelerating hot restart
- `esmShim` plugin auto-injects `__dirname`/`__filename` to fill ESM compatibility gaps

> `electron-vite` is suitable for new projects starting from scratch that are willing to accept its preset project structure.  
> `Electron Forge + Vite` is suitable for teams needing a complete packaging/signing/distribution pipeline.

### 1.2 Process Communication Architecture (contextBridge + IPC)

Electron's security model requires `contextIsolation: true` + `sandbox: true`, and all main process capabilities must be exposed through the preload script.

**Recommended architecture:**

```
┌─────────────────────────────────────────────────────┐
│  Main Process (Node.js)                              │
│  ├── main.ts          Window management/Tray/Updates  │
│  ├── ipc-handlers.ts  IPC handler registration        │
│  └── services/        Business services (DB, FS, etc.)│
├─────────────────────────────────────────────────────┤
│  Preload Script (bridge)                             │
│  └── preload.ts       contextBridge.exposeInMainWorld│
├─────────────────────────────────────────────────────┤
│  Renderer Process (React)                            │
│  ├── src/             Renderer process code           │
│  └── window.electronAPI  Type-safe invocation         │
└─────────────────────────────────────────────────────┘
```

**Key code example:**

```typescript
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron'

const electronAPI = {
  // Window controls
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Message notifications
  onNotification: (callback: (data: NotificationData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: NotificationData) => callback(data)
    ipcRenderer.on('notification:new', handler)
    return () => ipcRenderer.removeListener('notification:new', handler)
  },

  // System info
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
```

```typescript
// src/types/electron.d.ts - Type declaration
import type { electronAPI } from '../electron/preload'

declare global {
  interface Window {
    electronAPI: typeof electronAPI
  }
}
```

**IPC communication principles:**

- Unidirectional data flow: Renderer requests data via `invoke/handle`, main process pushes events via `webContents.send`
- Avoid `sendSync`: it blocks the renderer process
- All IPC channel names use the `namespace:action` naming convention
- Use `ipcRenderer.invoke` + `ipcMain.handle` pattern (Promise-based), not `send/on`

### 1.3 Window Management Strategy

**Recommendation: Single window + multi-panel switching, supplemented by independent popup windows**

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
      titleBarStyle: 'hiddenInset', // macOS native style
      webPreferences: {
        preload: join(__dirname, 'preload.mjs'),
        contextIsolation: true,
        sandbox: true,
      },
    })
    return this.mainWindow
  }

  // Independent popups (e.g., video calls, independent message threads)
  openPopup(id: string, url: string, opts: Partial<BrowserWindowConstructorOptions> = {}): BrowserWindow {
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

**Decision matrix:**

| Scenario              | Solution                         | Rationale                                      |
| --------------------- | -------------------------------- | ---------------------------------------------- |
| Main chat interface   | Single window + React routing     | Best performance, simple state sharing         |
| Video/voice calls     | Independent popup window          | Does not block main window operations          |
| Settings panel        | In-window panel/drawer            | Shares main state tree, no IPC sync needed     |
| Multiple teams/workspaces | Single window tab switching    | Avoids complexity of multi-window state sync   |

### 1.4 System Tray, Native Notifications, Badge

**System tray:**

```typescript
// electron/tray.ts
import { Tray, Menu, nativeImage, app } from 'electron'

export function createTray(mainWindow: BrowserWindow): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '../assets/tray-icon.png'))
  const tray = new Tray(icon.resize({ width: 16, height: 16 }))

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show/Hide', click: () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ])

  tray.setToolTip('Nexus Chat')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => mainWindow.show())

  return tray
}
```

**Native notifications:**

```typescript
// electron/notifications.ts
import { Notification } from 'electron'

export function showNotification(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({ title, body, silent: false })
  if (onClick) {
    notification.on('click', onClick)
  }
  notification.show()
}
```

**Dock Badge (macOS):**

```typescript
// Set unread count on Dock
app.dock.setBadge(unreadCount > 0 ? String(unreadCount) : '')
// Windows taskbar
mainWindow.setOverlayIcon(icon, 'Unread messages')
```

### 1.5 Auto-Update Best Practices

**Recommendation: `electron-updater` (electron-builder ecosystem)**

```typescript
// electron/updater.ts
import { autoUpdater } from 'electron-updater'
import { BrowserWindow } from 'electron'

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  autoUpdater.autoDownload = false // Let user decide whether to update
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

  // Check for updates every 4 hours
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
  autoUpdater.checkForUpdates()
}
```

**Publishing configuration key points:**

- Use GitHub Releases as the update source (free)
- `dev-app-update.yml` for local development testing
- In CI, publish draft releases via `electron-builder`, manually verify then publish

---

## 2. React Rendering Performance Optimization

### 2.1 Virtual Scrolling Comparison

| Feature                       | react-virtuoso (~2.1M/wk) | @tanstack/react-virtual (~1.3M/wk) | react-window (~1.9M/wk) |
| ----------------------------- | ------------------------- | ---------------------------------- | ----------------------- |
| Dynamic height                | ✅ Native auto                 | ✅ `measureElement` ref            | ⚠️ Requires known height |
| Bidirectional infinite scroll | ✅ `startReached`/`endReached` | ❌ Needs custom implementation     | ❌                       |
| Prepend/append without jitter | ✅ Built-in                    | ⚠️ Needs manual handling          | ❌                       |
| Sticky group headers          | ✅ `GroupedVirtuoso`           | ❌ Needs custom implementation     | ❌                       |
| Follow scroll (new messages)  | ✅ `followOutput`              | ❌ Needs custom implementation     | ❌                       |
| TypeScript                    | ✅ First-class                 | ✅ First-class                     | ⚠️ `@types/` package      |
| Bundle size                   | ~17KB                         | ~5KB (but missing features need manual implementation) | ~6KB                    |
| Active maintenance            | ✅                             | ✅                                 | ⚠️ Maintenance mode      |
| Framework-agnostic core       | ❌ React only                 | ✅ `@tanstack/virtual-core`        | ❌ React only            |

**Conclusion: Recommend `react-virtuoso`**

For IM applications, especially message list scenarios, `react-virtuoso` is the de facto standard:

- Well-known IM projects like Rocket.Chat already use it in production
- Built-in bidirectional infinite scroll + jitter-free prepend + auto follow scroll are IM essentials
- The feature set gained at 17KB bundle cost would need manual implementation with `@tanstack/react-virtual`

**Chat message list core code:**

```typescript
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'

function MessageList({ channelId }: { channelId: string }) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const messages = useMessageStore(s => s.messagesByChannel[channelId])
  const loadOlder = useMessageStore(s => s.loadOlderMessages)
  const [atBottom, setAtBottom] = useState(true)

  const prependOlder = useCallback(async () => {
    if (!messages?.length) return
    await loadOlder(channelId, messages[0].id)
  }, [channelId, messages, loadOlder])

  return (
    <Virtuoso
      ref={virtuosoRef}
      style={{ height: '100%' }}
      data={messages ?? []}
      // Load older messages when scrolled to top
      startReached={prependOlder}
      // Auto follow scroll for new messages (no follow when user scrolls up to view history)
      followOutput={atBottom ? 'smooth' : false}
      // Initial position at latest message (bottom)
      initialTopMostItemIndex={messages ? messages.length - 1 : 0}
      // Item render
      itemContent={(_, msg) => <ChatMessageItem message={msg} />}
      // Show placeholder during fast scroll to reduce rendering
      components={{
        ScrollSeekPlaceholder: ({ height }) => (
          <div style={{ height }} className="bg-muted/20" />
        ),
      }}
      // Listen for whether user is at bottom
      atBottomStateChange={setAtBottom}
      // Pre-render 200px to prevent blank flicker
      increaseViewportBy={{ top: 200, bottom: 200 }}
    />
  )
}
```

**Message item component must use `React.memo`:**

```typescript
const ChatMessageItem = React.memo(function ChatMessageItem({ message }: { message: Message }) {
  const isOwn = useCurrentUserId() === message.senderId

  return (
    <div className={cn('flex gap-2 px-4 py-1', isOwn && 'flex-row-reverse')}>
      <Avatar userId={message.senderId} size="sm" />
      <div className={cn('max-w-[70%] rounded-lg px-3 py-2', isOwn ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
        {message.text}
      </div>
    </div>
  )
}, (prev, next) => prev.message.id === next.message.id &&
  prev.message.text === next.message.text &&
  prev.message.status === next.message.status)
```

### 2.2 Performance Strategy for Reverse-Order Loading

The core challenge of IM message lists: historical messages need to be loaded from newest upward (reverse pagination), while new real-time messages append downward.

**Strategy: Cursor pagination + double buffering**

```typescript
// Message loading logic in zustand store
interface MessageStoreState {
  messagesByChannel: Record<string, Message[]>
  cursors: Record<string, { oldest?: string; newest?: string }>
  loadingState: Record<string, 'idle' | 'loading-older' | 'loading-newer'>

  loadOlderMessages: (channelId: string, beforeId: string) => Promise<void>
  appendNewMessage: (channelId: string, msg: Message) => void
}

// Load older messages (insert at array head)
loadOlderMessages: async (channelId, beforeId) => {
  const { data, hasMore } = await api.fetchMessages({ channelId, before: beforeId, limit: 50 })
  set(state => ({
    messagesByChannel: {
      ...state.messagesByChannel,
      [channelId]: [...data, ...(state.messagesByChannel[channelId] ?? [])],
    },
    cursors: {
      ...state.cursors,
      [channelId]: { ...state.cursors[channelId], oldest: data[0]?.id, hasMore },
    },
  }))
}
```

**Key optimization points:**

- Load 50 messages per batch to avoid excessive data volume
- Use message ID rather than `createdAt` as cursor (IDs are typically monotonically increasing UUIDs or Snowflakes)
- New messages pushed via WebSocket are directly `appended` to the array tail

### 2.3 Race Conditions Between WebSocket Push and Scroll Loading

This is the most bug-prone area in IM applications.

**Problem scenarios:**
1. User is scrolling up to load history
2. Simultaneously, WebSocket pushes a new message
3. Both operations modify the message array → data inconsistency or duplication

**Solution: Message deduplication + optimistic locking**

```typescript
// 1. Use Map to ensure message uniqueness
interface MessageStoreState {
  messageMap: Map<string, Message>         // id -> Message fast lookup
  channelOrder: Record<string, string[]>   // channelId -> [messageId, ...] ordered ID list

  upsertMessages: (channelId: string, messages: Message[]) => void
}

upsertMessages: (channelId, messages) => {
  set(state => {
    const newMap = new Map(state.messageMap)
    const order = [...(state.channelOrder[channelId] ?? [])]

    for (const msg of messages) {
      if (!newMap.has(msg.id)) {
        newMap.set(msg.id, msg)
        // Insert at correct position by timestamp (handles out-of-order arrival)
        const insertIndex = order.findIndex(id => {
          const existing = newMap.get(id)
          return existing && existing.createdAt > msg.createdAt
        })
        if (insertIndex === -1) {
          order.push(msg.id) // Latest message appends to end
        } else {
          order.splice(insertIndex, 0, msg.id)
        }
      } else {
        // Deduplication: update newer timestamp messages (e.g., status updates, edits)
        newMap.set(msg.id, { ...newMap.get(msg.id), ...msg })
      }
    }

    return {
      messageMap: newMap,
      channelOrder: { ...state.channelOrder, [channelId]: order },
    }
  })
}
```

**Rendering layer derivation:**

```typescript
// Selector converts Map + order to array needed by Virtuoso
const selectMessages = (channelId: string) => (state: MessageStoreState) => {
  const order = state.channelOrder[channelId]
  if (!order) return []
  return order.map(id => state.messageMap.get(id)!).filter(Boolean)
}
```

### 2.4 React 18/19 Concurrent Features in IM Applications

**`useTransition` - Non-blocking rendering during channel switching:**

```typescript
function ChannelView() {
  const [channelId, setChannelId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleChannelSwitch = useCallback((newChannelId: string) => {
    // Mark channel switch as low-priority update to keep input responsive
    startTransition(() => {
      setChannelId(newChannelId)
    })
  }, [])

  return (
    <div>
      <Sidebar onChannelSelect={handleChannelSwitch} />
      {isPending && <Spinner />}
      <MessageList channelId={channelId!} />
    </div>
  )
}
```

**`useDeferredValue` - Message list search filtering:**

```typescript
function SearchableMessageList({ messages }: { messages: Message[] }) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  // Use deferredQuery for rendering filtered results,
  // query input stays smooth, list update can be deferred
  const filtered = useMemo(
    () => messages.filter(m => m.text.includes(deferredQuery)),
    [messages, deferredQuery]
  )

  return (
    <div>
      <input value={query} onChange={e => setQuery(e.target.value)} />
      <MessageList messages={filtered} />
    </div>
  )
}
```

**Usage recommendations:**

- `useTransition`: Mark channel switching as a transition to ensure Sidebar click response is not blocked by message list rendering
- `useDeferredValue`: Search filtering scenarios, input always stays smooth
- **Do not** use transition on WebSocket message pushes — real-time messages should maintain high priority

### 2.5 Avoiding Unnecessary Re-renders

**Zustand precise Selector (core strategy):**

```typescript
// ❌ Wrong: re-renders on any state change
const store = useMessageStore()

// ✅ Correct: only subscribe to needed fields
const messages = useMessageStore(s => s.messagesByChannel[channelId])
const unreadCount = useMessageStore(s => s.unreadCountByChannel[channelId])

// ✅ Use shallow comparison (object/array selectors)
import { useShallow } from 'zustand/react/shallow'

const { messages, hasMore } = useMessageStore(
  useShallow(s => ({
    messages: s.messagesByChannel[channelId],
    hasMore: s.cursors[channelId]?.hasMore ?? false,
  }))
)
```

**React.memo + useMemo strategy:**

| Component Type        | Optimization Method                               |
| --------------------- | ------------------------------------------------- |
| Message item          | `React.memo` + precise comparison function         |
| Channel sidebar list  | `React.memo` + `useMemo` sort                     |
| Member list           | `React.memo` + virtual scrolling (if >100)         |
| Emoji picker          | `React.memo` + lazy loading                       |
| Input box             | Generally no memo (complex own state, re-render cost manageable) |

---

## 3. Zustand State Management Best Practices

### 3.1 Normalized Message Storage

Following Redux normalizr philosophy, but leveraging Zustand's flexibility with `Map` storage:

```typescript
interface NormalizedMessageState {
  // Entity storage (flattened)
  messages: Map<string, Message>          // id -> message
  users: Map<string, User>               // id -> user
  channels: Map<string, Channel>         // id -> channel

  // Relationships (ordered ID lists)
  messageOrder: Record<string, string[]> // channelId -> [msgId, ...]
  channelMembers: Record<string, string[]> // channelId -> [userId, ...]

  // Metadata
  cursors: Record<string, { oldest?: string; newest?: string; hasMore: boolean }>
  typingUsers: Record<string, string[]>  // channelId -> [userId, ...]
}
```

**Advantages of Map:**

- O(1) lookup and update
- Native iteration support
- Fully compatible with Zustand's `set` (use `new Map(oldMap)` to create immutable copies)

### 3.2 Store Splitting Strategy

**Split by domain, not by function:**

```
src/stores/
├── message-store.ts       # Message core (entities, order, cursors)
├── channel-store.ts       # Channel list, unread count, members
├── user-store.ts          # User profiles, online status
├── connection-store.ts    # WebSocket connection state, reconnection
├── ui-store.ts            # Sidebar collapse, active panel, theme
└── draft-store.ts         # Draft messages (per-channel)
```

**Cross-store communication pattern:**

```typescript
// Reference other stores in message-store.ts
import { useChannelStore } from './channel-store'

export const useMessageStore = create<MessageStoreState>()((set, get) => ({
  appendNewMessage: (channelId, msg) => {
    set(state => { /* update message list... */ })
    // Cross-store unread count update
    const { incrementUnread } = useChannelStore.getState()
    incrementUnread(channelId)
  },
}))
```

**Slice pattern (logical grouping within a single file, suitable for small-to-medium stores):**

```typescript
// connection-store.ts
import { create, StateCreator } from 'zustand'

interface ConnectionSlice {
  isConnected: boolean
  reconnectAttempts: number
  connect: () => void
  disconnect: () => void
}

const createConnectionSlice: StateCreator<ConnectionSlice> = (set, get) => ({
  isConnected: false,
  reconnectAttempts: 0,
  connect: () => set({ isConnected: true, reconnectAttempts: 0 }),
  disconnect: () => set({ isConnected: false }),
})

export const useConnectionStore = create<ConnectionSlice>()((...a) => ({
  ...createConnectionSlice(...a),
}))
```

### 3.3 WebSocket Integration with Zustand

**Recommended pattern: Zustand middleware encapsulating WebSocket lifecycle**

```typescript
// stores/ws-middleware.ts
import { StateCreator } from 'zustand'

interface WSActions {
  wsConnect: () => void
  wsDisconnect: () => void
  wsSend: (event: string, payload: unknown) => void
}

export function websocketMiddleware<State extends { ws: WebSocket | null }>(
  url: string,
  onMessage: (event: MessageEvent, set: any, get: any) => void,
): StateCreator<State & WSActions> {
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  return (set, get, api) => ({
    ...api,
    ws: null,

    wsConnect: () => {
      if (socket?.readyState === WebSocket.OPEN) return

      socket = new WebSocket(url)

      socket.onopen = () => set({ ws: socket } as any)

      socket.onmessage = (event) => onMessage(event, set, get)

      socket.onclose = () => {
        set({ ws: null } as any)
        // Exponential backoff reconnection
        const attempts = (get as any)().reconnectAttempts ?? 0
        const delay = Math.min(1000 * 2 ** attempts, 30000)
        reconnectTimer = setTimeout(() => {
          (get as any)().wsConnect()
        }, delay)
      }
    },

    wsDisconnect: () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket?.close()
      socket = null
      set({ ws: null } as any)
    },

    wsSend: (event, payload) => {
      socket?.send(JSON.stringify({ event, payload }))
    },
  })
}
```

### 3.4 Offline Message Queue & Optimistic Updates

**Message sending flow:**

```
User clicks send → Optimistically insert into local store (status: 'sending')
  ├─ Network available → WebSocket send → Server confirmation → status: 'sent'
  └─ Network disconnected → Enqueue to offline queue → Batch resend on recovery → status: 'sent'
```

**Offline queue implementation:**

```typescript
// stores/offline-queue.ts
interface OfflineQueueItem {
  id: string
  channelId: string
  type: 'message' | 'reaction' | 'mark_read'
  payload: unknown
  createdAt: number
  retryCount: number
}

interface OfflineQueueState {
  queue: OfflineQueueItem[]
  enqueue: (item: Omit<OfflineQueueItem, 'createdAt' | 'retryCount'>) => void
  dequeue: (id: string) => void
  processQueue: () => Promise<void>
}

export const useOfflineQueueStore = create<OfflineQueueState>()((set, get) => ({
  queue: [],

  enqueue: (item) => {
    set(state => ({
      queue: [...state.queue, { ...item, createdAt: Date.now(), retryCount: 0 }],
    }))
  },

  dequeue: (id) => {
    set(state => ({ queue: state.queue.filter(i => i.id !== id) }))
  },

  processQueue: async () => {
    const { queue, dequeue, wsSend } = get() as any
    for (const item of [...queue]) {
      try {
        wsSend(item.type, item.payload)
        dequeue(item.id)
      } catch {
        set(state => ({
          queue: state.queue.map(i =>
            i.id === item.id ? { ...i, retryCount: i.retryCount + 1 } : i
          ),
        }))
      }
    }
  },
}))
```

**Optimistic update Hook:**

```typescript
function useSendMessage(channelId: string) {
  const upsertMessages = useMessageStore(s => s.upsertMessages)
  const wsSend = useConnectionStore(s => s.wsSend)
  const enqueue = useOfflineQueueStore(s => s.enqueue)
  const isConnected = useConnectionStore(s => s.isConnected)

  const send = useCallback((text: string) => {
    const tempId = `temp-${crypto.randomUUID()}`
    const optimisticMessage: Message = {
      id: tempId,
      channelId,
      text,
      senderId: currentUserId,
      createdAt: new Date().toISOString(),
      status: 'sending' as const,
    }

    // 1. Optimistic insert
    upsertMessages(channelId, [optimisticMessage])

    // 2. Send
    if (isConnected) {
      wsSend('message:send', { tempId, channelId, text })
    } else {
      enqueue({ id: tempId, channelId, type: 'message', payload: { text } })
    }
  }, [channelId, isConnected])

  return send
}
```

### 3.5 Persistence Strategy

**Recommendation: `zustand/middleware persist` + `localStorage` (critical data) + `IndexedDB` (large message volumes)**

```typescript
// stores/ui-store.ts - Small UI state using persist
import { persist } from 'zustand/middleware'

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      theme: 'system' as const,
      fontSize: 'medium' as const,
      toggleSidebar: () => set(s => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'nexus-ui',
      partialize: (state) => ({ sidebarCollapsed: state.sidebarCollapsed, theme: state.theme, fontSize: state.fontSize }),
    }
  )
)
```

**Message storage using IndexedDB (idb-keyval or Dexie.js):**

```typescript
// stores/message-persistence.ts
import { get, set, del } from 'idb-keyval'

interface MessagePersistence {
  saveMessages: (channelId: string, messages: Message[], cursors: Cursor) => Promise<void>
  loadMessages: (channelId: string) => Promise<{ messages: Message[]; cursors: Cursor } | null>
}

export const messagePersistence: MessagePersistence = {
  saveMessages: async (channelId, messages, cursors) => {
    // Only keep the most recent 500 messages to avoid IndexedDB bloat
    const trimmed = messages.slice(-500)
    await set(`msgs:${channelId}`, { messages: trimmed, cursors, savedAt: Date.now() })
  },
  loadMessages: async (channelId) => {
    const data = await get(`msgs:${channelId}`)
    return data ?? null
  },
}
```

**Strategy summary:**

| Data Type      | Persistence Solution                     | Reason                                     |
| -------------- | ---------------------------------------- | ------------------------------------------ |
| UI preferences | `persist` middleware + localStorage       | Small data, synchronous read/write         |
| Recent messages| IndexedDB                                | Large data, asynchronous, supports indexes |
| Draft messages | `persist` middleware + localStorage       | Only one text per channel, small data      |
| Auth tokens    | `electron-store`                         | Secure storage (encryption + keychain)     |

---

## 4. Tailwind CSS Componentization Practices

### 4.1 Design Token System

**Recommendation: Tailwind CSS v4 native CSS variables + `@theme` directive**

```css
/* src/styles/theme.css */
@import 'tailwindcss';

@theme {
  /* Brand colors */
  --color-primary: #6C5CE7;
  --color-primary-light: #A29BFE;
  --color-primary-dark: #4A3DB7;
  --color-primary-foreground: #FFFFFF;

  /* Semantic colors */
  --color-success: #00B894;
  --color-warning: #FDCB6E;
  --color-danger: #E17055;
  --color-info: #74B9FF;

  /* Neutral colors - Grayscale */
  --color-bg-base: #FFFFFF;
  --color-bg-muted: #F5F5F5;
  --color-bg-subtle: #EBEBEB;
  --color-border: #E0E0E0;
  --color-text-primary: #1A1A2E;
  --color-text-secondary: #636E72;
  --color-text-muted: #B2BEC3;

  /* Dark mode */
  --color-bg-base-dark: #1A1A2E;
  --color-bg-muted-dark: #16213E;
  --color-bg-subtle-dark: #0F3460;
  --color-border-dark: #2D3436;
  --color-text-primary-dark: #DFE6E9;
  --color-text-secondary-dark: #B2BEC3;
  --color-text-muted-dark: #636E72;

  /* Spacing */
  --spacing-chat-input: 56px;
  --spacing-sidebar: 260px;

  /* Border radius */
  --radius-msg: 12px;
  --radius-avatar: 50%;
  --radius-card: 8px;

  /* Shadows */
  --shadow-msg: 0 1px 3px rgb(0 0 0 / 0.08);
  --shadow-sidebar: 1px 0 4px rgb(0 0 0 / 0.06);
  --shadow-popup: 0 4px 24px rgb(0 0 0 / 0.12);

  /* Fonts */
  --font-sans: 'Inter', 'SF Pro Text', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', monospace;

  /* Animations */
  --animate-fade-in: fade-in 150ms ease-out;
  --animate-slide-up: slide-up 200ms ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slide-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

### 4.2 Dark/Light Theme Switching

**Recommendation: Tailwind CSS v4 native `dark:` variant + CSS variable switching**

```css
/* Leverage Tailwind v4's native dark mode */
@custom-variant dark (&:where(.dark, .dark *));

/* Or use prefers-color-scheme */
@custom-variant dark (&:where(.dark, .dark *));

.dark {
  --color-bg-base: var(--color-bg-base-dark);
  --color-bg-muted: var(--color-bg-muted-dark);
  /* ... other variable overrides here */
}
```

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
    } else {
      root.classList.toggle('dark', theme === 'dark')
    }
  }, [theme])

  return { theme, setTheme }
}
```

### 4.3 Component Class Organization Pattern (CVA)

**Recommendation: `class-variance-authority` (cva)**

```typescript
// components/ui/button.tsx
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  // Base styles
  'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-dark active:bg-primary-dark',
        secondary: 'bg-muted text-text-primary hover:bg-subtle',
        ghost: 'hover:bg-muted text-text-secondary hover:text-text-primary',
        danger: 'bg-danger text-white hover:bg-danger/90',
      },
      size: {
        sm: 'h-8 px-3 text-xs gap-1',
        md: 'h-10 px-4 text-sm gap-2',
        lg: 'h-12 px-6 text-base gap-2',
        icon: 'h-10 w-10',
      },
      fullWidth: {
        true: 'w-full',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, fullWidth, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, fullWidth, className }))}
      {...props}
    />
  )
)
```

**IM-specific component example - Message bubble:**

```typescript
const messageBubbleVariants = cva(
  'relative max-w-[70%] rounded-msg px-3 py-2 text-sm leading-relaxed',
  {
    variants: {
      align: {
        left: 'bg-muted text-text-primary',
        right: 'bg-primary text-primary-foreground',
      },
      isFirst: { true: '', false: '' },
      isLast: { true: '', false: '' },
    },
    compoundVariants: [
      { align: 'left', isFirst: true, className: 'rounded-bl-sm' },
      { align: 'left', isLast: true, className: 'rounded-tl-sm' },
      { align: 'right', isFirst: true, className: 'rounded-br-sm' },
      { align: 'right', isLast: true, className: 'rounded-tr-sm' },
    ],
  }
)
```

### 4.4 shadcn/ui Integration Assessment

**Conclusion: Recommend integration, cherry-pick components as needed**

| Component        | Include | Rationale                                          |
| ---------------- | ------- | -------------------------------------------------- |
| Button, Input    | ✅       | Basic components, low replacement cost              |
| Dialog, Popover  | ✅       | Accessibility handled, saves significant time       |
| DropdownMenu     | ✅       | Essential for IM right-click menus                 |
| Tooltip          | ✅       | Heavily used, no extra dependencies                |
| ScrollArea       | ⚠️      | Message list uses `react-virtuoso`, this component is optional |
| Sheet            | ✅       | Mobile sidebar panel                               |
| Command          | ✅       | Command palette (Cmd+K quick search)               |
| Toast/Sonner     | ✅       | Action feedback notifications                      |
| Table            | ⚠️      | Only used in settings/admin pages                  |
| Avatar           | ✅       | Just 3KB, avatar + fallback all-in-one             |

**Integration key points:**

- shadcn/ui is fully compatible with Tailwind v4 (using `cn()` utility function + CVA)
- Component source code is copied directly into the project, freely modifiable
- No extra npm dependencies (except underlying Radix UI primitives)
- Can pair with `electron-shadcn` starter template for quick bootstrapping

---

## 5. Performance Monitoring & Measurement

### 5.1 Measuring Web Vitals in Electron

Electron embeds Chromium and fully supports the Web Vitals API:

```typescript
// src/lib/vitals.ts
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals'

const VITALS_ENDPOINT = 'https://your-telemetry.example.com/vitals'

function sendToAnalytics(metric: Metric) {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    rating: metric.rating, // 'good' | 'needs-improvement' | 'poor'
    delta: metric.delta,
    id: metric.id,
    navigationType: metric.navigationType,
    timestamp: Date.now(),
    platform: navigator.platform,
  })

  // Use sendBeacon to ensure delivery even during page close
  if (navigator.sendBeacon) {
    navigator.sendBeacon(VITALS_ENDPOINT, body)
  }
}

export function initWebVitals() {
  onCLS(sendToAnalytics)
  onFCP(sendToAnalytics)
  onINP(sendToAnalytics)
  onLCP(sendToAnalytics)
  onTTFB(sendToAnalytics)
}
```

**Custom performance metrics (IM-specific):**

```typescript
// Channel switch latency
function measureChannelSwitch(channelId: string) {
  performance.mark(`switch-${channelId}-start`)
  // ... switch logic
  performance.mark(`switch-${channelId}-end`)
  performance.measure(
    `channel-switch-${channelId}`,
    `switch-${channelId}-start`,
    `switch-${channelId}-end`
  )
}

// Message send latency (from user click to message appearing in list)
function measureMessageSendLatency(tempId: string) {
  const start = performance.now()
  return {
    markSent: () => {
      const duration = performance.now() - start
      if (duration > 500) console.warn(`Message send latency: ${duration}ms`)
    },
  }
}
```

### 5.2 React Profiler Usage Strategy

**Enable on demand in production:**

```typescript
// src/components/ProfiledMessageList.tsx
import { Profiler, type ProfilerOnRenderCallback } from 'react'

const onRender: ProfilerOnRenderCallback = (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
  if (actualDuration > 16) { // Report renders exceeding one frame (16ms)
    console.warn(`[Profiler] ${id} slow render: ${actualDuration}ms (phase: ${phase})`)
  }
}

export function ProfiledMessageList({ channelId }: { channelId: string }) {
  // Only enable Profiler in development
  if (import.meta.env.DEV) {
    return (
      <Profiler id={`MessageList-${channelId}`} onRender={onRender}>
        <MessageList channelId={channelId} />
      </Profiler>
    )
  }
  return <MessageList channelId={channelId} />
}
```

**Performance regression detection in CI:**

- Use `React.Profiler` in E2E tests to collect critical path render times
- Compare `actualDuration` changes before and after PRs
- Thresholds: first render of message list < 200ms, channel switch < 100ms

### 5.3 Memory Leak Prevention

**WebSocket cleanup pattern:**

```typescript
// In stores/connection-store.ts
useEffect(() => {
  const { wsConnect } = useConnectionStore.getState()
  wsConnect()

  return () => {
    // ⚠️ Disconnect on component unmount to prevent leaks
    const { wsDisconnect } = useConnectionStore.getState()
    wsDisconnect()
  }
}, [])
```

**Store subscription disposal:**

```typescript
// ✅ Recommended: Use hook for auto subscribe/unsubscribe
const messages = useMessageStore(s => s.messagesByChannel[channelId])

// ⚠️ Manual subscriptions must be cleaned up
useEffect(() => {
  const unsub = useMessageStore.subscribe(
    state => state.messagesByChannel[channelId],
    (msgs) => { /* ... */ }
  )
  return unsub
}, [channelId])
```

**Event listener cleanup checklist:**

- [ ] IPC listener (`ipcRenderer.on` → returned cleanup function)
- [ ] WebSocket event listeners
- [ ] `window.matchMedia` listener (theme switching)
- [ ] `ResizeObserver` (virtual scrolling container)
- [ ] IntersectionObserver (lazy loading)

### 5.4 Memory Control for Long Message Lists

**Strategy summary:**

| Strategy                  | Implementation                                         |
| ------------------------- | ------------------------------------------------------ |
| Virtual scrolling         | `react-virtuoso` renders only ~30 DOM nodes            |
| Message memory window     | Full storage in IndexedDB, Zustand keeps only last 200 |
| Image/file lazy loading   | Only load attachment thumbnails within viewport        |
| WeakMap caching           | Use WeakMap for frequent data like user avatars to allow GC |
| Message deduplication     | Map storage, avoid duplicate messages consuming memory |

```typescript
// Message memory window control
const MEMORY_WINDOW_SIZE = 200

function trimMessageMemory(channelId: string): void {
  const { channelOrder, messageMap } = useMessageStore.getState()
  const ids = channelOrder[channelId] ?? []

  if (ids.length <= MEMORY_WINDOW_SIZE) return

  // Keep recent messages, remove older ones from Map
  const excess = ids.length - MEMORY_WINDOW_SIZE
  const toRemove = ids.slice(0, excess)

  const newMap = new Map(messageMap)
  for (const id of toRemove) {
    newMap.delete(id)
  }

  useMessageStore.setState({
    messageMap: newMap,
    channelOrder: {
      ...channelOrder,
      [channelId]: ids.slice(excess),
    },
  })
}
```

---

## 6. Offline-First Strategy

### 6.1 Feasibility of Service Worker in Electron

**Conclusion: Not recommended to use Service Worker in Electron.**

| Issue                          | Description                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| Uncertain cache quota          | Chromium dynamically calculates based on disk space, ~500MB upper limit unstable |
| Cannot leverage Node.js capabilities | SW cannot access filesystem, native APIs                       |
| Electron protocol interception is better | Main process can intercept all network requests (`protocol.handle`) |
| Complex debugging experience   | SW devtools support is inferior to regular renderer processes        |
| Cold start issues              | SW registration and activation have inherent delay                   |

**Alternative: Electron main process offline caching**

```typescript
// electron/offline-cache.ts
import { session, app } from 'electron'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const CACHE_DIR = join(app.getPath('userData'), 'offline-cache')

class OfflineAssetCache {
  private cacheDir: string

  constructor() {
    this.cacheDir = CACHE_DIR
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true })
    }
  }

  // Intercept and cache session requests
  setupSessionCache(): void {
    const filter = { urls: ['https://your-api.example.com/files/*'] }

    session.defaultSession.webRequest.onBeforeRequest(filter, (details, callback) => {
      const cacheKey = createHash('md5').update(details.url).digest('hex')
      const cachePath = join(this.cacheDir, cacheKey)

      if (existsSync(cachePath)) {
        // Cache hit, return local file directly
        callback({ redirectURL: `nexus-cache://${cacheKey}` })
        return
      }

      callback({})
    })

    // Response interception: cache new data
    session.defaultSession.webRequest.onCompleted(filter, (details) => {
      const cacheKey = createHash('md5').update(details.url).digest('hex')
      // Cannot directly access response body in onCompleted
      // Need to re-fetch and cache using fetch
      fetch(details.url)
        .then(res => res.arrayBuffer())
        .then(buffer => {
          writeFileSync(join(this.cacheDir, cacheKey), Buffer.from(buffer))
        })
        .catch(() => { /* silent */ })
    })
  }
}
```

**More recommended approach: Use `protocol.handle` custom protocol**

```typescript
// electron/custom-protocol.ts
import { protocol, net } from 'electron'

protocol.handle('nexus-cache', (request) => {
  const cacheKey = request.url.replace('nexus-cache://', '')
  const cachePath = join(CACHE_DIR, cacheKey)

  if (existsSync(cachePath)) {
    return net.fetch(`file://${cachePath}`)
  }

  // Fallback to network
  const originalUrl = getOriginalUrl(cacheKey)
  return net.fetch(originalUrl)
})
```

### 6.2 Offline Message Caching & Resend Queue

**Complete offline architecture:**

```
┌─────────────────────────────────────────────────────────┐
│  Renderer Process                                       │
│  ┌─────────────────┐    ┌─────────────────────────┐     │
│  │ Zustand Store    │    │ IndexedDB               │     │
│  │ (last 200 msgs)  │◄──►│ (full message persistence)│     │
│  └────────┬────────┘    └─────────────────────────┘     │
│           │ Optimistic update                              │
│           ▼                                               │
│  ┌────────────────────┐                                  │
│  │ Offline Queue Store │                                  │
│  │ (pending msg queue) │                                  │
│  └────────┬───────────┘                                  │
├───────────┼──────────────────────────────────────────────┤
│  Preload  │ ipcRenderer.invoke                            │
├───────────┼──────────────────────────────────────────────┤
│  Main Process                                            │
│  ┌────────▼───────────┐    ┌─────────────────────┐      │
│  │ IPC Handlers        │    │ Network Monitor      │      │
│  │ (msg persistence +  │◄───│ (online/offline       │      │
│  │  resend)            │    │  detection)           │      │
│  └────────┬───────────┘    └─────────────────────┘      │
│           │                                               │
│  ┌────────▼───────────┐                                  │
│  │ WebSocket Client    │                                  │
│  │ (main process       │                                  │
│  │  persistent conn)   │                                  │
│  └────────────────────┘                                  │
└─────────────────────────────────────────────────────────┘
```

**Offline detection utility:**

```typescript
// electron/network-monitor.ts
import { BrowserWindow } from 'electron'

class NetworkMonitor {
  private isOnline = true

  constructor(private mainWindow: BrowserWindow) {
    this.startMonitoring()
  }

  private startMonitoring(): void {
    setInterval(async () => {
      const online = await this.checkConnectivity()
      if (online !== this.isOnline) {
        this.isOnline = online
        this.mainWindow.webContents.send('network:status-change', { online })
        if (online) {
          // Back online, trigger queue processing
          this.mainWindow.webContents.send('network:back-online')
        }
      }
    }, 5000) // 5-second polling
  }

  private async checkConnectivity(): Promise<boolean> {
    try {
      await fetch('https://your-api.example.com/health', { method: 'HEAD', signal: AbortSignal.timeout(3000) })
      return true
    } catch {
      return false
    }
  }
}
```

### 6.3 Network Status Detection & Recovery

**Renderer-side network status Hook:**

```typescript
// hooks/use-network-status.ts
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const processQueue = useOfflineQueueStore(s => s.processQueue)

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true)
      processQueue() // Process offline queue immediately when back online
    }
    const handleOffline = () => setIsOnline(false)

    // Browser native events
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Electron main process network detection (more reliable)
    const cleanup = window.electronAPI?.onNetworkStatusChange?.(({ online }) => {
      setIsOnline(online)
      if (online) processQueue()
    })

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      cleanup?.()
    }
  }, [processQueue])

  return isOnline
}
```

**Offline UI indicator:**

```typescript
function OfflineBanner() {
  const isOnline = useNetworkStatus()

  if (isOnline) return null

  return (
    <div className="bg-warning text-text-primary px-4 py-1.5 text-center text-sm font-medium animate-slide-up">
      Network disconnected, messages will be sent automatically when connection is restored
    </div>
  )
}
```

---

## Appendix: Recommended Dependency Version List

| Category             | Package                      | Recommended Version | Purpose                      |
| -------------------- | ---------------------------- | ------------------- | ---------------------------- |
| **Core**             | electron                     | ^42.5.0             | Desktop runtime              |
|                      | react                        | ^19.0.0             | UI framework                 |
|                      | react-dom                    | ^19.0.0             | React DOM rendering          |
|                      | vite                         | ^7.0.0              | Build tool                   |
| **Electron Integration** | vite-plugin-electron       | ^1.0.4              | Vite + Electron integration  |
|                      | electron-builder              | ^26.0.0             | Packaging/distribution       |
|                      | electron-updater              | ^6.3.0              | Auto-update                  |
|                      | electron-store                | ^10.0.0             | Secure persisted storage     |
| **State Management** | zustand                       | ^5.0.0              | Global state management      |
|                      | idb-keyval                    | ^6.2.0              | Simplified IndexedDB wrapper |
| **Virtual Scrolling**| react-virtuoso                | ^4.12.0             | Message list virtual scroll  |
| **Styling**          | tailwindcss                   | ^4.0.0              | Atomic CSS                   |
|                      | @tailwindcss/vite              | ^4.0.0              | Tailwind Vite plugin         |
|                      | class-variance-authority      | ^0.7.0              | Component variant management |
|                      | clsx                          | ^2.1.0              | Class name merging (with CVA) |
|                      | tailwind-merge                | ^3.0.0              | Tailwind class smart merge   |
| **UI Components**    | shadcn/ui (manual copy)       | latest              | Accessible UI primitives     |
|                      | @radix-ui/react-dialog        | ^1.1.0              | Dialog primitive             |
|                      | @radix-ui/react-popover       | ^1.1.0              | Popover primitive            |
|                      | @radix-ui/react-dropdown-menu | ^2.1.0              | Dropdown menu primitive      |
|                      | @radix-ui/react-tooltip       | ^1.1.0              | Tooltip primitive            |
|                      | @radix-ui/react-avatar        | ^1.1.0              | Avatar primitive             |
|                      | lucide-react                  | ^0.460.0            | Icon library                 |
| **Utilities**        | web-vitals                    | ^4.2.0              | Web Vitals measurement       |
|                      | date-fns                      | ^4.1.0              | Date handling                |
|                      | zod                           | ^3.24.0             | Runtime validation           |
| **Development**      | typescript                    | ^5.6.0              | Type system                  |
|                      | @types/react                  | ^19.0.0             | React types                  |
|                      | vitest                        | ^3.0.0              | Unit testing                 |
|                      | @playwright/test              | ^1.50.0             | E2E testing                  |

---

## Summary & Recommendations

### Key Technical Decisions

1. **Electron Integration** → `vite-plugin-electron` v1.0.4 + `simple` API
2. **Virtual Scrolling** → `react-virtuoso` (sole recommendation for IM message lists)
3. **State Management** → Zustand multi-store + Map normalization + IndexedDB persistence
4. **Component Styling** → Tailwind CSS v4 + CVA + shadcn/ui on-demand
5. **Offline Strategy** → Electron main process caching (not Service Worker) + offline queue + IndexedDB
6. **WebSocket** → Main process persistent connection, Zustand middleware encapsulation, exponential backoff reconnection

### Recommended Project Structure

```
nexus-chat/
├── electron/
│   ├── main.ts              # Application entry
│   ├── preload.ts            # contextBridge API
│   ├── window-manager.ts     # Window management
│   ├── tray.ts               # System tray
│   ├── updater.ts            # Auto-update
│   ├── offline-cache.ts      # Offline cache
│   ├── network-monitor.ts    # Network status detection
│   └── ipc/
│       └── handlers.ts       # IPC handlers
├── src/
│   ├── main.tsx              # React entry
│   ├── app.tsx               # Root component
│   ├── stores/
│   │   ├── message-store.ts
│   │   ├── channel-store.ts
│   │   ├── user-store.ts
│   │   ├── connection-store.ts
│   │   ├── ui-store.ts
│   │   └── offline-queue.ts
│   ├── hooks/
│   │   ├── use-network-status.ts
│   │   ├── use-send-message.ts
│   │   └── use-theme.ts
│   ├── components/
│   │   ├── chat/
│   │   │   ├── message-list.tsx       # react-virtuoso wrapper
│   │   │   ├── message-item.tsx       # Single message item
│   │   │   └── chat-input.tsx         # Input box
│   │   ├── sidebar/
│   │   ├── ui/                        # shadcn/ui components
│   │   └── shared/
│   ├── lib/
│   │   ├── cn.ts                      # clsx + tailwind-merge
│   │   ├── vitals.ts                  # Web Vitals
│   │   └── message-persistence.ts     # IndexedDB wrapper
│   └── styles/
│       └── theme.css                  # Tailwind v4 @theme
└── vite.config.ts
```

---

*This report is based on the technology ecosystem as of June 2026. It is recommended to reassess key dependency versions and community activity on a quarterly basis.*
