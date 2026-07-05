---
lang: en
phase: 1
status: done
---

# 10 — Phase 1 — Bot Engine Core, Event Dispatch & Command Invocation

## Goal

Implement the generic Bot Engine that handles bot identity, installation, command invocation, event dispatch, queueing, and response validation without knowing feature-specific bot logic.

## Scope

- Bot registration.
- Opaque bot token generation and hash storage.
- Bot token validation for WebSocket connections.
- Bot channel membership.
- Bot event subscriptions.
- `bot.command.invoke` routing.
- Redis Streams event publication.
- BullMQ per-bot queues.
- Bot WebSocket namespace.
- Bot response validation and injection into normal channels.

## Non-Goals

- No poll/reminder/kudos implementation in the engine.
- No AI model calls.
- No file storage authority.
- No marketplace.

## Boundary Rules

- Bot Engine owns extensibility infrastructure.
- Individual bots own workflow behavior.
- Core services own data integrity and authorization.
- E2E channels never emit bot events.

## Token Model

```text
nxbot_v1_<base64url(random_32_bytes)>
```

- Store only `SHA256(token)`.
- DB lookup resolves bot ID, workspace, scopes, revocation state, and installation policy.
- No self-validating HMAC token in Phase 1.

## Command Invocation Flow

```text
Client → bot.command.invoke
  → Gateway auth + channel mode check
  → Bot Engine command lookup
  → BullMQ bot queue
  → Bot WebSocket event
  → Bot response
  → Validate scopes + membership
  → Insert bot message into channel
```

## Acceptance Criteria

- Bot can register and receive token once.
- Bot can connect to `/bots` WebSocket namespace.
- Bot can be added to a normal channel.
- Bot cannot be added to an E2E channel.
- `bot.command.invoke` reaches installed bot.
- Bot response appears as bot-authored message.
- Queue isolation prevents one slow bot from blocking others.

## Test Plan

- Token generation/hash lookup test.
- Bot WebSocket auth test.
- Bot channel membership test.
- E2E channel rejection test.
- Command invocation integration test.
- Queue retry/dead letter test.

## Dependencies

- [03 — Database Schema](03-phase-1-database-schema.md)
- [05 — Core Gateway](05-phase-1-core-gateway.md)
