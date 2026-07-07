---
lang: en
phase: 1
status: todo
---

# 23 — Phase 1 — Server Message Reply & Pin Backend

## Goal

Add `replyToMessageId` support to the message send pipeline and implement message pinning (store + API), so Web can complete the reply quote and pin message features.

## Scope

### Message Reply (`replyToMessageId`)
- Add `replyToMessageId` as an optional field to `sendMessageSchema` in `packages/shared/src/index.ts`.
- In `messageService.send()`:
  - Validate that `replyToMessageId` references an existing message in the same channel.
  - Ensure the referenced message is accessible to the sender (via `workspaceService.canAccessChannel`).
  - Return `NOT_FOUND` if referenced message doesn't exist.
  - Store `replyToMessageId` on the new message.
- Include `replyToMessageId` in the `Message` type and message list responses.
- WebSocket `message.created` event includes `replyToMessageId` so clients can render the reply quote.

### Message Pin
- Add `pinnedMessages: Map<string, Set<string>>` to `InMemoryStore` (`channelId → Set<messageId>`).
- `POST /api/v1/channels/:id/pins` — pin a message. Requires admin/creator or message owner permission.
- `DELETE /api/v1/channels/:id/pins/:messageId` — unpin a message. Same permission model.
- `GET /api/v1/channels/:id/pins` — list pinned messages for a channel.
- Pin limit: max 50 pinned messages per channel.
- WS event: `channel.pin_changed { channelId, messageId, pinned: boolean }`.
- Include `pinned` flag on `Message` when returned in channel context.

### Reply Validation
- Cannot reply to a deleted/tombstone message (return `NOT_FOUND`).
- Cannot reply to a read-once consumed message (return `NOT_FOUND`).
- Reply in E2E channels: `replyToMessageId` stored as metadata only; server does not validate ciphertext content.

## Non-Goals

- No thread/reply-chain rendering on server (pure metadata).
- No reply notifications beyond standard message.created.
- No rich reply preview generation (client-side responsibility).
- No pin expiry or auto-unpin.

## Dependencies

- `sendMessageSchema` update requires corresponding Zod schema + TypeScript type sync.
- `Message` type extension requires updating all message projection paths.
- Shared contracts version bump required (package is internal, no external consumers).

## Acceptance Criteria

- [ ] `sendMessageSchema` accepts optional `replyToMessageId`.
- [ ] `messageService.send` validates reply target exists and is accessible.
- [ ] Reply to deleted/expired message returns `NOT_FOUND`.
- [ ] Pinned message store with add/remove/list/lookup.
- [ ] REST endpoints: POST/DELETE/GET for channel pins.
- [ ] WS event `channel.pin_changed` broadcast to channel members.
- [ ] Existing message tests continue passing (reply is additive, not breaking).
