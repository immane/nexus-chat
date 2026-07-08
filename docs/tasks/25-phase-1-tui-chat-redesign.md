---
lang: en
phase: 1
status: pending
---

# 25 — Phase 1 — TUI Chat Interface Redesign

## Goal

Redesign the TUI interactive chat from a single-column stack into a two-pane layout with a status bar, mirroring the Web client architecture. Improve message display with relative timestamps, date separators, sender display names, and keyboard-driven message actions. Add real-time WebSocket responsiveness for edits, deletes, reactions, typing indicators, and presence.

## Scope

### Layout & Navigation

- Replace the current single-column app with a `ChatShell` orchestrator using a fixed two-pane layout:
  - **Left pane** (Sidebar, ~25–30 columns): channel/DM list, search, tab bar (Chat / Members / Settings).
  - **Right pane** (MainPanel): ChatHeader + scrollable MessageArea + Composer.
  - **TopBar**: project name, WebSocket connection status, current user.
  - **BottomBar**: current channel, dynamic status, context-dependent keyboard shortcut hints.
- Implement `useTerminalSize` hook to calculate pane widths from terminal columns.
- Add `useFocus` hook to track which panel is active and enable per-panel keyboard dispatch.

### Channel Sidebar Enhancements

- Resolve sender display names by fetching `GET /api/v1/workspaces/:id/members` and caching `Map<userId, name>`.
- Show unread counts per channel from `useChannelStore` or a local map.
- Add a tab bar (Chat / Members / Settings) with `Ctrl+1/2/3` shortcuts, matching the Web client's left sidebar tabs.
- Members tab: list workspace members with online/offline status dots (`●`/`○`).
- Settings tab: basic user info and token status.

### Message Display

- Render sender name rather than raw `userId`.
- Show relative timestamps ("3m ago", "2h ago", "Yesterday") with a full timestamp on hover/focus.
- Insert date separators (`──── Yesterday ────`) when messages cross calendar day boundaries.
- Show `(edited)` marker when `message.editedAt` is set.
- Render reaction emoji + count below the message body; highlight the current user's reactions in cyan.
- Render tombstone messages with contextual reason text.
- Display attachment metadata as `📎 filename (size)`.
- Support message focus via `↑`/`↓` movement; focused row is highlighted with a `>` prefix.

### Message Actions (Keyboard-Driven)

- **Reply** (`r`): show reply preview above composer; attach `replyToMessageId` on send.
- **Edit** (`e`): only own text-type messages; enter edit mode with original text pre-filled.
- **Delete** (`d`): own messages only; overlay confirmation.
- **Copy** (`c`): write message text to clipboard / stdout.
- **Forward** (`f`): overlay channel picker; POST forward API.
- **React** (`+`): prompt for emoji; POST/DELETE reaction API.
- All actions integrated with `useMessageActions`-style hook for REST calls.

### Composer Enhancements

- Multi-line input: `Enter` to send, `Ctrl+Enter` for newline; height grows up to 5 rows.
- E2E channel indicator (`[E2E]` prefix) in the prompt.
- Edit mode: pre-filled text, `Esc` to cancel.
- Reply mode: reply preview row above the input.
- Send `typing.start` / `typing.stop` WS events on input activity.
- Detect `/` prefix for bot command invocation.

### WebSocket Event Expansion

Extend `lib/ws-client.ts` to listen for all server WS events beyond `message.created`:

| Event | Behavior |
|-------|----------|
| `message.created` | Append to message list (existing). |
| `message.updated` | Replace matching message in list. |
| `message.deleted` | Replace with tombstone. |
| `message.reaction` | Update local reaction map. |
| `message.read` | Update read receipt counts. |
| `typing.updated` | Update typing users map; show in ChatHeader/BottomBar. |
| `presence.updated` | Update online user set. |
| `channel.created` | Append channel to sidebar. |
| `dm.created` | Append DM to sidebar. |

### Message Scrolling & Pagination

- `PgDn`/`PgUp` for page navigation.
- `Home`/`End` to jump to newest/oldest message.
- Scroll to top triggers `GET /api/v1/channels/:id/messages?cursor=...` for loading earlier history (50 messages per page).
- New incoming messages auto-scroll to bottom.

### Overlay System

- Forward channel picker: list channels with search filter; `Enter` to confirm.
- Delete confirmation: `Delete this message? [Y/n]`.
- Reaction input: `Enter emoji: _`.
- All overlays dismissed with `Esc`.

### Keyboard Shortcuts

#### Global

| Key | Action |
|-----|--------|
| `Ctrl+Q` | Quit |
| `Ctrl+L` | Focus sidebar |
| `Ctrl+M` | Focus message area |
| `Ctrl+I` | Focus composer |
| `Tab` | Cycle focus |
| `Esc` | Go back / close overlay |

#### Sidebar

| Key | Action |
|-----|--------|
| `↑`/`↓` | Navigate channels |
| `Enter` | Enter channel |
| `n` | New channel |
| `Ctrl+F` | Search channels |

#### MessageArea

| Key | Action |
|-----|--------|
| `↑`/`↓` | Move message focus |
| `PgDn`/`PgUp` | Page up/down |
| `Home`/`End` | Jump newest/oldest |
| `r` | Reply |
| `e` | Edit |
| `d` | Delete |
| `c` | Copy |
| `f` | Forward |
| `+` | Add reaction |

#### Composer

| Key | Action |
|-----|--------|
| `Enter` | Send |
| `Ctrl+Enter` | Newline |
| `Esc` | Cancel edit/reply mode |

## Non-Goals

- No file upload or image rendering (terminal limitation).
- No right-click context menu (keyboard shortcuts instead).
- No virtual scrolling (Ink limitation; use pagination instead).
- No E2E encryption integration in interactive chat (deferred; Signal facade already available but send path currently sends plaintext).
- No desktop notifications (terminal bell `\a` could be a future addition).

## Deliverables

### New Files

```
apps/tui/src/components/
├── TopBar.tsx
├── BottomBar.tsx
├── Sidebar.tsx
├── ChatHeader.tsx
├── MessageArea.tsx
├── MessageRow.tsx
├── Composer.tsx
├── Overlay.tsx
└── StatusBar.tsx

apps/tui/src/hooks/
├── useTerminalSize.ts
├── useChannelData.ts
├── useMessages.ts
├── useKeyboard.ts
└── useFocus.ts

apps/tui/src/lib/
└── format.ts
```

### Changed Files

```
apps/tui/src/app.tsx             ← Rewrite as ChatShell orchestrator
apps/tui/src/lib/ws-client.ts    ← Extend to listen for all server WS events
```

## Verification

- `pnpm --filter @nexus-chat/tui lint`
- `pnpm --filter @nexus-chat/tui typecheck`
- `pnpm --filter @nexus-chat/tui test`
- `pnpm --filter @nexus-chat/tui build`
- Manual smoke: `nexus chat` to verify layout rendering, channel navigation, message send/receive.
- Existing CLI smoke tests (`nexus api-smoke`, `nexus ws-smoke`) must continue to pass.

## References

- Design doc: `docs/design/08_TUI_Chat_Redesign.md`
- Web implementation: `apps/web/src/components/ChatRoute.tsx`, `apps/web/src/hooks/`
- Current TUI: `apps/tui/src/app.tsx`
