---
lang: en
phase: 1
status: done
---

# 22 — Phase 1 — Web Presence, Channel Info & Notifications

## Goal

Wire up online presence indicators, add a channel info panel beyond the member list, implement in-app notification toasts and browser notifications, and add loading/empty state UI — completing the Web client's real-time awareness and feedback loop.

## Scope

### Online Presence
- Subscribe to `presence.updated` WS events in ChatRoute.
- Update `usePresenceStore` (`onlineUserIds: Set<string>`) on each event.
- Replace role-colored dots in member list with online status dots:
  - Green dot = online.
  - Gray dot = offline.
  - Keep the existing DM/ban hover actions.
- Show "Online" / "Last seen X" text next to member names.
- DM header shows peer's online status.
- Emit `presence.update` on WebSocket connect (with `status: "online"`).

### Channel Info Panel
- Enhance existing right sidebar beyond member list:
  - Channel/DM name (editable by admin).
  - Channel description / topic text.
  - Member count.
  - Created date.
  - Channel mode badge (normal / E2E).
  - For E2E channels: security info section (encryption status, device count).
- Tabs or sections within the panel: Info / Members.
- Close button to dismiss panel.

### Notification Toasts
- Integrate `sonner` for toast notifications (lightweight, Tailwind-compatible).
- Toast when a new message arrives in a non-active channel: "{sender}: {preview} in #{channel}".
- Click toast → navigate to that channel.
- Browser Notification API fallback for background tabs:
  - Request notification permission on login.
  - `new Notification("Nexus Chat", { body, icon })` on incoming message.
- Throttle: max 1 toast per second to avoid notification storms.

### Loading States
- Skeleton screen on message list during initial load (pulsing placeholder rows).
- Skeleton on channel list during workspace fetch.
- Spinner on auth verification during refresh.

### Empty States
- "No messages yet — say hello!" with friendly illustration in empty channels.
- "No channels joined. Ask an admin for an invite." in empty workspace.
- "No results" for empty member/channel search.
- "Select a channel to start chatting" when no channel is active.

### Connection Status
- Improve existing WS disconnected badge in header:
  - "Connecting…" (yellow) during reconnect.
  - "Connected" (green) — auto-dismiss after 2s.
  - "Disconnected" (red) with click to retry.

## Non-Goals

- No typing indicator rework (already implemented).
- No read receipt rework (already implemented).
- No channel muting UI (requires backend — task 24).
- No custom notification sounds per chat.
- No notification exception settings.
- No "Do Not Disturb" mode.

## Backend Dependencies

Presence events already supported:
- `presence.update` client event
- `presence.updated` server event
- `usePresenceStore` with `onlineUserIds` already defined

Channel info fields partially exist — `Channel` type includes `name`, `createdAt`, `mode`, `isPrivate`. Description field requires backend addition — see task 24.

## Acceptance Criteria

- [ ] Green/gray online status dots on member list items.
- [ ] Online status shown in DM header for the peer user.
- [ ] Channel info panel shows name, mode, member count, created date.
- [ ] Toast notification appears when message arrives in non-active channel.
- [ ] Click toast navigates to the channel.
- [ ] Browser notification sent for background tab (after permission grant).
- [ ] Skeleton loading placeholders during initial data fetch.
- [ ] Friendly empty states for channels, workspaces, and search results.
- [ ] Connection status banner shows Connecting / Connected / Disconnected with color.
