# Web Client UI Design

> Last updated: 2026-07-09  
> Covers: desktop layout, component architecture, state management, and mobile adaptation plan

---

## 1. Entry Point & Shell

### 1.1 HTML (`apps/web/index.html`)

```html
<div id="root"></div>
<script type="module" src="/src/main.tsx"></script>
```

- No viewport meta tag — must be added for mobile:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

### 1.2 App Shell (`apps/web/src/components/App.tsx`)

```tsx
{user ? <ChatRoute /> : <LoginRoute />}
```

Two-mode rendering:

| State | Rendered |
|-------|----------|
| No authenticated user | `LoginRoute` (email/password server auth) |
| Authenticated user | `ChatRoute` (full chat layout) |

No router. No layout wrapper. The entire app is a single-page conditional render.

### 1.3 Styles Entry (`apps/web/src/styles.css`)

- Tailwind directives (`@tailwind base/components/utilities`)
- One custom layer: `.md-content` for rendered Markdown
- Global: `html, body, #root { overflow: hidden; height: 100%; }`

### 1.4 Tailwind Configuration (`apps/web/tailwind.config.ts`)

```typescript
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: []
} satisfies Config;
```

- Default breakpoints: `sm:640px`, `md:768px`, `lg:1024px`, `xl:1280px`
- No custom breakpoints, no dark mode config
- `md:768px` is the mobile/desktop boundary

---

## 2. Zustand State Architecture

All stores in `apps/web/src/stores/domain.ts`.

### 2.1 Store Map

| Store | Key State | Persisted | Mobile Relevance |
|-------|-----------|-----------|------------------|
| `useAuthStore` | `user`, `accessToken` | `localStorage` | None |
| `useWorkspaceStore` | `workspaces`, `activeWorkspaceId` | No | None |
| `useChannelStore` | `channels`, `activeChannelId`, `unreadCounts` | No | None |
| `useMessageStore` | `messages` (Map), `reactions` (Map), `order` | No | None |
| `usePresenceStore` | `onlineUserIds` (Set) | No | None |
| `useSignalStore` | `e2eEnabledChannelIds` | No | None |
| `useBotStore` | `manifests`, `inputActions` | No | None |
| **`useUiStore`** | **`sidebarOpen`**, `messageDraft`, `disappearingPolicy`, `settings` | `localStorage` for settings | **`sidebarOpen` is the mobile sidebar toggle** |

### 2.2 UiStore Detail

```typescript
interface UiState {
  sidebarOpen: boolean;           // Desktop: always true. Mobile: toggled by hamburger.
  messageDraft: string;
  disappearingPolicy: "off" | "24h" | "7d" | "30d";
  settings: {
    theme: "dark" | "light";
    compact: boolean;
    sound: boolean;
    notifications: boolean;
  };
  setSidebarOpen: (open: boolean) => void;
  setMessageDraft: (draft: string) => void;
  setDisappearingPolicy: (policy: string) => void;
  setSettings: (partial: Partial<UiSettings>) => void;
}
```

`sidebarOpen` is **currently unused in the UI** but is fully defined and ready for mobile hamburger wiring.

---

## 3. Desktop Layout

### 3.1 Main Grid (ChatRoute.tsx ~line 508)

```
┌──────────────────────────────────────────────┐
│  [Sidebar 280px] │ [Chat Area 1fr] │ [Right Panel 260px]  │
│                  │                 │                        │
│  Channel list    │  ChatHeader     │  Member list           │
│  DM list         │  MessageList    │  Online indicators     │
│  Tab bar         │  Composer       │                        │
└──────────────────────────────────────────────┘
```

```tsx
<main className="grid h-screen grid-cols-[280px_1fr] max-md:grid-cols-1"
  style={rightSidebarOpen ? { gridTemplateColumns: "280px 1fr 260px" } : undefined}>
```

| Region | Width | Notes |
|--------|-------|-------|
| Left sidebar | `280px` | Fixed. Three tabs: Chat / Members / Settings |
| Chat main | `1fr` | Flexible. Min-width constrained via `min-w-0` |
| Right panel | `260px` | Conditional. Only when `rightSidebarOpen === true` |

### 3.2 Left Sidebar (ChatRoute.tsx ~line 509)

```
┌─────────────────┐
│ "Nexus Chat" h1 │
│ Workspace select │
├─────────────────┤
│                 │
│ Channels / DMs  │  ← Scrollable (flex-1 overflow-y-auto)
│ (per tab)       │
│                 │
├─────────────────┤
│ [Chat][Members] │  ← Fixed bottom tab bar
│ [Settings]      │
└─────────────────┘
```

Tabs and their content:

| Tab | Content |
|-----|---------|
| "Chat" (`💬`) | Channel list + DM list + "Add" popup (`ChannelList`) |
| "Members" (`👥`) | Member search + member list with online dots |
| "Settings" (`⚙️`) | User info, theme toggle, compact mode, sound, notifications, logout |

Toggle buttons are at the bottom of the sidebar in a flex row.

### 3.3 Main Chat Area (ChatRoute.tsx ~line 663)

```
┌─────────────────────────────────────────┐
│ ChatHeader                              │
│ #channel-name [badges] [Members btn →]  │
├─────────────────────────────────────────┤
│                                         │
│ MessageList (react-virtuoso)            │  ← flex-1, virtualized
│                                         │
├─────────────────────────────────────────┤
│ ChatComposer                            │
│ [📎] [textarea] [😀] [send]             │
└─────────────────────────────────────────┘
```

### 3.4 ChatHeader (ChatHeader.tsx)

```tsx
<header>
  <div className="flex flex-wrap items-center gap-3">
    <h2>Channel/DM name</h2>
    <!-- Badges: E2EE, Bots, Online, WS status -->
    <!-- Transport mode selector (P2P/Signal) -->
    <!-- Members toggle button (ml-auto) -->
  </div>
</header>
```

`flex-wrap` allows badges to wrap on narrow screens.

### 3.5 MessageList

- `react-virtuoso` for virtualized scrolling
- `followOutput="smooth"` auto-scroll
- Date separators as centered badges
- `className="flex-1"` to fill available space

### 3.6 MessageRow

- Standard desktop: `mx-4 my-1 px-4 py-1 text-sm`
- Compact mode: `mx-2 my-1 px-2 py-1 text-xs`
- Right-click `onContextMenu` for action menu (reply, copy, forward, edit, delete, react)
- Image attachments: `max-h-48`
- Image lightbox: `fixed inset-0` fullscreen overlay

### 3.7 ChatComposer (ChatComposer.tsx)

```
┌──────────────────────────────────────────┐
│ Reply preview (conditional)              │
├──────────────────────────────────────────┤
│ Slash command suggestions (conditional)  │
├──────────────────────────────────────────┤
│ [📎] [textarea (auto-grow)] [😀] [send] │
├──────────────────────────────────────────┤
│ Upload progress indicators               │
└──────────────────────────────────────────┘
```

- Textarea: `resize-none`, `rows={1}`, `Enter` sends, `Shift+Enter` newline
- Emoji picker: `w-72` (288px), `grid-cols-8`, positioned `absolute bottom-full`
- File upload: `InputActionBar` action buttons wrapping with `flex-wrap`

### 3.8 Right Panel (RightMemberPanel.tsx)

```tsx
<aside className="max-md:hidden overflow-y-auto">
```

- Channel member list with online/offline indicators
- Hidden entirely on mobile (`max-md:hidden`)

### 3.9 Modals

| Component | Width | Issue |
|-----------|-------|-------|
| `ForwardModal` | `w-80` (320px) | Fixed; overflows on screens <320px |
| `DeleteConfirmModal` | `w-72` (288px) | Fixed; overflows on screens <288px |
| `ContextMenu` | Absolute at cursor | No touch-event support; no boundary detection |

---

## 4. Login Route (LoginRoute.tsx)

```
┌──────────────────────────┐
│  [Demo] [Real Server]    │  ← Tab toggle
│                          │
│  "Nexus Chat"            │
│  Sign in heading         │
│  Email input             │
│  Password input          │
│  [Continue]              │
│  Error message           │
└──────────────────────────┘
```

```tsx
<main className="grid h-screen place-items-center p-6">
  <div className="w-full max-w-md">
```

Already responsive due to `max-w-md`. Needs more bottom padding on mobile (`pb-8 sm:pb-0`).

---

## 5. Current Responsive Behavior (BROKEN)

Only 3 responsive classes exist in the entire codebase:

| Location | Class | Effect |
|----------|-------|--------|
| `ChatRoute.tsx:508` | `max-md:grid-cols-1` | Grid becomes single column |
| `ChatRoute.tsx:509` | `max-md:border-b max-md:border-r-0` | Sidebar border switches direction |
| `RightMemberPanel.tsx:41` | `max-md:hidden` | Right panel hidden |

### 5.1 Why the current behavior is broken on mobile

1. No `<meta name="viewport">` → browser renders at 980px desktop viewport. Everything is zoomed out and unreadable.
2. `max-md:grid-cols-1` stacks the full 280px sidebar **above** the chat area. User must scroll past the entire channel list before seeing any messages.
3. The sidebar has no close mechanism — it permanently occupies the top of the viewport.
4. `onContextMenu` (right-click) does not fire on touch devices — messages are uninteractive.
5. Modals and emoji picker use fixed widths that overflow on small viewports.

---

## 6. Mobile Adaptation Plan

Mobile boundary: `< 768px` (Tailwind `max-md:` breakpoint).

### 6.1 P0 — Essential (app unusable without these)

#### 6.1.1 Viewport Meta Tag

File: `apps/web/index.html`

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

Required before any other mobile fix. Without this, the browser renders a zoomed-out 980px desktop view.

#### 6.1.2 Mobile Sidebar as Overlay Drawer

File: `apps/web/src/components/ChatRoute.tsx` (~line 508)

**Desktop (unchanged):** Sidebar is a left grid column (`w-[280px]`), always visible.

**Mobile (`max-md:`):** Sidebar becomes a fixed overlay:

```
┌────────────────────────────────┐
│ ████████████ │                 │
│ █ Sidebar ██ │  Chat Area      │
│ █ 85vw    ██ │                 │
│ █         ██ │                 │
│ ████████████ │                 │
│              │                 │
│ Backdrop ░░░░│                 │
└────────────────────────────────┘
```

Behavior:
- Hidden by default on mobile (`max-md:hidden`)
- Overlay slides in from left when `sidebarOpen === true`
- Semi-transparent backdrop overlay behind the sidebar; tap to close
- Selecting a channel auto-closes the sidebar
- `Escape` key closes the sidebar
- Smooth CSS transition (`transition-transform duration-200`)

Implementation approach:

```tsx
{/* Backdrop overlay */}
{sidebarOpen && (
  <div className="max-md:fixed max-md:inset-0 max-md:z-30 max-md:bg-black/50"
       onClick={() => setSidebarOpen(false)} />
)}

{/* Sidebar */}
<aside className={
  `flex flex-col h-screen overflow-hidden border-r
   max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[85vw] max-md:max-w-[320px]
   max-md:z-40 max-md:shadow-2xl
   ${sidebarOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'}
   transition-transform duration-200`
}>
```

#### 6.1.3 Hamburger Menu Button

File: `apps/web/src/components/ChatHeader.tsx`

Add a hamburger button before the channel name on mobile:

```tsx
{/* Hamburger - mobile only */}
<button className="max-md:flex hidden flex-col gap-1 p-2"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle sidebar">
  <span className="block h-0.5 w-5 bg-current" />
  <span className="block h-0.5 w-5 bg-current" />
  <span className="block h-0.5 w-5 bg-current" />
</button>
```

### 6.2 P1 — High Priority

#### 6.2.1 Mobile Grid Layout

File: `apps/web/src/components/ChatRoute.tsx` (~line 508)

```tsx
<main className="grid h-screen grid-cols-[280px_1fr] max-md:grid-cols-[1fr]">
```

The sidebar is removed from the grid flow on mobile (rendered as fixed overlay instead).

#### 6.2.2 Long-Press Context Menu

File: `apps/web/src/components/MessageRow.tsx`

Replace right-click-only behavior with long-press support for touch devices:

```typescript
const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
const longPressTriggered = useRef(false);

const onTouchStart = () => {
  longPressTriggered.current = false;
  longPressTimer.current = setTimeout(() => {
    longPressTriggered.current = true;
    // Open action sheet (same actions as right-click menu)
  }, 500);
};

const onTouchEnd = () => {
  if (longPressTimer.current) clearTimeout(longPressTimer.current);
};

const onTouchMove = () => {
  // Cancel if finger moved more than 10px
  if (longPressTimer.current) clearTimeout(longPressTimer.current);
};
```

On mobile, render the action menu as a **bottom sheet** (full-width panel sliding up from the bottom) instead of a fixed-position dropdown. Actions: Reply, Copy, Forward, Edit, Delete, React.

#### 6.2.2 Responsive Modals

File: `apps/web/src/components/ForwardModal.tsx` (~line 25)

```tsx
// Before
<div className="w-80 rounded-2xl">
// After
<div className="w-[calc(100vw-2rem)] max-w-80 rounded-2xl max-h-[80vh] overflow-y-auto">
```

File: `apps/web/src/components/DeleteConfirmModal.tsx` (~line 13)

```tsx
// Before
<div className="w-72 rounded-2xl">
// After
<div className="w-[calc(100vw-2rem)] max-w-72 rounded-2xl max-h-[80vh] overflow-y-auto">
```

#### 6.2.3 Emoji Picker Responsive Sizing

File: `apps/web/src/components/ChatComposer.tsx`

```tsx
// Adjust grid for narrow screens
<div className="w-[288px] max-sm:w-[calc(100vw-1rem)] grid grid-cols-8 max-sm:grid-cols-6">
```

#### 6.2.4 Login Bottom Padding

File: `apps/web/src/components/LoginRoute.tsx`

```tsx
<main className="... pb-8 sm:pb-0">
```

### 6.3 P2 — Polish

#### 6.3.1 Right Panel as Bottom Sheet

File: `apps/web/src/components/RightMemberPanel.tsx`

Instead of `max-md:hidden`, render the member panel as a bottom sheet overlay on mobile:

```
┌────────────────────────────────┐
│                                │
│         Chat Area              │
│                                │
├────────────────────────────────┤
│ Members (bottom sheet)         │
│ Alice  ●                       │
│ Bob    ●                       │
│ Carol  ○                       │
└────────────────────────────────┘
```

Triggered by the existing "Members" button in ChatHeader. Dismissed by swiping down or tapping outside.

#### 6.3.2 Touch Target Sizes

File: `apps/web/src/components/ChannelList.tsx`

Channel/DM list items: increase padding to reach minimum 44×44px touch target (Apple HIG):

```tsx
// Before
<div className="px-2 py-0.5">
// After
<div className="px-2 py-2 min-h-[44px] flex items-center">
```

#### 6.3.3 Channel Name Truncation

File: `apps/web/src/components/ChannelList.tsx`

```tsx
<span className="truncate">{channel.name}</span>
```

#### 6.3.4 Safe Area Inset

File: `apps/web/src/components/ChatComposer.tsx`

```tsx
<form className="pb-[env(safe-area-inset-bottom,0px)]">
```

File: `apps/web/src/components/ChatRoute.tsx` (sidebar bottom tab bar)

```tsx
<div className="pb-[env(safe-area-inset-bottom,0px)]">
```

#### 6.3.5 Composer Keyboard Avoidance

File: `apps/web/src/components/ChatComposer.tsx`

The composer is at the bottom of the flex layout and will be pushed up by the virtual keyboard on most browsers. For iOS Safari with `visualViewport`, additional handling may be needed:

```typescript
useEffect(() => {
  const handler = () => {
    const viewport = window.visualViewport;
    if (viewport) {
      document.documentElement.style.setProperty(
        '--viewport-offset',
        `${window.innerHeight - viewport.height}px`
      );
    }
  };
  window.visualViewport?.addEventListener('resize', handler);
  return () => window.visualViewport?.removeEventListener('resize', handler);
}, []);
```

Note: this is P2. Most mobile browsers handle this acceptably without explicit intervention.

---

## 7. Component Reference

### 7.1 Component Files (`apps/web/src/components/`)

| File | Purpose | Key Classes / Styles |
|------|---------|---------------------|
| `App.tsx` | Root render switch | `h-screen overflow-hidden` |
| `ChatRoute.tsx` | Main layout orchestration | `grid grid-cols-[280px_1fr] max-md:grid-cols-1` |
| `ChatHeader.tsx` | Channel name, badges, transport, hamburger | `flex flex-wrap items-center gap-3` |
| `ChatComposer.tsx` | Message input, emoji picker, file upload, suggestions | `InputActionBar` wrapper |
| `MessageList.tsx` | Virtualized message list | `flex-1` (react-virtuoso) |
| `MessageRow.tsx` | Single message display, context menu | `mx-4 my-1 px-4 py-1` |
| `ContextMenu.tsx` | Right-click action menu | `fixed` position at cursor |
| `ChannelList.tsx` | Channel/DM list with unread | `flex flex-col` |
| `RightMemberPanel.tsx` | Right sidebar member list | `max-md:hidden` |
| `ForwardModal.tsx` | Forward message overlay | `fixed inset-0 z-50` |
| `DeleteConfirmModal.tsx` | Delete confirmation overlay | `fixed inset-0 z-50` |
| `LoginRoute.tsx` | Login form | `max-w-md w-full` |
| `PolicyControl.tsx` | E2E disappearing message policy | `flex flex-wrap gap-1` |

### 7.2 Hooks (`apps/web/src/hooks/`)

| Hook | Purpose |
|------|---------|
| `useAttachments.ts` | File upload state, clipboard paste |
| `useChannelMembers.ts` | Channel member CRUD, sender names |
| `useChatBootstrap.ts` | Initial data loading, seed data |
| `useMessageActions.ts` | Copy, edit, delete, react, forward |
| `useReadReceipts.ts` | IntersectionObserver-based read ack |
| `useTyping.ts` | Typing indicator start/stop debounce |

### 7.3 Stores (`apps/web/src/stores/`)

Single file: `domain.ts` with 8 Zustand stores (see Section 2).

### 7.4 Library (`apps/web/src/lib/`)

| File | Purpose |
|------|---------|
| `api.ts` | `API_BASE`, `apiRequest` fetch wrapper |

### 7.5 Shared UI Package (`packages/ui/src/`)

| Export | Purpose |
|--------|---------|
| `InputActionBar` | Composer wrapper with action buttons |
| `createInputActionBar` | Factory for action bar configuration |

---

## 8. Design Decisions

### 8.1 Why overlay drawer, not hamburger-replace

On mobile, replacing the sidebar content inline (above the chat) with the current `max-md:grid-cols-1` approach is unusable:

- The sidebar is 85% channel navigation, which is not the immediate task on mobile
- Users open the app to read and send messages; channel switching is secondary
- An overlay drawer provides the same navigation capability without sacrificing screen real estate for messages

### 8.2 Why long-press, not tap-to-select

Desktop uses right-click for context actions. Mobile has no right-click. Alternatives:

| Approach | Pro | Con |
|----------|-----|-----|
| Tap-to-select-then-action-bar | Discoverable | Extra step; breaks existing muscle memory |
| Swipe actions (left/right) | Common in chat apps | Complex to implement on a virtualized list |
| **Long-press → bottom sheet** | **Matches iOS/Android convention** | **Requires 500ms delay** |

Long-press is the most native-feeling option for mobile messaging apps.

### 8.3 Why `md:768px` breakpoint

Tailwind's default `md` breakpoint at 768px is the standard tablet/mobile boundary. Most tablets in landscape are ≥768px and can use the desktop layout. Phones in portrait are <768px and get the mobile layout.

### 8.4 Why no custom breakpoints

The default Tailwind breakpoints are sufficient:
- `md:768px` covers all phones (portrait) and most small tablets
- The desktop layout works from 768px upward
- No need for a custom `mobile` breakpoint at e.g., 480px

---

## 9. URL / Routing

No client-side router is used. The entire app lives on a single URL. State transitions are driven by:

- `useAuthStore.user` — toggles between `LoginRoute` and `ChatRoute`
- `useChannelStore.activeChannelId` — toggles between "welcome" view and "messages" view
- `useUiStore.sidebarOpen` — toggles sidebar visibility (mobile)
- `rightSidebarOpen` (local state in ChatRoute) — toggles right member panel

---

## 10. Themes

Two themes supported via `useUiStore.settings.theme`:

| Theme | Background | Text |
|-------|-----------|------|
| **Dark** (default) | `bg-slate-950` / `bg-slate-900` | `text-slate-100` |
| **Light** | `bg-white` / `bg-slate-50` | `text-slate-900` |

Theme is persisted in `localStorage` and applied via Tailwind class toggling.

---

## 11. Notifications

### 11.1 Toast Notifications

- Position: `absolute right-2 top-2` in chat area
- Content: new message preview with channel name
- Click: navigates to the channel
- Auto-dismiss: 5 seconds

### 11.2 Browser Notifications

- Permission requested on first login (`Notification.requestPermission()`)
- Triggered for new messages when the tab is not focused
- Managed by `useChatBootstrap` hook

---

## 12. Responsive Behavior Summary

| Viewport | Sidebar | Right Panel | Grid | Context Menu |
|----------|---------|-------------|------|--------------|
| ≥ 768px (Desktop) | Permanent left column | Conditional right column | `grid-cols-[280px_1fr]` or `grid-cols-[280px_1fr_260px]` | Right-click dropdown at cursor |
| < 768px (Mobile) | Overlay drawer (hamburger toggle) | Bottom sheet (member button toggle) | `grid-cols-[1fr]` | Long-press → bottom action sheet |
