---
lang: en
---

# 11 - PostgreSQL Persistence Integration

> Version: v1.0 | Last Updated: 2026-07-15 | Status: Approved Design
> Dependencies: [03 - Business Logic & Persistence](03_Business_Logic_and_Persistence_Backend.md), [06 - Phase Roadmap](06_Phase_Roadmap.md)

---

## 1. Purpose

The current server has a complete Drizzle schema, generated migration, seed script, and PostgreSQL client. Runtime domain services still read and write the singleton `InMemoryStore` directly. This document defines the smallest safe path to make PostgreSQL the durable production backend while retaining an in-memory implementation for unit tests and explicit local development.

This is an incremental migration. It does not introduce a parallel, partially functional persistence path.

## 2. Decisions

| Decision | Rationale |
|---|---|
| PostgreSQL is mandatory in production. | Process-local Maps lose all state on restart and cannot support multiple server instances. |
| In-memory persistence remains available only for `development` and `test`. | It keeps unit tests fast and supports isolated local work without infrastructure. |
| Domain services depend on async, query-shaped persistence ports. | PostgreSQL is async; interfaces must represent useful domain queries rather than expose Map operations. |
| Migrate one vertical domain slice at a time. | A service, its routes, WebSocket callers, and tests move together. This limits behavioral risk and avoids a repo-wide flag day. |
| Implement a PostgreSQL adapter before selecting it at runtime. | Empty Drizzle stubs and a `PERSISTENCE=postgres` switch would create a configuration that boots but cannot serve traffic. |
| Transactions belong at service use-case boundaries. | A repository must not make cross-table operations partially durable. |
| PostgreSQL stores durable facts only. | Presence, rate limiting, bot delivery queues, and development file bytes have different lifecycle and scaling requirements. |

## 3. Current Gap

`apps/server/src/db/client.ts` exports a `pg.Pool` and Drizzle client, but runtime code does not query it. The following code paths access `InMemoryStore` directly:

- Domain services: auth, workspaces, messages, attachments, bots, and signal.
- HTTP routes: channel patching, reaction broadcasts, and development upload/download endpoints.
- WebSocket gateway and socket server: bot-response lookup, room bootstrap, and presence reference counts.

The schema also requires reconciliation before it can faithfully persist current behavior. In particular, the current runtime model contains channel `createdById`, `description`, and `deletedAt`; message reply and forward metadata; saved messages; read receipts; channel mutes; pinned messages; file `channelId`; and a read-state representation that the migration does not yet model completely.

## 4. Persistence Boundary

### 4.1 Shape

Each service receives only the persistence ports it needs. Ports use domain types and return promises for both implementations. They do not expose Drizzle tables, `pg.Pool`, Maps, or generic CRUD methods.

```text
HTTP routes / WebSocket gateway
              |
              v
        Domain service
              |
              v
       Persistence port
       /               \
In-memory adapter   PostgreSQL adapter
       |                    |
  InMemoryStore       Drizzle + PostgreSQL
```

The composition root creates services from adapters. It replaces module-level service singletons only as each service is migrated. Existing unmigrated services continue to use `store`; this minimizes changes during the transition.

```ts
type MessagePersistence = {
  getChannelForSend(channelId: string, actorId: string): Promise<Channel | undefined>;
  getMessage(id: string): Promise<Message | undefined>;
  findBySenderClientMessageId(senderId: string, clientMsgId: string): Promise<Message | undefined>;
  createMessage(input: NewMessage): Promise<Message>;
  listPage(input: MessagePageQuery): Promise<MessagePage>;
  updateMessage(input: MessageUpdate): Promise<Message>;
  transaction<T>(work: (tx: MessagePersistence) => Promise<T>): Promise<T>;
};
```

The example is intentionally query-shaped. `listPage`, `findBySenderClientMessageId`, and `getChannelForSend` map directly to indexed SQL queries. An interface such as `getAllMessages()` or `setMapValue()` would preserve the Map implementation rather than decouple the service from it.

### 4.2 Transaction Rules

The service owns a transaction when a use case changes more than one durable relation:

| Use case | Transaction contents |
|---|---|
| Register | create user, append registration audit record |
| Create workspace | workspace, owner membership, `general` channel, creator membership |
| Create DM | lookup/create deterministic DM and both memberships, protected by a uniqueness constraint |
| Send message | idempotency lookup/insert, attachment associations, durable audit/event record if introduced |
| Remove workspace member | membership deletion and related channel-membership deletions |
| Consume Signal prekey | select one unused key with row lock and mark it consumed |

The PostgreSQL Signal adapter must use a transaction with `FOR UPDATE SKIP LOCKED` for one-time prekey allocation. A read followed by an independent update is not safe under concurrent requests.

### 4.3 Non-Durable State

The following are deliberately outside PostgreSQL repository ports:

| State | Target owner |
|---|---|
| Online connection count and typing indicators | Redis / Socket.IO process state during the single-node phase; Redis for multi-instance deployment |
| WebSocket and auth rate-limit buckets | Redis |
| Bot pending-event queue | Redis Streams or BullMQ, not a JSON array on `BotIntegration` |
| Three-second read-receipt batching buffer | Redis or a process-local buffer whose flush persists through a message/read-state port |
| Development upload bytes | Development-only `Map`; production uses object storage |
| Metrics and transient WebSocket events | Observability and transport layers |

These concerns must not be hidden in a `PresenceRepository`, `DevFileRepository`, or a generic repository aggregate. They are operational state, not relational domain records.

## 5. Schema Reconciliation

Before implementing any PostgreSQL adapter, update `apps/server/src/db/schema.ts`, generate a new migration, and validate a clean database. The existing `0000` migration is a baseline, not proof that all current runtime features are persistable.

Required reconciliation items:

| Current behavior | Required relational representation |
|---|---|
| Channel creator, description, soft deletion | Add `created_by_id`, `description`, and `deleted_at` to `channels`. |
| Reply and forward metadata | Add `reply_to_message_id`, `original_sender_id`, and `original_created_at` to `messages` as required by the shared `Message` type. |
| Saved messages | Add `saved_messages` with composite key `(user_id, message_id)`. |
| Read receipts and unread state | Add `message_read_receipts`; represent per-channel last-read state on `channel_members` with a timestamp or a cursor that matches the API semantics. Do not maintain a separate in-memory-only `channelLastRead` source of truth. |
| Pins | Add `channel_pins` with a channel/message composite key and enforce the 50-pin limit transactionally. |
| Channel mute preference | Add `channel_mutes` with `(user_id, channel_id)` composite key. |
| File channel association | Add nullable `channel_id` to `files`, matching `FileRecord`. |
| Bot delivery | Keep bot integration, membership, and subscription records in PostgreSQL; move pending event delivery to Redis Streams/BullMQ. |

The implementation must also define explicit mappers between PostgreSQL `Date` values and the ISO strings used by shared domain contracts. No Drizzle row type may leak from an adapter into a domain service.

## 6. Runtime Configuration and Lifecycle

### 6.1 Configuration

Add `PERSISTENCE=memory|postgres` and validate it with the existing Zod environment schema.

- `development` and `test`: default to `memory` when `PERSISTENCE` is absent.
- `production`: require `PERSISTENCE=postgres`; reject `memory` during environment validation.
- Docker Compose production-like configuration sets `PERSISTENCE=postgres`, `DATABASE_URL=postgres://...@postgres:5432/nexus_chat`, and waits for PostgreSQL health.
- `SESSION_STORE=redis` is independently selected. Persistence selection must not silently change session storage.

`DATABASE_URL` must be required when PostgreSQL is selected. There is no automatic fallback to memory when the database is unavailable.

### 6.2 Client Lifecycle

The database module owns a lazily created `pg.Pool`, Drizzle instance, and their lifecycle:

1. The composition root initializes PostgreSQL only when `PERSISTENCE=postgres`.
2. Before accepting traffic, it runs a `SELECT 1` readiness check.
3. Migrations run in CI/CD or an explicit one-shot migration job, not by default in every application process.
4. A local-only `DB_MIGRATE_ON_BOOT=true` may be supported, but production boot-time migration remains disabled.
5. `SIGTERM` and `SIGINT` stop the HTTP server first, then close the pool.

`/healthz` should report process liveness. Add `/readyz` for dependency readiness: it reports failure when the configured PostgreSQL or Redis dependency is unavailable.

## 7. Migration Sequence

Each numbered step is independently buildable, testable, and deployable. Do not add unused repository files or Drizzle placeholders ahead of the slice that uses them.

### Step 0: Infrastructure and Schema Parity

- Enable PostgreSQL and Redis services in `docker-compose.yml`, with named PostgreSQL volume and health checks.
- Add explicit migration and seed commands to local/CI workflows.
- Reconcile the schema in Section 5, generate a new Drizzle migration, and test migration from an empty database.
- Add database readiness and graceful pool shutdown.

This step does not add `PERSISTENCE=postgres` to live service selection.

### Step 1: Auth Vertical Slice

- Define `UserPersistence` and `AuditPersistence` ports required by auth only.
- Implement and test the in-memory adapters against `InMemoryStore`.
- Implement and integration-test PostgreSQL adapters against a disposable PostgreSQL database.
- Convert `authService` public methods to async where needed; update only auth routes and affected auth middleware callers.
- Select the adapter in a composition root and make production use PostgreSQL.

### Step 2: Workspace and Channel Vertical Slice

- Define ports for workspace/member/channel access and mutations.
- Move workspace creation, ownership transfer, membership changes, channel lifecycle, deterministic DM creation, mutes, and channel updates behind those ports.
- Use transactions for workspace creation, DM creation, and member removal.
- Update room bootstrap to query service-level workspace/channel access rather than iterate `store`.

### Step 3: Message Vertical Slice

- Define query-shaped message, reaction, saved-message, attachment-reference, pin, and read-state ports.
- Move idempotency to the PostgreSQL unique `(sender_id, client_msg_id)` constraint. On conflict, fetch and return the existing message.
- Implement cursor pagination with an ordering and cursor format matching the shared API contract.
- Update HTTP message routes and the WebSocket gateway to await the message service.
- Keep short-lived receipt batching outside the durable adapter, then flush through a transactional persistence method.

### Step 4: Attachments, Signal, and Bots

- Attachments: persist metadata and upload sessions in PostgreSQL; leave byte storage in the development Map until object storage is introduced.
- Signal: implement transactional one-time-prekey allocation and persistent opaque session metadata.
- Bots: persist installation, membership, and subscriptions; replace `pendingEvents` with the selected queue mechanism before multi-instance deployment.

### Step 5: Remove Direct Store Access

- Replace remaining direct `store` imports in routes and WebSocket code with migrated services or explicitly transient infrastructure.
- Restrict `InMemoryStore` imports to in-memory adapters and test utilities.
- Make `PERSISTENCE=memory` an intentional development/test mode only.

## 8. Testing Strategy

| Test level | Backend | Purpose |
|---|---|---|
| Unit | In-memory adapters | Fast service rules and failure paths without infrastructure. |
| Adapter integration | Disposable PostgreSQL | Validate SQL, mapping, constraints, transactions, and migrations. |
| Route/WebSocket integration | PostgreSQL plus Redis where required | Validate async propagation, authorization, idempotency, and broadcasts. |
| Migration smoke | Empty PostgreSQL database | Apply all migrations and run seed data. |

Repository interfaces are tested by service behavior, not by asserting internal Map side effects. PostgreSQL adapter tests must include duplicate message delivery, concurrent DM creation, workspace creation rollback, and concurrent one-time-prekey consumption.

## 9. Non-Goals

- Do not create generic CRUD repositories, a global repository registry, or adapter skeletons that throw at runtime.
- Do not migrate Redis-owned operational state into PostgreSQL.
- Do not run production migrations automatically on every server replica.
- Do not change domain behavior merely to make it resemble the current Maps; correct persistence semantics where the relational schema and production requirements demand it.
- Do not remove the in-memory adapter until PostgreSQL-backed service and adapter integration coverage exists.

## 10. Acceptance Criteria

1. Production startup fails before serving traffic if PostgreSQL is not configured or unavailable.
2. Development and test modes can explicitly use in-memory persistence without creating a database pool.
3. Each migrated vertical slice has a complete in-memory adapter, PostgreSQL adapter, service wiring, and PostgreSQL integration tests.
4. No production-configured request path reads durable data from `InMemoryStore`.
5. Schema migrations represent every migrated runtime field and constraint.
6. Multi-row mutations and one-time prekey consumption are atomic.
7. `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass after every slice.

---

## Appendix: Corrections to the Previous Foundation Proposal

The previous proposal was corrected as follows:

- It no longer creates all repositories and nonfunctional Drizzle implementations before services use them.
- It does not expose Map-shaped methods such as `getAllMessages()` as the intended PostgreSQL boundary.
- It removes presence, development file bytes, and bot pending-event arrays from PostgreSQL repository scope.
- It requires schema parity before PostgreSQL selection instead of assuming the existing migration covers all runtime behavior.
- It requires PostgreSQL in production rather than leaving `PERSISTENCE=memory` as the production default.
- It moves migrations to a deployment job by default and adds readiness separately from liveness.
