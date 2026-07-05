---
lang: en
phase: 1
status: draft
---

# 13 — Phase 1 — React Web Client Shell & Core Chat UI

## Goal

Build the React renderer used by both web development and Electron desktop. The UI should expose only generic IM and Bot extension surfaces, not feature-specific hardcoded workflows.

## Scope

- Vite + React app.
- Routing for auth and chat.
- Zustand stores.
- Workspace/sidebar layout.
- Channel list and DM list.
- Message list with `react-virtuoso`.
- Message input.
- Slash command autocomplete from installed bot manifests.
- Generic `InputActionBar` extension slot.
- E2E mode badge/banner.
- E2E read-once/disappearing message controls and expired-message tombstone rendering.
- Optimistic send state for messages.

## Non-Goals

- No file upload button hardcoded in core UI.
- No poll/reminder/kudos-specific UI.
- No AI-specific UI beyond generic streaming renderer if implemented.

## Store Boundaries

| Store | Responsibility |
|-------|----------------|
| `authStore` | Current user/session |
| `workspaceStore` | Workspaces and members |
| `channelStore` | Channels, current channel, unread counts |
| `messageStore` | Normalized messages, cursors, optimistic states |
| `presenceStore` | Online and typing state |
| `signalStore` | E2E sessions and key state |
| `botStore` | Installed bots, command manifests, input actions |
| `uiStore` | Layout, theme, modals, transient command state |

## Acceptance Criteria

- User can log in and see workspace shell.
- User can switch channels.
- Message list virtualizes correctly.
- User can send text message.
- Slash command suggestions are generated from bot manifests.
- Input action bar accepts bot-registered actions.
- E2E channels show clear no-bot warning.
- E2E read-once and TTL messages show clear policy labels before send and tombstones after expiry.

## Test Plan

- Component tests for channel list and message list.
- Store tests for message normalization.
- Command autocomplete test from mock bot manifest.
- Virtual list scroll test.
- Disappearing-message policy and tombstone rendering tests.

## Dependencies

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [05 — Core Gateway](05-phase-1-core-gateway.md)
- [07 — Message Service](07-phase-1-message-service.md)
