---
lang: en
---

# 12 - Phase 2 Scale-Out Architecture

> Version: v1.0 | Last Updated: 2026-07-17 | Status: Proposed
> Dependencies: [02 - Long Connection & Core Gateway](02_Long_Connection_and_Core_Gateway_Layer.md), [03 - Business Logic & Persistence](03_Business_Logic_and_Persistence_Backend.md), [06 - Phase Roadmap](06_Phase_Roadmap.md), [11 - PostgreSQL Persistence Integration](11_PostgreSQL_Persistence_Integration.md)

---

## 1. Purpose

This document defines the recommended scale-out path for Nexus Chat after PostgreSQL persistence has been completed. The Phase 2 architecture is a **scalable modular monolith**, not a premature microservice system: multiple identical gateway instances share PostgreSQL and Redis, while specialized workers are introduced only where work must be durable or isolated.

The goal is to establish a measured path from a single production instance to a multi-instance, single-region deployment for mixed normal channels, direct messages, and 1:1 E2EE traffic. It does not claim a connection-count target before representative load tests establish one.

## 2. Current State

| Area                    | Current implementation                               | Scale-out implication                                           |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| Durable state           | PostgreSQL through async Drizzle adapters            | Suitable production source of truth                             |
| Sessions                | Optional Redis refresh-session store                 | Set `SESSION_STORE=redis` for multiple gateway instances        |
| Socket.IO rooms         | Optional Redis adapter via `SOCKET_IO_ADAPTER=redis` | Cross-instance room broadcasts work                             |
| Presence                | Process-local connection counter                     | Incorrect when one user connects to more than one instance      |
| WebSocket rate limiting | Process-local Map                                    | Limit can be bypassed by switching instances                    |
| Bot event queue         | Process-local pending queue and polling              | Events are not durable or shareable across instances            |
| Attachments             | Development bytes are process-local                  | Not suitable for scaled production deployment                   |
| Message delivery        | Persist, then broadcast through Socket.IO            | Reconnect/history repair exists, but no durable delivery outbox |

The Redis Socket.IO adapter is a relay primitive, not a complete cluster architecture. Redis Pub/Sub distributes live room events but does not make presence, limits, queues, files, or database capacity scalable by itself.

## 3. Architectural Decision

### 3.1 Phase 2: Scalable Modular Monolith

Phase 2 keeps one codebase and PostgreSQL schema while running distinct deployment roles. This minimizes distributed-system coordination while removing the process-local state that prevents horizontal relay scaling.

```text
                          Internet
                             |
                    TLS / WebSocket-aware LB
                             |
              +--------------+--------------+
              |                             |
       Gateway pod x N                 Gateway pod x N
       Hono + Socket.IO                Hono + Socket.IO
       stateless request path          stateless request path
              |                             |
              +---------- Redis -----------+
              | sessions | presence | limits |
              | Socket.IO Pub/Sub | queues   |
              +--------------+--------------+
                             |
                  PostgreSQL primary
                   via PgBouncer pool
                             |
          Object storage and CDN for attachment bytes

              Durable worker pod x N
              bot delivery / outbox / file processing
```

Gateway pods may initially continue to serve REST and WebSocket traffic together. Bot delivery, outbox processing, and file processing must run as explicit worker roles once they become durable asynchronous workloads. A deployment role changes process startup and scheduling, not the domain ownership or database model.

### 3.2 Why Not Microservices in Phase 2

The current application is still evolving its message, attachment, bot, and E2EE boundaries. Splitting services before their contracts and operational limits are validated would add cross-service transactions, versioning, tracing, and deployment overhead without increasing useful capacity.

Phase 2 therefore optimizes for:

- Stateless gateway replicas with shared operational state.
- PostgreSQL as the authoritative durable store.
- Redis for short-lived state, coordination, and live fan-out.
- Object storage for attachment bytes.
- Durable workers for retries and slow work.

## 4. Traffic Model and Routing

### 4.1 Normal Channels

Normal channels have the highest fan-out cost. A single message can target hundreds or thousands of sockets, so the gateway must avoid coupling channel broadcast cost to a database transaction or a slow client.

```text
client -> gateway -> validate/authorize -> PostgreSQL commit
                                      -> durable outbox record
                                      -> Socket.IO channel room broadcast
```

The database commit is authoritative. Socket.IO Pub/Sub is best-effort live delivery; reconnecting clients repair missed data through cursor-based history APIs and `clientMsgId` idempotency.

Gateway instances should join users to `user:{id}` and `workspace:{id}` rooms at connection time. Channel rooms should be joined only for active or explicitly subscribed channels, rather than every channel the user belongs to. Membership changes must add or remove room subscriptions promptly.

### 4.2 Direct Messages

DM delivery uses `user:{id}` rooms. Its fan-out is usually one recipient across one or more devices, so it is substantially cheaper than a large normal channel. Deterministic DM creation and message idempotency remain PostgreSQL use cases; live delivery remains best-effort and is repaired from durable history after reconnect.

### 4.3 E2EE DMs and P2P Signaling

For 1:1 E2EE DMs, the gateway treats ciphertext as opaque payload data. It validates the envelope size and routing authorization but does not decrypt, index content, invoke bots, or build server-side search indexes. The same `user:{id}` relay model carries E2EE ciphertext and P2P signaling.

Signal prekey allocation and session metadata remain PostgreSQL transactions. E2EE does not remove relay bandwidth costs, but server-side encryption CPU is not in the message delivery path. Group E2EE and multi-device Signal sessions are Phase 3 concerns unless their product work is independently prioritized.

## 5. Phase 2 Required Changes

### 5.1 Shared Operational State

| Concern               | Phase 2 implementation                               | Required property                                                   |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| Refresh sessions      | `RedisRefreshSessionStore`                           | Shared token revocation and rotation state                          |
| Socket.IO broadcast   | `@socket.io/redis-adapter`                           | Cross-instance room delivery                                        |
| Presence              | Redis connection IDs or atomic counters with TTL     | A user is offline only after the final connection expires or closes |
| Typing state          | Redis ephemeral key with TTL plus room event         | Lost events are acceptable; stale typing must expire                |
| WebSocket rate limit  | Redis Lua token bucket or sliding window             | Limits apply across all gateway pods                                |
| Read-receipt batching | Redis buffered state or direct durable cursor update | No per-process pending batch state                                  |
| Bot delivery          | Redis Streams or BullMQ with idempotent consumers    | Durable retries and independent worker scaling                      |

Redis keys must be namespaced by domain and workspace where applicable. Every ephemeral key needs a bounded TTL. Redis must never become the sole owner of messages, channel membership, E2EE session metadata, or attachment metadata.

### 5.2 Gateway Lifecycle and Deployment

1. Run a WebSocket-aware load balancer with TLS termination, upgrade support, request-size limits, and client IP forwarding.
2. Keep WebSocket-only transport. A live socket remains on the gateway that accepted it; cookie affinity is not required for long-polling because long-polling is disabled.
3. Add readiness-aware draining. On termination, mark the pod unready, stop accepting new connections, allow a bounded drain period, then close Socket.IO, Redis clients, and PostgreSQL pools.
4. Autoscale gateways from active connection count, event-loop lag, CPU, memory, and outbound event rate. CPU alone is not a sufficient signal for mostly idle persistent sockets.
5. Apply pod-disruption budgets and topology spread so a node drain does not remove all relays in one failure domain.
6. Expose per-pod connection limits and reject or shed new connections before memory exhaustion.

### 5.3 Durable Event Delivery

The Phase 2 message write path must add a transactional outbox before bot integrations, file processing, or external webhooks become production-critical.

1. Write the message and its outbox event in one PostgreSQL transaction.
2. Publish the live Socket.IO event after commit for low latency.
3. Let an outbox worker retry durable consumers such as bot delivery, webhook delivery, notifications, and file processing.
4. Make consumers idempotent using an event ID and domain entity ID.
5. Retain failed events with a dead-letter and operator replay path.

The outbox is not needed to replay every live Socket.IO room event. It protects durable downstream work and ensures that a gateway crash after commit does not silently omit bot or notification processing.

### 5.4 Data and Attachment Topology

| Component         | Phase 2 recommendation                                                                                       | Do not do yet                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| PostgreSQL writes | Primary database with explicit pool limits through PgBouncer                                                 | Independent databases per domain                         |
| PostgreSQL reads  | Primary first; add read replicas only after history/search measurements justify them                         | Route authorization-sensitive writes to replicas         |
| Messages          | Keep cursor pagination; benchmark indexes and consider time/workspace partitions when table size requires it | Offset pagination or unbounded history reads             |
| Redis             | Primary/replica plus Sentinel or managed equivalent; measure before choosing Redis Cluster                   | Treat Pub/Sub as durable messaging                       |
| Attachments       | S3/R2/MinIO direct upload/download using signed URLs, metadata in PostgreSQL, CDN for downloads              | Store bytes in gateway process memory or PostgreSQL rows |

### 5.5 Channel Fan-Out Protection

1. Establish channel-size and event-size limits before opening public large channels.
2. Track outbound queue depth and disconnect persistently slow clients rather than retaining unbounded buffers.
3. Emit compact event envelopes; clients fetch large content or history through cursor APIs when necessary.
4. Batch high-frequency ephemeral events such as typing and streaming chunks.
5. Measure large-channel fan-out separately from DM throughput; they consume different resources.

## 6. Phase 2 Capacity Validation

Capacity is a test result, not an architectural promise. Before claiming a concurrency number, the deployment must pass representative load tests in an environment with production-equivalent Redis, PostgreSQL, load balancer, TLS, and pod resources.

### 6.1 Initial Validation Profiles

| Profile         | Workload                                                                    | What it validates                                                     |
| --------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Idle connection | Persistent authenticated sockets with heartbeats and reconnect churn        | File descriptors, memory per socket, load balancer and drain behavior |
| DM-heavy        | Low fan-out normal and E2EE DM sends across gateway pods                    | User-room routing, PostgreSQL writes, ciphertext envelope handling    |
| Channel-heavy   | Active normal channels with realistic membership and burst sends            | Redis Pub/Sub, room fan-out, client backpressure                      |
| Mixed           | Normal channels, DMs, E2EE, typing, read cursors, bots, and history fetches | Resource contention and SLO trade-offs                                |
| Failure         | Gateway termination, Redis failover, PostgreSQL failover, worker retry      | Recovery, no duplicate durable work, reconnect repair                 |

The first target should be a deliberately conservative, measured multi-pod baseline such as 10,000 persistent connections. It can be raised only after the mixed profile meets defined SLOs for connection success, end-to-end message latency, database write latency, reconnect recovery, and error rate. A channel fan-out target must be tested independently because it can become the bottleneck long before total connection count does.

### 6.2 Required Telemetry

| Layer      | Metrics                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Gateway    | Active sockets, connection attempts, disconnect causes, room broadcast count, bytes in/out, slow-client disconnects, event-loop lag |
| Redis      | Pub/Sub throughput and latency, command latency, memory, evictions, connection count, failovers                                     |
| PostgreSQL | Pool wait time, active connections, transaction latency, lock waits, replication lag, slow queries, outbox backlog                  |
| Workers    | Queue depth, retry rate, event age, dead-letter count, handler duration                                                             |
| Product    | Send-to-receive p50/p95/p99, reconnect repair success, duplicate suppression, presence correctness                                  |

Prometheus metrics and structured logs are Phase 2 minimums. Distributed traces become mandatory when the outbox and separate worker roles are introduced.

## 7. Phase 2 Delivery Gates

| Gate         | Exit criteria                                                                                         |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| Shared state | Presence and WebSocket limits remain correct when the same user uses two gateway pods                 |
| Relay        | A normal channel, DM, and E2EE ciphertext event all reach sockets connected to different gateway pods |
| Recovery     | Gateway drain and restart do not lose durable messages; clients repair missed events from history     |
| Async work   | Bot and webhook processing is durable, idempotent, observable, and replayable                         |
| Files        | Production attachments use object storage; no process-memory file bytes are required                  |
| Capacity     | Mixed-load benchmark reaches the approved target while all SLOs hold                                  |
| Operations   | Dashboards, alerts, runbooks, backup/restore exercise, and failure drill are complete                 |

## 8. Phase 3 Scale Vision

Phase 3 begins only after Phase 2 measurements show that independently scaling gateway, message delivery, bots, or files produces clear operational benefit. Service extraction follows validated ownership boundaries, not a fixed calendar deadline.

```text
                   Global / regional edge
                            |
                   Relay Gateway x N
             stateless Socket.IO connection tier
                            |
                    NATS JetStream
              durable domain event transport
          +----------+----------+----------+
          |                     |          |
   Message Service        Bot Service   File Service
   command/query          workers       object lifecycle
          |                     |          |
    PostgreSQL domain    PostgreSQL     object storage
       ownership          ownership       + metadata
```

### 8.1 Target Boundaries

| Service          | Owns                                                                            | Does not own                                            |
| ---------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Relay Gateway    | Socket lifecycle, authentication verification, connection routing, backpressure | Durable message writes, bot execution, file bytes       |
| Message Service  | Message commands, history query, read state, channel fan-out event production   | Socket connection ownership                             |
| Bot Service      | Subscription dispatch, retries, bot execution sandboxing, webhook delivery      | Core message lifecycle                                  |
| File Service     | Upload sessions, malware scanning, object lifecycle, signed URLs, retention     | Chat authorization decisions outside file access checks |
| Identity Service | Enterprise SSO, SCIM, session and device lifecycle                              | Channel/message policy                                  |

Each extraction requires a stable API, an independently operable data store, ownership of migrations, SLOs, tracing, and a rollback plan. A shared database is acceptable during a transition only when write ownership is explicit; database-per-service is the end state, not a prerequisite for the first extraction.

### 8.2 Event and Regional Architecture

1. Replace Redis Streams for cross-service durable events with NATS JetStream after service extraction requires subject-based routing, retention, replay, and independent consumer groups.
2. Keep Redis for cache, presence, rate limiting, and local coordination; do not turn it into the source of truth for business events.
3. Use gRPC or HTTP for bounded synchronous commands and JetStream for asynchronous domain events.
4. Introduce multi-region by assigning workspaces a home region and keeping writes regional first. Do not begin with globally synchronous PostgreSQL writes.
5. Replicate only the data needed for cross-region delivery, with explicit consistency and residency rules.
6. Adopt OpenTelemetry traces, SLO-based alerts, and per-service error budgets before operating multiple independent services.

### 8.3 E2EE at Phase 3 Scale

Advanced E2EE remains a separate distribution and security track. Multi-device sessions, group Sender Key rotation, safety-number verification, and the Signal Protocol branch must preserve the rule that relays route opaque encrypted envelopes and never become plaintext processors. Key distribution workloads should be isolated from normal channel fan-out and audited independently.

## 9. Non-Goals

- Claiming a fixed concurrent-connection capacity without load-test evidence.
- Introducing Kubernetes, Redis Cluster, read replicas, or microservices only because they are common infrastructure choices.
- Making Redis Pub/Sub a durable message queue.
- Running production attachment bytes in gateway memory.
- Letting bots, search, analytics, or AI access E2EE plaintext.
- Splitting databases before domain ownership and operational requirements are stable.

## 10. Recommended Next Implementation Sequence

1. Commit and deploy the optional Redis Socket.IO adapter with production configuration.
2. Move presence, WebSocket rate limits, and read-receipt buffering to Redis-backed implementations.
3. Add connection draining, per-pod connection telemetry, and load-balancer/Kubernetes deployment manifests.
4. Introduce durable bot/outbox workers and idempotent event consumption.
5. Move attachments to object storage with signed URLs and background processing.
6. Add PgBouncer, load-test tooling, dashboards, alerting, and mixed-traffic failure drills.
7. Use benchmark evidence to decide whether Redis sharding, PostgreSQL replicas/partitioning, or Phase 3 service extraction is justified.
