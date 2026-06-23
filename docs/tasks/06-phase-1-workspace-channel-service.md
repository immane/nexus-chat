---
lang: en
phase: 1
status: draft
---

# 06 — Phase 1 — Workspace, Channel, DM & Membership Services

## Goal

Implement the core workspace/channel domain model that every IM, Bot, and E2E feature depends on.

## Scope

- Workspace create/read/update.
- Workspace member invite/join/remove.
- Workspace roles: owner/admin/member.
- Public/private channel CRUD.
- Channel member add/remove.
- Channel archive/delete.
- DM creation and lookup.
- Channel mode: `normal` or `e2e`.
- Authorization helpers used by Gateway, Message Service, Bot Engine, Signal Service, and Attachment Service.

## Non-Goals

- No channel folders/categories.
- No enterprise role hierarchy.
- No guest accounts.
- No cross-workspace shared channels.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/workspaces` | Create workspace |
| `GET` | `/api/v1/workspaces` | List user workspaces |
| `GET` | `/api/v1/workspaces/:id` | Get workspace |
| `POST` | `/api/v1/workspaces/:id/members` | Invite/add member |
| `DELETE` | `/api/v1/workspaces/:id/members/:userId` | Remove member |
| `POST` | `/api/v1/workspaces/:id/channels` | Create channel |
| `GET` | `/api/v1/workspaces/:id/channels` | List channels |
| `POST` | `/api/v1/channels/:id/members` | Add channel member |
| `DELETE` | `/api/v1/channels/:id/members/:userId` | Remove channel member |
| `POST` | `/api/v1/dms` | Create or get existing DM |

## Authorization Rules

- Workspace owner can transfer ownership.
- Workspace admin can invite/remove members except owner.
- Channel creator/admin can archive channel.
- Private channel membership required for read/write.
- DM is visible only to participants.
- Bots cannot be added to E2E channels.

## Acceptance Criteria

- User can create workspace and default channel.
- User can invite another user.
- User can create public/private channels.
- User can create or retrieve a 1:1 DM.
- Authorization helpers are reusable by other modules.
- E2E channel mode is immutable after creation in Phase 1 unless explicitly designed otherwise.

## Test Plan

- Unit tests for role checks.
- Integration tests for workspace/channel CRUD.
- DM idempotency test: same two users produce same DM.
- Bot-to-E2E membership rejection.

## Dependencies

- [03 — Database Schema](03-phase-1-database-schema.md)
- [04 — Auth & Security](04-phase-1-auth-session-security.md)
