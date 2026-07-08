---
lang: en
phase: 1
status: todo
---

# 26 — Phase 1 — Web Mobile Adaptation

## Goal

Make the Web client fully usable on mobile devices (< 768px viewport width) by adding responsive layout, touch-friendly interactions, and platform-appropriate UI patterns.

## Current State

The Web client has almost no mobile adaptation:

- No `<meta name="viewport">` tag — browsers render at 980px desktop viewport, unreadable on phones.
- Only 3 responsive Tailwind classes exist: `max-md:grid-cols-1`, `max-md:border-b`, `max-md:hidden`.
- `max-md:grid-cols-1` stacks the full 280px sidebar above the chat area — users must scroll past the entire channel list to see messages.
- `onContextMenu` (right-click) has no touch equivalent — messages are uninteractive on mobile.
- Modals use fixed widths (`w-80`, `w-72`) that overflow on narrow viewports.
- Emoji picker is fixed at 288px + 8-column grid — overflows on small screens.
- Channel list items have small tap targets (~28px height).

## Scope

### P0 — Essential (app is broken on mobile without these)

**26.1 Viewport Meta Tag** (`apps/web/index.html`)

- Add `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.

**26.2 Mobile Sidebar as Overlay Drawer** (`apps/web/src/components/ChatRoute.tsx`)

- On `max-md:`, sidebar becomes a fixed overlay sliding in from the left (85vw, max 320px).
- Controlled by `useUiStore.sidebarOpen` (state already exists, unused).
- Semi-transparent backdrop overlay; tap to close.
- Selecting a channel auto-closes the sidebar.
- `Escape` key closes.
- CSS transition: `transition-transform duration-200`.

**26.3 Mobile Grid** (`apps/web/src/components/ChatRoute.tsx`)

- Desktop: `grid-cols-[280px_1fr]` (unchanged).
- Mobile: `max-md:grid-cols-[1fr]` (sidebar removed from grid flow, rendered as fixed overlay).

**26.4 Hamburger Menu Button** (`apps/web/src/components/ChatHeader.tsx`)

- Add a three-line hamburger icon visible only on `max-md:`.
- Toggle `useUiStore.setSidebarOpen()` on click.
- Position: before the channel name, left side of the header.

**26.5 Long-Press Context Menu** (`apps/web/src/components/MessageRow.tsx`)

- Add `onTouchStart` / `onTouchEnd` with 500ms timer for long-press detection.
- Cancel on `onTouchMove` if finger moves >10px.
- On mobile (`max-md:`), render the action menu as a bottom sheet instead of a fixed-position dropdown.
- Actions: Reply, Copy, Forward, Edit, Delete, React.

### P1 — High Priority

**26.6 Responsive Modals** (`apps/web/src/components/ForwardModal.tsx`, `DeleteConfirmModal.tsx`)

- ForwardModal: `w-80` → `w-[calc(100vw-2rem)] max-w-80`.
- DeleteConfirmModal: `w-72` → `w-[calc(100vw-2rem)] max-w-72`.
- Add `max-h-[80vh] overflow-y-auto` to both for scrollable content.

**26.7 Emoji Picker Responsive Sizing** (`apps/web/src/components/ChatComposer.tsx`)

- Width: `w-72` → `w-[18rem] max-sm:w-[calc(100vw-1rem)]`.
- Grid: `grid-cols-8` → `grid-cols-8 max-sm:grid-cols-6`.

**26.8 Login Bottom Padding** (`apps/web/src/components/LoginRoute.tsx`)

- Add `pb-8 sm:pb-0` to the main container.

### P2 — Polish

**26.9 Right Panel as Bottom Sheet** (`apps/web/src/components/RightMemberPanel.tsx`)

- Instead of `max-md:hidden`, render as a bottom sheet overlay on mobile.
- Triggered by existing "Members" button.
- Dismissed by swipe down or tap outside.

**26.10 Touch Target Sizes** (`apps/web/src/components/ChannelList.tsx`)

- Increase list item padding to reach 44×44px minimum touch target.
- `px-2 py-0.5` → `px-2 py-2 min-h-[44px] flex items-center`.
- Add `truncate` to channel names.

**26.11 Safe Area Inset** (`apps/web/src/components/ChatComposer.tsx`, `ChatRoute.tsx`)

- Composer: `pb-[env(safe-area-inset-bottom,0px)]`.
- Sidebar bottom tab bar: `pb-[env(safe-area-inset-bottom,0px)]`.

## Acceptance Criteria

- [ ] Phone browser renders at native device width (not zoomed-out 980px).
- [ ] Sidebar is hidden by default on mobile; hamburger button opens it as a left-sliding overlay.
- [ ] Tapping a channel closes the sidebar and navigates to the channel.
- [ ] Chat area fills the full screen on mobile, with composer at the bottom.
- [ ] Long-pressing a message shows action options (Reply, Copy, Forward, Edit, Delete, React).
- [ ] All modals fit within the viewport without overflow.
- [ ] Emoji picker does not overflow on screens < 375px wide.
- [ ] Channel list items have comfortable tap targets (≥44px).
- [ ] Desktop layout is completely unchanged (no regressions).
- [ ] `pnpm --filter @nexus-chat/web typecheck` passes.
- [ ] `pnpm --filter @nexus-chat/web test` passes.
- [ ] Manual smoke: login → create channel → send message → reply/edit/delete/forward → switch channels → logout on a phone viewport.

## Design Reference

See `docs/design/09_Web_Client_UI_Design.md` for full component architecture and mobile adaptation design decisions.
