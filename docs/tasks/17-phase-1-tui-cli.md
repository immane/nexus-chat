---
lang: en
phase: 1
status: done
---

# 17 — Phase 1 — TUI Command-Line Client

## Goal

Provide a keyboard-first terminal client that exercises the same public API and WebSocket contracts as the desktop client, enabling fast developer workflows, operational smoke tests, and basic usage from non-GUI environments.

## Scope

- Create `apps/tui` as a Node.js package using Ink for terminal rendering and Commander for command parsing.
- Implement login/logout, token persistence through the OS keychain when available, and `.env` fallback for local development only.
- List workspaces, channels, and 1:1 DMs available to the authenticated user.
- Open a channel or DM and render a scrollback window with message state, sender, timestamp, and E2E mode badge.
- Send normal-mode text messages over the same WebSocket `message.send` contract as the web/desktop client.
- Send and receive Phase 1 E2E DM messages through `packages/signal`, including read-once/disappearing message smoke tests.
- Invoke slash commands and render bot replies in normal channels.
- Provide non-interactive commands for CI smoke tests: `login`, `send`, `read`, `e2e-smoke`, and `bot-smoke`.

## Non-Goals

- No full visual parity with the Electron client.
- No file upload/download UI.
- No plugin UI surfaces or bot interactive components.
- No multi-device E2E support beyond the Phase 1 single-device key model.
- No terminal notifications beyond stdout/stderr and exit codes.

## Proposed Commands

```bash
pnpm --filter @nexus-chat/tui dev
nexus login --server http://localhost:3000 --email user@example.com
nexus workspaces
nexus channels --workspace <workspace-id>
nexus chat <channel-or-dm-id>
nexus send <channel-or-dm-id> "hello"
nexus e2e-smoke --to <user-id> --read-once "secret"
nexus bot-smoke --channel <channel-id> "/help"
```

## Acceptance Criteria

- TUI login succeeds against the local Phase 1 server.
- A user can list workspaces/channels and open a channel or DM.
- A user can send and receive a normal text message.
- A user can establish an E2E DM session and exchange encrypted messages.
- `nexus e2e-smoke --read-once` verifies that the recipient can read once and subsequent fetches return only a tombstone/expired state.
- Slash command smoke test can invoke the reference bot in a normal channel.
- Commands return deterministic exit codes for CI usage.

## Test Plan

- Unit tests for command parsing and config resolution.
- Integration test for auth and workspace/channel listing against the local server.
- WebSocket smoke test for normal message send/receive.
- E2E smoke test for encrypted DM and read-once expiration.
- Bot command smoke test with the reference Help bot.

## Dependencies

- [01 — Project Scaffold](01-phase-1-project-scaffold.md)
- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [05 — Core Gateway](05-phase-1-core-gateway.md)
- [07 — Message Service](07-phase-1-message-service.md)
- [09 — Signal Protocol 1:1 DM E2EE](09-phase-1-signal-dm-e2ee.md)
- [10 — Bot Engine Core](10-phase-1-bot-engine-core.md)
