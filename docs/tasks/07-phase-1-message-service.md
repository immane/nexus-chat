---
lang: en
phase: 1
status: done
---

# 07 — Phase 1 — Message Service, State Machine & Core IM Actions

## Goal

Implement core message persistence, delivery state, pagination, edits/deletes, reactions, read receipts, and core IM actions such as forward and saved items.

## Scope

- `message.send` for normal and E2E channels.
- Message ID generation.
- Idempotency via `(sender_id, client_msg_id)`.
- Cursor pagination.
- Edit message.
- Soft delete message.
- Emoji reactions.
- Read receipt aggregation.
- E2E disappearing-message lifecycle metadata (`read_once`, `ttl`, tombstone/expired state).
- Forward message as core IM action.
- Save/bookmark message as core IM action.

## Non-Goals

- No polls/reminders/kudos/todos.
- No attachment upload implementation beyond attachment references.
- No server-side search indexing beyond writing searchable text.

## State Machine

```text
DRAFT → SENDING → SENT → DELIVERED → READ
                  ↓
                FAILED
```

Server persists only stable states (`sent`, `delivered`, `read`, `deleted`). `draft`, `sending`, and `failed` are primarily client-side states.

## Core Actions

| Action | Core or Bot | Reason |
|--------|-------------|--------|
| Send text | Core | Fundamental IM |
| Edit/delete | Core | Message lifecycle |
| React | Core | Fundamental IM |
| E2E read-once expiration | Core | Message lifecycle and privacy primitive |
| Forward | Core | Message routing primitive |
| Save/bookmark | Core | Personal IM utility |
| Poll | Bot | Workflow feature |
| Reminder | Bot | Workflow feature |

## Acceptance Criteria

- Send message returns server message ID and timestamp.
- Duplicate `clientMsgId` returns existing message or idempotent success.
- Pagination returns stable results with cursor.
- Edit/delete emits events to channel members.
- Read receipts are buffered and flushed in batches.
- E2E read-once messages expire after the first successful recipient read acknowledgment and are returned as tombstones afterward.
- E2E TTL messages expire through server-side metadata cleanup without decrypting content.
- Forward preserves original attribution metadata.
- Saved messages are user-private.

## Test Plan

- Unit tests for state transitions.
- Integration test for duplicate send.
- Pagination test across 100+ messages.
- Edit/delete authorization tests.
- Reaction add/remove tests.
- Read receipt batch flush test.
- E2E read-once tombstone test.
- E2E TTL expiration cleanup test.

## Dependencies

- [05 — Core Gateway](05-phase-1-core-gateway.md)
- [06 — Workspace & Channel Service](06-phase-1-workspace-channel-service.md)
