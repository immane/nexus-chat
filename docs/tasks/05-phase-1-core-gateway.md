---
lang: en
phase: 1
status: draft
---

# 05 — Phase 1 — Core Gateway: REST, WebSocket, Rate Limits & Protocol

## Goal

Implement the core Hono + Socket.IO gateway that authenticates clients, validates protocol events, manages WebSocket lifecycle, and routes generic IM and Bot traffic.

## Scope

- Hono HTTP server.
- Socket.IO server.
- JWT middleware for REST.
- JWT middleware for WebSocket handshake.
- Request/connection logging.
- Rate limiting for REST and WebSocket events.
- Heartbeat/ping-pong.
- Room membership: `user:{userId}`, `channel:{channelId}`.
- Generic event envelopes.
- `message.send`, `message.ack`, `typing.start`, `typing.stop`, `presence.update`.
- `bot.command.invoke` as an interaction event.

## Non-Goals

- No feature-specific bot command parsing.
- No poll/reminder/kudos logic.
- No AI-specific logic.
- No raw file upload handling beyond forwarding to Attachment Service APIs.

## Protocol Boundary

Slash commands are not ordinary messages. They are interaction events:

```ts
{
  type: 'bot.command.invoke',
  workspaceId: string,
  channelId: string,
  botName: string,
  command: string,
  args: string[],
  triggerId?: string
}
```

The gateway may create an audit/system message after acceptance, but it must not persist the command as a user text message by default.

## E2E Rule

- Do not trust client-provided `encryption` flags.
- Resolve channel mode from the database.
- If channel mode is `e2e`, skip bot dispatch and treat payload as opaque ciphertext.
- Reject bot commands in E2E channels.

## Acceptance Criteria

- REST server starts and exposes health endpoint.
- WebSocket connection authenticates with JWT.
- Client joins user room and channel rooms after authorization.
- Invalid event payloads are rejected with typed errors.
- WebSocket rate limits apply per user/connection.
- `bot.command.invoke` is routed to Bot Engine only for normal channels.
- E2E channels never emit bot events.

## Test Plan

- WebSocket handshake with valid/invalid JWT.
- Message send in normal channel.
- Message send in E2E channel bypasses bot event.
- Bot command in normal channel succeeds.
- Bot command in E2E channel fails with `e2e_bots_disabled`.
- Rate-limit test for message flood.

## Dependencies

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [04 — Auth & Security](04-phase-1-auth-session-security.md)
