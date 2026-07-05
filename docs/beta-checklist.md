# Closed Beta Checklist

> Updated: 2026-07-05

## Auth Flow

- [x] Email/password registration with Argon2id hashing
- [x] Login returns JWT access + refresh tokens (RS256)
- [x] Token refresh endpoint reissues valid tokens
- [x] Invalid/expired tokens rejected with 401
- [x] Rate limiting on auth endpoints (10 requests / 15 min per IP)
- [x] Sessions persisted in Redis (production) or memory (development)

## Normal Channels

- [x] Workspace creation with owner/member roles
- [x] Public and private channels with membership management
- [x] Channel creation, rename, archive
- [x] Text message delivery with state machine (Draft → Sent → Delivered → Read)
- [x] Message pagination (cursor-based)
- [x] Emoji reactions on messages
- [x] Markdown rendering in messages

## Direct Messages

- [x] DM channels created between two users
- [x] DM message delivery and pagination
- [x] DM channels marked as private by default

## E2E Encrypted DMs

- [x] Signal Protocol X3DH key exchange for 1:1 DMs
- [x] Double Ratchet forward secrecy
- [x] PreKeyBundle upload and retrieval flow
- [x] Server stores ciphertext only (no plaintext access)
- [x] Bots excluded from E2E channels
- [x] Slash commands rejected in E2E channels
- [x] Read-once / disappearing message policy support

## Bot Commands

- [x] Bot registration with opaque tokens
- [x] Slash command routing in normal channels
- [x] Redis Streams event bus for bot dispatch
- [x] BullMQ task queues with per-bot isolation
- [x] Bundled bots: Welcome, Help, Notification

## TUI Smoke Commands

- [x] Login/logout via TUI
- [x] Workspace list and select
- [x] Channel list and select
- [x] Send and read messages
- [x] E2E DM message send and verify
- [x] Slash command invocation

## Logs and Audit Events

- [x] Structured Pino JSON logs with log levels
- [x] Audit event recording for auth, channel, message operations
- [x] Audit events include actor, action, resource, timestamp
- [x] Prometheus metrics endpoint for monitoring

## Backup / Restore

- [x] Backup/restore procedure documented (see [backup-restore.md](backup-restore.md))
- [x] PostgreSQL pg_dump / pg_restore recipe
- [x] Redis RDB snapshot backup
- [x] File storage backup outline (future)

## Known Limitations

- [x] Known limitations documented (see [known-limitations.md](known-limitations.md))
- [x] Single-device E2EE only
- [x] In-memory stores for development
- [x] No Redis WebSocket adapter in dev
- [x] No full-text search
- [x] No file upload in UI
- [x] Electron limitations noted
- [x] TUI limitations noted
- [x] AGPL-3.0 concern for @signalapp/libsignal-client noted
