---
lang: en
phase: 1
status: draft
---

# 03 — Phase 1 — Database Schema, Migrations & Persistence Boundary

## Goal

Implement the Phase 1 PostgreSQL schema with Drizzle ORM while preserving strict boundaries between core IM data, attachment lifecycle, bot infrastructure, and bot-owned feature data.

## Scope

- Add Drizzle ORM to `apps/server`.
- Create migration pipeline.
- Implement core tables.
- Implement attachment tables.
- Implement bot installation/subscription tables.
- Implement Signal key tables.
- Implement audit log table.
- Add seed data for local development.

## Non-Goals

- No poll/reminder/kudos/todo tables.
- No AI embedding tables in Phase 1.
- No database-per-service.
- No Elasticsearch or vector database.

## Core Tables

| Table | Owner | Purpose |
|-------|-------|---------|
| `users` | Core Auth | User identity |
| `workspaces` | Core Workspace | Tenant/workspace root |
| `workspace_members` | Core Workspace | Workspace RBAC |
| `channels` | Core Channel | Public/private/DM channels, normal/e2e mode |
| `channel_members` | Core Channel | Membership and read cursor |
| `messages` | Core Message | Message records and render payloads |
| `message_reactions` | Core Message | Emoji reactions |
| `files` | Core Attachment | File metadata, scan state, object key, retention |
| `upload_sessions` | Core Attachment | Presigned upload session lifecycle |
| `message_attachments` | Core Attachment | Message-to-file association |
| `bot_integrations` | Core Bot Infra | Bot identity, token hash, scopes |
| `bot_channel_memberships` | Core Bot Infra | Which bots are installed in which channels |
| `bot_event_subscriptions` | Core Bot Infra | Which events each bot receives |
| `signal_prekey_bundles` | Core Signal | Public identity key + signed prekey metadata |
| `signal_one_time_prekeys` | Core Signal | One-time prekeys |
| `signal_sessions` | Core Signal | Reserved for later multi-device relay |
| `audit_logs` | Core Audit | Append-only critical operation log |

## Boundary Rules

- Core schema must not contain product workflow tables such as `polls`, `reminders`, `kudos`, `todos`, or `standups`.
- Bots store workflow state through bot-owned tables or scoped KV storage.
- Core Attachment Service owns file lifecycle and security state.
- `@FileBot` may store workflow settings and file ID references, but not object keys or scan authority.

## Important Constraints

- Use UUID v7 or a monotonic ID strategy for messages.
- `clientMsgId` must be unique per sender, not globally.
- `senderId` and `createdBy` should use `onDelete: restrict` if not nullable.
- E2E messages store ciphertext only.
- E2E files store opaque encrypted blobs only.

## Index Requirements

| Use Case | Index |
|----------|-------|
| Channel pagination | `(channel_id, id DESC)` |
| Idempotent send | `(sender_id, client_msg_id)` unique |
| User channel list | `(user_id, joined_at)` |
| Workspace channel names | `(workspace_id, name)` unique where applicable |
| Bot channel lookup | `(channel_id)` on `bot_channel_memberships` |
| File workspace listing | `(workspace_id, created_at)` |
| File scan queue | `(scan_status)` |
| Upload session cleanup | `(status, expires_at)` |

## Migration Commands

```bash
pnpm --filter @nexus-chat/server db:generate
pnpm --filter @nexus-chat/server db:migrate
pnpm --filter @nexus-chat/server db:studio
```

## Acceptance Criteria

- Fresh database migrates from empty state.
- `drizzle-kit` can generate and apply migrations.
- Seed script creates one workspace, two users, one normal channel, one DM.
- No workflow-specific bot tables exist in core migrations.
- Attachment tables exist and are not owned by FileBot.
- Bot membership/subscription tables exist.

## Test Plan

- Migration up from empty DB.
- Migration rollback in local environment if supported.
- Insert seed data.
- Verify channel pagination query uses index.
- Verify duplicate `(sender_id, client_msg_id)` is rejected.
- Verify bot cannot be inserted into an E2E channel if a DB check or service invariant is in place.

## Dependencies

- [01 — Project Scaffold](01-phase-1-project-scaffold.md)
- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
