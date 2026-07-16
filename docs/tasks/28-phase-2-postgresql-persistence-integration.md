---
lang: en
phase: 2
status: planned
---

# 28 - Phase 2 - PostgreSQL Persistence Integration

## Goal

Replace the server's runtime-only `InMemoryStore` as the production source of truth with PostgreSQL through Drizzle ORM, while retaining an in-memory persistence implementation for explicit development and unit-test use.

The migration must be incremental, transaction-safe, and complete per domain slice. A production configuration must never silently fall back to in-memory persistence.

## Current State

`apps/server/src/db/schema.ts`, the initial Drizzle migration, `db/client.ts`, and a seed script already exist. Runtime auth, workspace, channel, message, attachment, bot, and Signal services still mutate the singleton `InMemoryStore` directly.

The existing schema also does not yet represent all runtime state. Before an adapter is selected in production, migrations must cover channel creator/description/soft-delete data, message reply and forward metadata, saves, read receipts, pins, mutes, and file channel associations.

## Scope

### 28.1 PostgreSQL Runtime Infrastructure

- Enable PostgreSQL and Redis services, health checks, and persistent PostgreSQL volume in `docker-compose.yml`.
- Add `PERSISTENCE=memory|postgres` to `apps/server/src/config/env.ts`.
- Default to `memory` only in development and test.
- Reject `PERSISTENCE=memory` when `NODE_ENV=production`.
- Initialize the `pg.Pool` lazily only when PostgreSQL persistence is selected.
- Add database liveness/readiness helpers and close the pool after graceful HTTP server shutdown.
- Keep migration execution as a CI/CD or explicit one-shot operation. `DB_MIGRATE_ON_BOOT=true` may support local development only.
- Add `/readyz` for configured PostgreSQL and Redis dependency readiness; retain `/healthz` for process liveness.

### 28.2 Schema Parity and Migration Validation

- Reconcile `apps/server/src/db/schema.ts` with active shared-domain contracts before implementing adapters.
- Add a new generated Drizzle migration rather than modifying the existing baseline migration.
- Persist channel `createdById`, `description`, and `deletedAt`.
- Persist message `replyToMessageId`, `originalSenderId`, and `originalCreatedAt`.
- Add relational records for saved messages, message read receipts, channel pins, and per-user channel mutes.
- Add a file `channelId` representation matching `FileRecord`.
- Define one durable per-channel read-state representation. It must match the public API semantics and replace `channelLastRead` as a production-only source of truth.
- Add explicit row-to-domain mappers. PostgreSQL `Date` values must become the ISO strings used in shared contracts; Drizzle row types must not escape persistence adapters.

### 28.3 Persistence Ports and Composition Root

- Introduce async, query-shaped persistence ports only when migrating their consuming service.
- Give each migrated service its required ports through a factory/composition root; do not import `db`, Drizzle tables, or `store` directly from service code.
- Implement both in-memory and PostgreSQL adapters before selecting the PostgreSQL adapter for that service.
- Keep interfaces domain-specific. For example, message persistence exposes `listPage`, idempotent message lookup, and transactional message creation rather than generic Map-style getters/setters.
- Put transaction boundaries around complete service use cases, not individual repository calls.
- Do not create generic CRUD repositories, a global repository registry, or placeholder PostgreSQL adapters that throw at runtime.

### 28.4 Vertical Migration Sequence

1. **Auth**
   - Migrate users and audit records.
   - Retain the existing refresh-session memory/Redis abstraction; persistence selection must not implicitly change it.
   - Update auth routes and callers to await the migrated service.

2. **Workspace and Channel**
   - Migrate workspaces, memberships, channels, channel memberships, channel updates, mutes, and deterministic DMs.
   - Make workspace creation, DM creation, and member removal transactional.
   - Replace WebSocket room bootstrap scans over `store` with service-level access queries.

3. **Messages**
   - Migrate messages, idempotency, reply/forward metadata, reactions, saved messages, pins, read state, receipts, and attachment associations.
   - Use the database unique `(sender_id, client_msg_id)` constraint for idempotency; on conflict, return the existing message.
   - Preserve cursor pagination ordering and API behavior.
   - Update REST and WebSocket paths to await the message service.

4. **Attachments, Signal, and Bots**
   - Persist attachment metadata and upload-session lifecycle; retain the development-only byte `Map` until object storage is introduced.
   - Migrate Signal bundles, one-time prekeys, and opaque session metadata. Consume one-time prekeys in a transaction with `FOR UPDATE SKIP LOCKED`.
   - Migrate bot installation, memberships, and subscriptions. Move bot pending-event delivery from the in-memory array to Redis Streams or BullMQ before multi-instance deployment.

5. **Store Removal From Production Paths**
   - Restrict `InMemoryStore` imports to in-memory adapters, test utilities, and explicitly development-only file byte handling.
   - Verify every production durable-data path uses PostgreSQL.

### 28.5 Operational State Boundaries

The following must not be represented by PostgreSQL repository ports:

- Online connection counts and typing indicators: process-local state for the single-node phase, then Redis.
- Authentication and WebSocket rate-limit buckets: Redis.
- Bot pending-event delivery: Redis Streams or BullMQ.
- Short-lived read-receipt batching buffer: Redis or process-local buffer flushed through durable message/read-state persistence.
- Development upload/download file bytes: development-only Map; production file bytes belong in object storage.

## Non-Goals

- No database-per-service split.
- No Redis cache, Socket.IO adapter, BullMQ, or object-storage productionization beyond the boundaries required for durable persistence.
- No production migration executed automatically by every application replica.
- No removal of in-memory adapters before equivalent PostgreSQL adapter integration coverage exists.
- No changes to E2EE cryptographic operations or encrypted payload semantics.
- No generic data-access layer that obscures authorization and domain invariants.

## Files Expected to Change

| Area | Primary paths |
|---|---|
| Environment and lifecycle | `apps/server/src/config/env.ts`, `apps/server/src/db/client.ts`, `apps/server/src/index.ts`, `.env.example` |
| Schema and migrations | `apps/server/src/db/schema.ts`, `apps/server/drizzle/` |
| Service migration slices | `apps/server/src/domain/auth/`, `workspaces/`, `messages/`, `attachments/`, `signal/`, `bots/` |
| Persistence adapters | New files colocated with each migrated domain or under `apps/server/src/domain/persistence/` |
| HTTP and WebSocket async propagation | `apps/server/src/http/routes.ts`, `apps/server/src/ws/gateway.ts`, `apps/server/src/ws/socket.ts` |
| Local infrastructure | `docker-compose.yml`, server package scripts |
| Tests | Service unit tests plus PostgreSQL adapter/route integration tests |

## Acceptance Criteria

- [ ] `NODE_ENV=production` rejects `PERSISTENCE=memory` during startup configuration validation.
- [ ] `PERSISTENCE=memory` does not instantiate a PostgreSQL pool.
- [ ] `PERSISTENCE=postgres` fails readiness before serving traffic when PostgreSQL is unreachable.
- [ ] Docker Compose starts PostgreSQL and Redis with passing health checks and a persistent PostgreSQL volume.
- [ ] A clean PostgreSQL database applies all generated migrations and accepts the seed script.
- [ ] Schema migrations contain every field and relation used by each migrated production service slice.
- [ ] Every migrated service has complete in-memory and PostgreSQL adapters; there are no selected PostgreSQL stubs.
- [ ] Workspace creation, deterministic DM creation, member removal, message creation with attachment associations, and Signal one-time-prekey consumption are atomic.
- [ ] Duplicate concurrent message sends with the same `(senderId, clientMsgId)` return one durable message.
- [ ] Concurrent Signal bundle fetches cannot consume the same one-time prekey.
- [ ] No production-configured durable-data route, gateway path, or socket bootstrap path reads from `InMemoryStore`.
- [ ] Existing unit tests run with in-memory persistence; PostgreSQL adapter and route integration tests run against disposable PostgreSQL.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

## Test Plan

- Run migrations and seed data against an empty disposable PostgreSQL instance.
- Verify environment validation for development/test memory mode and production PostgreSQL-only mode.
- Test each persistence adapter's domain mapping, constraints, and transaction behavior.
- Test duplicate message sends, concurrent DM creation, workspace creation rollback, and concurrent one-time-prekey consumption.
- Exercise migrated REST and WebSocket paths against PostgreSQL; verify broadcasts retain their current payloads.
- Retain fast in-memory service unit tests for rules and edge cases.

## Dependencies

- [03 - Database Schema, Migrations & Persistence Boundary](03-phase-1-database-schema.md)
- [04 - Authentication, Sessions & Security Baseline](04-phase-1-auth-session-security.md)
- [05 - Core Gateway](05-phase-1-core-gateway.md)
- [06 - Workspace, Channel, DM & Membership Services](06-phase-1-workspace-channel-service.md)
- [07 - Message Service, State Machine & Core IM Actions](07-phase-1-message-service.md)
- [08 - Attachment Service Foundation](08-phase-1-attachment-service-foundation.md)
- [09 - Signal DM E2EE](09-phase-1-signal-dm-e2ee.md)
- [10 - Bot Engine Core](10-phase-1-bot-engine-core.md)

## Design Reference

- [11 - PostgreSQL Persistence Integration](../design/11_PostgreSQL_Persistence_Integration.md)
