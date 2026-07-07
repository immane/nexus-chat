---
lang: en
phase: 1
status: done
---

# 24 — Phase 1 — Server Channel Mute & Description Backend

## Goal

Add per-channel mute state and channel description/topic field to the backend store and API, enabling the Web client to implement channel muting and rich channel info displays.

## Scope

### Channel Description
- Add optional `description?: string` field to the `Channel` type and `channelSchema` in `packages/shared/src/index.ts`.
- Store in `InMemoryStore.channels` (already stores `Channel` objects).
- `PATCH /api/v1/channels/:id` — update channel `name` and/or `description`. Requires `canManageChannel` permission.
- Include `description` in channel list and get-channel responses.
- Audit log entry: `channel.updated` when name or description changes.

### Channel Mute
- Add `channelMutes: Map<string, Set<string>>` to `InMemoryStore` (`userId → Set<channelId>` or `channelId → Set<userId>`).
- `POST /api/v1/channels/:id/mute` — mute a channel for the current user.
- `DELETE /api/v1/channels/:id/mute` — unmute a channel.
- `GET /api/v1/channels/:id/mute-status` — check mute status for current user.
- Include mute status in channel list responses as `muted: boolean`.
- Muted channels:
  - Still receive messages (messages stored normally).
  - Still accumulate unread counts.
  - Do not trigger notification toasts or browser notifications.
  - Visual indicator (🔇 icon) in channel list.

### Description Validation
- `description` max 500 characters.
- Accept plain text only (no HTML/markdown in description; rich rendering deferred).
- Trim whitespace on save.

### Mute Scope Decision
- Mute is per-user per-channel (not per-workspace, not global).
- Mute is persistent across sessions (stored in-memory in Phase 1; persists in DB Phase 2).
- Server does not enforce mute at message delivery level — mute is an advisory flag consumed by clients.
- Server includes `muted` in channel list and get-channel responses so clients can filter notifications.

## Non-Goals

- No channel-level notification overrides (custom sounds per channel — Phase 2).
- No mute duration presets (mute for 1h/8h/forever — mute is binary in Phase 1).
- No workspace-level mute.
- No channel topic rich text (plain text only).

## Dependencies

- `channelSchema` update in `packages/shared/src/index.ts` (add `description`).
- `Channel` type must be updated across all consumers (server, shared, web, TUI).
- Existing tests validate `Channel` shape — update test fixtures to include `description`.

## Acceptance Criteria

- [ ] `Channel` type includes optional `description` field (max 500 chars).
- [ ] `PATCH /api/v1/channels/:id` updates name and/or description with permission check.
- [ ] `POST /api/v1/channels/:id/mute` / `DELETE` mute endpoints working.
- [ ] `GET /api/v1/channels/:id/mute-status` returns `{ muted: boolean }`.
- [ ] Channel list responses include `muted` and `description` fields.
- [ ] Existing channel creation / listing tests continue passing.
- [ ] Audit log records `channel.updated` events.
