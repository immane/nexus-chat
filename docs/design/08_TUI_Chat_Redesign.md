# 08 — TUI Chat Redesign

> Based on: Web client architecture and OpenCode TUI layout reference.
> Created: 2026-07-08

## 1. Goal

Redesign the TUI interactive chat (`apps/tui/src/app.tsx`) from a single-column stack into a fixed two-pane layout with a status bar, mirroring the Web client's sidebar + message area split. The visual style references OpenCode's file-tree + editor layout.

---

## 2. Target Layout

```
┌──────────────────────────────────────────────────────────┐
│  Nexus Chat                    WS: connected   alice@t   │  ← TopBar
├──────────────┬───────────────────────────────────────────┤
│ Channels (5) │  # general                    [3 online]  │  ← ChatHeader
│ [Search...]  │                                           │
│              │  Alice  10:30                             │
│ # general (3)│  Hello world!                             │
│ # random     │  👍 2                                     │
│ @ Bob   [E2E]│                                           │
│ @ Carol [E2E]│  Bob  10:31                               │
│              │  Hey!                                     │
│              │                                           │
│              │  ──── Yesterday ────                      │
│              │                                           │
│ [Chat] [Mbr] │                                           │
├──────────────┴───────────────────────────────────────────┤
│ > Type a message...                          Enter send  │  ← Composer
└──────────────────────────────────────────────────────────┘
│ #general │ Alice typing... │ r=Reply e=Edit d=Delete     │  ← BottomBar
```

---

## 3. Component Tree

```
<ChatShell>                              // Full-screen container (flexDirection="column")
├── <TopBar />                           // Title + WS status + username
├── <Box flexDirection="row" flexGrow={1}>  // Main area (row layout)
│   ├── <Sidebar width={28}>             // Left pane
│   │   ├── <SidebarHeader />            // "Channels (N)" + search input
│   │   ├── <ChannelList />              // Scrollable list with focus
│   │   └── <SidebarTabs />              // [Chat] [Members] [Settings]
│   └── <MainPanel flexGrow={1}>         // Right pane
│       ├── <ChatHeader />               // #channel + typing + online count
│       ├── <MessageArea />              // Scrollable messages with focus
│       └── <Composer />                 // Input bar with mode awareness
├── <BottomBar />                        // Status: shortcuts / typing / current channel
└── <Overlay />                          // Modal layer: forward picker, delete confirm, reaction input
```

---

## 4. Pane Details

### 4.1 TopBar

```
┌──────────────────────────────────────────────────────────┐
│  Nexus Chat                    WS: connected   alice@t   │
└──────────────────────────────────────────────────────────┘
```

- Left: project name (cyan bold).
- Right: WebSocket connection indicator (green `● connected` / red `● disconnected`) + current user email.
- Bottom border via `borderStyle="single"`.
- Height: 1 row.

### 4.2 Sidebar (Left Pane)

```
┌──────────────┐
│ Channels (5) │  ← Header with count
│ [Search...]  │  ← Filter (Ctrl+F to focus)
│              │
│ # general (3)│  ← Green prefix, unread count, bold if active
│ # random     │
│ @ Bob   [E2E]│  ← Cyan prefix for DM, yellow [E2E] tag
│ @ Carol [E2E]│
│              │
│ [💬 Chat   ] │  ← Tab bar
│ [👥 Members] │
│ [⚙ Settings] │
└──────────────┘
```

- **Width**: `Math.min(30, Math.floor(termColumns * 0.25))`.
- **Channel list**:
  - `#` green for normal channels, `@` cyan for DMs.
  - E2E tag in yellow.
  - Unread count in green `(N)`.
  - Active channel highlighted (bold + background).
  - `↑`/`↓` to navigate, `Enter` to select.
- **Tab bar** (`Ctrl+1/2/3`):
  - `Chat`: channel list (default).
  - `Members`: workspace member list with online status dots (`●`/`○`).
  - `Settings`: theme, notifications, token info.
- Right border via `borderStyle="single"`.

### 4.3 ChatHeader

```
│  # general                    [3 online] │
```

- Left: `# channelName` (or `@ DMName`) with optional yellow `[E2E]` tag.
- Right: online member count `[N online]`.
- When someone is typing: `Alice is typing...` replaces the right section.
- Height: 1 row.

### 4.4 MessageArea

```
│  Alice  10:30                             │
│  Hello world!                             │
│  👍 2                                     │
│                                           │
│  ──── Yesterday ────                      │
│                                           │
│  Alice  Yesterday 15:22                   │
│  Old Message...              (edited)     │
```

- **Sender**: blue bold (self: yellow).
- **Timestamp**: gray, relative ("3m ago").
- **Body**: white.
- **Edited marker**: gray `(edited)`.
- **Reactions**: emoji + count in the row below the body (`👍 2 ❤️ 1`). User's own reactions shown in cyan.
- **Date separator**: centered `──── Yesterday ────`.
- **Tombstone**: gray `~ Message deleted ~`.
- **Attachments**: `📎 report.pdf (2.3MB)` text marker.
- **Scrolling**:
  - `↓`/`↑`: move focus one message.
  - `PgDn`/`PgUp`: page up/down.
  - `Home`/`End`: jump to newest/oldest.
  - Scroll to top triggers `GET /api/v1/channels/:id/messages?cursor=...` for pagination.
  - New incoming messages auto-scroll to bottom.
- **Message focus**: a highlighted row prefixed with `>`. When a message is focused the bottom bar shows available actions.

### 4.5 Composer

```
├───────────────────────────────────────────┤
│ > Type a message...              Enter ⏎  │
└───────────────────────────────────────────┘
```

- Prompt `>` then the input text.
- Placeholder when empty (gray).
- Right hint: `Enter ⏎` (or `Ctrl+Enter` for newline).
- E2E channels: `[E2E]` prefix before the prompt.
- Edit mode: pre-filled with original text, placeholder `Editing...`.
- Reply mode: `Replying to {sender}: {snippet}` row above the input.
- Multi-line: `Ctrl+Enter` for newline; height grows up to 5 rows.
- Top border separator.

### 4.6 BottomBar

```
│ #general │ Alice typing... │ r=Reply e=Edit d=Delete  │
```

- Left: current channel name.
- Center: dynamic status or typing indicator.
- Right: keyboard shortcut hints (context-dependent on the focused panel):
  - Message area focused: `r=Reply e=Edit d=Delete c=Copy f=Forward +=React`
  - Sidebar focused: `↑↓=Nav Enter=Select n=NewChannel Esc=Back`
- Top border separator.

### 4.7 Overlay

- **Forward modal**: centered channel list with search; `Enter` to confirm, `Esc` to cancel.
- **Delete confirm**: `Delete this message? [Y/n]`.
- **Reaction input**: `Enter emoji: _`.
- **Member panel**: replaces sidebar content when the Members tab is active.

---

## 5. Data Flow

Single orchestrator (`ChatShell`), analogous to Web `ChatRoute`:

```
ChatShell
  ├── useTerminalSize()      → { columns, rows }
  ├── useChannelData()       → { channels, members, activeChannel, senderNames }
  ├── useMessages()          → { messages, send, edit, delete, react, forward }
  ├── useKeyboard()          → global shortcuts + panel dispatch
  ├── useFocus()             → { activePanel, focusedIndex }
  │
  ├──→ Sidebar:       channels, activeChannel, onSelect, focusState
  ├──→ ChatHeader:    activeChannel, typingUsers, onlineCount
  ├──→ MessageArea:   messages, focusedIndex, onAction(r/e/d/c/f/+)
  ├──→ Composer:      draft, onSubmit, editMode, replyTo
  ├──→ TopBar:        wsStatus, currentUser
  ├──→ BottomBar:     activeChannel, shortcutHints
  └──→ Overlay:       modalType, modalData
```

---

## 6. WebSocket Events

Extend `ws-client.ts` to listen for all server events instead of only `message.created`:

| Event | Handler |
|-------|---------|
| `message.created` | Append / deduplicate in message list |
| `message.updated` | Replace message in list |
| `message.deleted` | Replace with tombstone |
| `message.reaction` | Update reaction map |
| `message.read` | Update read receipt counts |
| `typing.updated` | Update typing users map |
| `presence.updated` | Update online status set |
| `channel.created` | Append channel to sidebar |
| `dm.created` | Append DM to sidebar |

---

## 7. Keyboard Shortcuts

### Global

| Key | Action |
|-----|--------|
| `Ctrl+Q` | Quit |
| `Ctrl+L` | Focus left sidebar |
| `Ctrl+M` | Focus message area |
| `Ctrl+I` | Focus composer |
| `Tab` | Cycle focus panels |
| `Esc` | Go back / close overlay |

### Sidebar (focused)

| Key | Action |
|-----|--------|
| `↑`/`↓` | Navigate channels |
| `Enter` | Enter channel |
| `n` | New channel |
| `Ctrl+F` | Search channels |
| `Ctrl+1/2/3` | Switch tab (Chat / Members / Settings) |

### MessageArea (focused)

| Key | Action |
|-----|--------|
| `↑`/`↓` | Move message focus |
| `PgDn`/`PgUp` | Page up/down |
| `Home`/`End` | Jump newest/oldest |
| `r` | Reply |
| `e` | Edit (own text-type only) |
| `d` | Delete (own only, confirms) |
| `c` | Copy text |
| `f` | Forward |
| `+` | Add reaction |

### Composer (focused)

| Key | Action |
|-----|--------|
| `Enter` | Send |
| `Ctrl+Enter` | Newline |
| `Esc` | Cancel edit/reply mode |

---

## 8. File Changes

```
apps/tui/src/
├── app.tsx              → Rewritten as <ChatShell> orchestrator
├── components/          ← New directory
│   ├── TopBar.tsx
│   ├── BottomBar.tsx
│   ├── Sidebar.tsx
│   ├── ChatHeader.tsx
│   ├── MessageArea.tsx
│   ├── MessageRow.tsx
│   ├── Composer.tsx
│   ├── Overlay.tsx
│   └── StatusBar.tsx
├── hooks/               ← New directory
│   ├── useTerminalSize.ts
│   ├── useChannelData.ts
│   ├── useMessages.ts
│   ├── useKeyboard.ts
│   └── useFocus.ts
├── lib/
│   ├── api.ts           ← Unchanged
│   ├── ws-client.ts     ← Extended: listen for all server WS events
│   └── format.ts        ← New: relative time, display names, date separators
├── cli.ts               ← Unchanged
├── index.ts             ← Unchanged
└── commands/smoke.ts    ← Unchanged
```

---

## 9. Implementation Steps

| Step | Description | Est. Time |
|------|-------------|-----------|
| 1 | Base layout: `ChatShell` with TopBar, Sidebar, MainPanel, BottomBar; `useTerminalSize` | 30 min |
| 2 | Enhanced channel list: display names, unread counts, tab bar framework, highlighted row | 30 min |
| 3 | Message area rewrite: focus system, relative times, date separators, scroll + pagination | 45 min |
| 4 | WebSocket event expansion: listen for all server events in `ws-client.ts` | 20 min |
| 5 | Message actions: reply, edit, delete, react, forward via REST API; overlay modals | 45 min |
| 6 | Composer enhancement: multi-line, typing indicators, bot command detection | 30 min |

**Total**: ~3 hours
