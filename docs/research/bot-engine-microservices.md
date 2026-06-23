---
lang: en
---

# Nexus Chat Bot Engine and Microservices Decoupling — Architecture Research Report

> **Date**: 2026-06-24  
> **Author**: Architecture Team  
> **Status**: Draft v1.0  
> **Applicable Phase**: Phase 1 Monolith → Phase 2+ Microservices Migration

---

## Table of Contents

1. [Bot Engine Architecture Design](#1-bot-engine-architecture-design)
   - 1.1 [Event-Driven Architecture](#11-event-driven-architecture)
   - 1.2 [Bot Connection Modes](#12-bot-connection-modes)
   - 1.3 [Bot SDK Design](#13-bot-sdk-design)
2. [Message Processing Pipeline](#2-message-processing-pipeline)
   - 2.1 [Pipeline Stages](#21-pipeline-stages)
   - 2.2 [Asynchronous Processing Modes](#22-asynchronous-processing-modes)
3. [Microservices Decoupling Strategy](#3-microservices-decoupling-strategy)
   - 3.1 [Service Split Boundaries](#31-service-split-boundaries)
   - 3.2 [Inter-Service Communication](#32-inter-service-communication)
   - 3.3 [Database Strategy](#33-database-strategy)
4. [Bot Security](#4-bot-security)
5. [Observability](#5-observability)
6. [Summary and Recommendations](#6-summary-and-recommendations)
7. [Appendix: Recommended Dependency Version Table](#appendix-recommended-dependency-version-table)

---

## 1. Bot Engine Architecture Design

### 1.1 Event-Driven Architecture

#### Event Source Definitions

The Bot engine needs to be aware of all "meaningful changes" in the system. Event sources fall into the following categories:

| Event Category | Specific Events | Trigger Timing | Priority |
|---------|---------|---------|--------|
| **Message Events** | `message.created`, `message.updated`, `message.deleted` | User sends/edits/deletes a message | High |
| **Channel Events** | `channel.created`, `channel.archived`, `channel.member_joined`, `channel.member_left` | Channel lifecycle changes | Medium |
| **Bot Lifecycle** | `bot.installed`, `bot.uninstalled`, `bot.token_refreshed` | Bot is added/removed | Medium |
| **Interaction Events** | `slash_command.invoked`, `button.clicked`, `modal.submitted` | User interacts with Bot | High |
| **System Events** | `workspace.settings_changed`, `user.role_updated` | Workspace configuration changes | Low |

#### Event Bus Pattern Selection

Considering the characteristics of an IM application (low latency, ordered, persistent), a comparison of the four mainstream solutions:

| Dimension | Redis Streams | RabbitMQ | Kafka | NATS (JetStream) |
|------|--------------|----------|-------|-------------------|
| **Latency (p50)** | <1ms | ~2-5ms | ~5-10ms | **<0.5ms** |
| **Throughput** | ~100K msg/s | ~50K msg/s | **~600K msg/s** | ~200K msg/s |
| **Persistence** | ✅ (Stream + RDB) | ✅ (Queue durable) | ✅ (Native) | ✅ (JetStream) |
| **Message Replay** | ✅ (XREAD by ID) | ❌ (Requires extra plugin) | ✅ (Native offset) | ✅ (JetStream consumer) |
| **Ops Complexity** | Low (Already have Redis) | Medium | **High** (ZooKeeper/KRaft) | Low (Single binary) |
| **Resource Usage (idle)** | Shared Redis memory | ~80MB | **~2GB** (minimum) | ~30MB |
| **Filtering/Routing** | Consumer Group | Routing Key + Exchange | Topic Partition | Subject hierarchy + Queue |
| **Client Maturity (Node.js)** | `ioredis` native support | `amqplib` | `kafkajs` | `nats` (v2.x) |
| **Suitable Scenarios** | Small/medium message queues | Complex routing + task distribution | Large-scale data pipelines | Low-latency inter-service communication |
| **Monthly Cost (self-hosted)** | ~$0 (Already have Redis) | ~$0 | ~$200-800 (resources) | ~$0 |

#### Recommended Solution: **Phase 1 uses Redis Streams, Phase 2 upgrades to NATS JetStream**

**Rationale**:

1. **Phase 1 (Monolith)**: The system already uses Redis (sessions, caching, BullMQ). Leveraging `ioredis` Stream commands directly introduces an event bus at zero additional cost. The `XADD` + `XREADGROUP` + Consumer Group pattern natively supports multiple consumers and message acknowledgement.

2. **Phase 2+ (After microservices split)**: Redis Streams' limitations begin to surface — cross-service event routing requires manual topology management, no native cross-language client type safety, message TTL and eviction strategies are not flexible enough. At this point, switch to **NATS JetStream**:
   - Subject hierarchy naturally maps to event types (e.g., `chat.message.created.workspace-abc.channel-xyz`)
   - JetStream provides persistence, message replay, deduplication (`Nats-Msg-Id` header)
   - Leaf Nodes support cross-cluster/cross-region event forwarding
   - Single binary deployment, much lower ops cost than Kafka
   - Unified go/rust/node client ecosystem

**Code example — Redis Streams event publishing (Phase 1)**:

```typescript
// packages/shared/src/events/publisher.ts
import Redis from 'ioredis';

export class EventPublisher {
  constructor(private redis: Redis) {}

  async publish<T extends BaseEvent>(event: T): Promise<string> {
    const streamKey = `events:${event.type}`;
    const eventId = await this.redis.xadd(
      streamKey,
      '*',                    // auto-generate ID
      'type', event.type,
      'workspaceId', event.workspaceId,
      'channelId', event.channelId ?? '',
      'botId', event.botId ?? '',
      'payload', JSON.stringify(event.payload),
      'timestamp', event.timestamp.toISOString(),
    );
    // Also publish to a global stream for audit/replay
    await this.redis.xadd('events:all', '*', 'ref', `${streamKey}:${eventId}`);
    return eventId;
  }
}
```

**Code example — NATS JetStream event publishing (Phase 2)**:

```typescript
// packages/shared/src/events/nats-publisher.ts
import { connect, JetStreamClient, MsgHdrs } from 'nats';

const nc = await connect({ servers: ['localhost:4222'] });
const js: JetStreamClient = nc.jetstream();

export async function publishEvent<T extends BaseEvent>(event: T): Promise<void> {
  const subject = `chat.${event.type.replace(/\./g, '.')}.${event.workspaceId}`;
  const headers = MsgHdrs();
  headers.set('Nats-Msg-Id', event.id);  // Idempotent deduplication
  headers.set('X-Workspace-Id', event.workspaceId);
  headers.set('X-Channel-Id', event.channelId ?? '');

  await js.publish(subject, JSON.stringify(event.payload), { headers });
}
```

#### Event Routing and Filtering

Bots should not receive all events. In Phase 1, Consumer Group consumption filters at the application layer; in Phase 2 NATS, leverage subject hierarchy:

```
chat.message.created.<workspaceId>.<channelId>
chat.channel.member_joined.<workspaceId>.<channelId>
```

A Bot's `nats.subscribe()` only subscribes to subjects of its own channels. Filter subjects support wildcards: `chat.message.created.${wsId}.${chId}>`.

#### Event Persistence and Replay

| Solution | Implementation | Suitable Scenarios |
|------|---------|---------|
| Redis Streams (Phase 1) | `MAXLEN` limits stream length + periodic `XTRIM`, message IDs are monotonically increasing and replayable | Bot replays the last N messages on startup to restore context |
| NATS JetStream (Phase 2) | Stream configured with `max_age` + `duplicate_window`, Consumer created with `deliver_policy: all` or `by_start_sequence` | New Bot replays channel history events after installation to initialize state |
| Fallback | PostgreSQL `event_log` table (stores only key business events, auto-purged after T+30) | Final data source for audit + failure recovery |

**Conclusion**: Phase 1 uses Redis Streams + Consumer Group, keeping costs low; Phase 2 fully switches to NATS JetStream, leveraging its native persistence and subject hierarchy filters. Kafka is not recommended due to excessive ops cost (requires 2GB+ RAM even idle) and because this project does not fall under the big data pipeline scenario.

---

### 1.2 Bot Connection Modes

#### Comparison of Four Modes

| Dimension | WebSocket Persistent | HTTP Webhook Callback | gRPC Bidi Streaming | Hybrid (WS + Webhook) |
|------|-----------------|------------------|------------|------------------------|
| **Real-time** | ✅ <50ms | ❌ 500ms-5s (depends on retry) | ✅ <50ms | ✅ Primary WS real-time |
| **Server Push** | ✅ Native bidirectional | ❌ Requires polling or reverse connection | ✅ Native bidirectional | ✅ |
| **Connection Management** | ❌ Requires heartbeat/reconnect | ✅ Stateless | ❌ Requires gRPC stream management | ❌ Requires WS management |
| **Firewall Friendly** | ⚠️ Partially restricted | ✅ Standard HTTP | ⚠️ HTTP/2 may be restricted | ⚠️ Same as WS |
| **Bot Developer Experience** | ❌ Must maintain persistent connection library | ✅ Just need one HTTP endpoint | ❌ Requires protobuf + gRPC client | ⚠️ Two kinds of logic |
| **Load Balancing** | ❌ Sticky sessions | ✅ Arbitrary distribution | ❌ Requires L7 proxy support | ❌ Same as WS |
| **Horizontal Scaling** | ❌ Requires Pub/Sub decoupling | ✅ Naturally stateless | ❌ Requires stream state management | ❌ Same as WS |
| **Suitable Scenarios** | High-frequency real-time Bots (customer service, gaming) | Low-frequency notification Bots (CI/CD, monitoring alerts) | Internal inter-service communication | General-purpose platform Bots |

#### Applicability Analysis of gRPC Bidirectional Streaming

gRPC bidirectional streaming (Bidi Streaming) is theoretically ideal for Bot communication — bidirectional push, type-safe (protobuf), built-in flow control. However, in the **third-party Bot developer scenario**, there are serious issues:

1. **Language Binding**: Forces Bot developers to use the protobuf compilation toolchain (`protoc` + corresponding language plugin), significantly raising the development barrier
2. **No Browser Support**: gRPC-Web is usable but requires an Envoy proxy for conversion, increasing ops complexity
3. **Immature Ecosystem**: Compared to the ubiquity of Webhooks (nearly all web frameworks support them natively), gRPC ops tooling (debugging, packet capture, logging) is far less mature than HTTP

**The correct use of gRPC**: For **internal inter-service communication** (relay-service ↔ bot-service ↔ message-service), not as the external protocol for Bot ↔ Platform.

#### Recommended Solution: **Hybrid Mode — WebSocket primary + HTTP Webhook as fallback**

```
┌─────────────────────────────────────────────────┐
│                  Bot Developer                   │
│                                                   │
│  ┌─────────────┐     ┌─────────────────────┐     │
│  │ Real-time Bot│     │ Low-freq/Simple Bot  │     │
│  │ (CS/gaming)  │     │ (CI/CD/Notify/Cron)  │     │
│  └──────┬──────┘     └──────────┬──────────┘     │
│         │                       │                 │
│         ▼                       ▼                 │
│  ┌──────────────┐     ┌──────────────────┐       │
│  │ SDK (WS)     │     │ HTTP POST        │       │
│  │ Auto-reconnect│     │ Receives JSON     │       │
│  │ Heartbeat/BF  │     │                  │       │
│  └──────┬──────┘     └────────┬─────────┘       │
└─────────┼─────────────────────┼─────────────────┘
          │                     │
          ▼                     ▼
   ┌──────────────────────────────────────┐
   │          Relay Service                │
   │  ┌──────────┐  ┌──────────────────┐  │
   │  │ WS Gateway│  │ Webhook Dispatcher│  │
   │  │ (Native WS)│  │ (BullMQ dispatch) │  │
   │  └──────────┘  └──────────────────┘  │
   └──────────────────────────────────────┘
```

- **Default (recommended)**: WebSocket, suitable for Bots that need real-time responses (message replies, interactive components)
- **Alternative**: Webhook HTTP POST, suitable for low-frequency Bots that don't need real-time responses (daily digest pushes, CI/CD notifications)
- Bot selects connection mode at registration, platform dispatches events according to the mode

**Key Design**: After the WebSocket connection is established, the Bot sends an `identity` frame carrying the Bot Token (similar to Slack's `connections:open`). The relay-service validates the Token and registers the connection in the local connection pool. When events arrive, they are broadcast across relay instances via Redis Pub/Sub, and the instance holding the Bot's connection pushes to the WebSocket.

---

### 1.3 Bot SDK Design

#### SDK Architecture

The Bot SDK encapsulates three layers — connection management, event listening, and operation APIs — exposing a clean declarative interface to the outside.

```
@nexus-chat/bot-sdk
├── BotClient          # Main entry point
├── events/            # Event type definitions (imported from shared package)
├── api/               # Platform API operations (sendMessage, createChannel...)
├── middleware/         # Middleware pipeline
└── transport/         # Transport layer (WS / Webhook adapter)
```

**Code example — Bot SDK core interface**:

```typescript
// packages/bot-sdk/src/bot-client.ts
import { WebSocketTransport } from './transport/ws-transport';
import { EventEmitter } from './events/emitter';
import type { BotOptions, MessageEvent, ChannelEvent } from '@nexus-chat/shared';

export class BotClient {
  private transport: Transport;
  private emitter: EventEmitter;
  private rateLimiter: RateLimiter;
  private reconnect: ReconnectManager;

  constructor(options: BotOptions) {
    this.transport = new WebSocketTransport({
      url: options.gatewayUrl ?? 'wss://gateway.nexus-chat.com/v1/bot',
      token: options.token,
      heartbeatIntervalMs: 30_000,
    });

    this.rateLimiter = new RateLimiter({
      maxRequestsPerMinute: 120,
      backoffStrategy: 'exponential',
    });

    this.reconnect = new ReconnectManager({
      maxRetries: Infinity,
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      jitter: true,
    });

    this.emitter = new EventEmitter();
    this.setupLifecycle();
  }

  // ── Event Listeners (type-safe) ──
  on<T extends keyof BotEvents>(
    event: T,
    handler: (payload: BotEvents[T]) => Promise<void> | void,
  ): void {
    this.emitter.on(event, handler);
  }

  onMessage(handler: (event: MessageEvent) => Promise<void>): void {
    this.on('message.created', handler);
  }

  // ── Operation APIs ──
  async sendMessage(channelId: string, text: string): Promise<Message> {
    return this.rateLimiter.wrap(() =>
      this.transport.call('chat.sendMessage', { channelId, text }),
    );
  }

  async sendEphemeral(channelId: string, userId: string, text: string): Promise<void> {
    return this.transport.call('chat.sendEphemeral', { channelId, userId, text });
  }

  // ── Command Registration (slash commands) ──
  command(name: string, handler: CommandHandler): void {
    this.on('slash_command.invoked', async (event) => {
      if (event.command === name) {
        await handler(event);
      }
    });
  }

  // ── Lifecycle ──
  async start(): Promise<void> {
    await this.transport.connect();
    this.reconnect.start(() => this.transport.connect());
  }

  async stop(): Promise<void> {
    this.reconnect.stop();
    await this.transport.close();
  }

  private setupLifecycle(): void {
    this.transport.on('disconnected', () => this.emitter.emit('disconnected', {}));
    this.transport.on('reconnected', () => this.emitter.emit('reconnected', {}));
  }
}
```

**Bot developer usage example**:

```typescript
// Third-party Bot developer's code
import { BotClient } from '@nexus-chat/bot-sdk';

const bot = new BotClient({
  token: process.env.NEXUS_BOT_TOKEN!,
  gatewayUrl: 'wss://acme.nexus-chat.com/v1/bot',
});

bot.onMessage(async (event) => {
  if (event.payload.text.includes('@weather')) {
    const weather = await fetchWeather(event.payload.text);
    await bot.sendMessage(event.channelId, weather);
  }
});

bot.command('/poll', async (event) => {
  await bot.sendMessage(event.channelId, createPollUI(event.args));
});

await bot.start();
```

#### Type Safety (Imported from shared package)

The Bot SDK's event types and API return value types are shared from the `@nexus-chat/shared` package, not redundantly defined:

```typescript
// packages/shared/src/events/bot-events.ts — Authoritative type definitions
export interface MessageCreatedEvent {
  type: 'message.created';
  workspaceId: string;
  channelId: string;
  messageId: string;
  payload: {
    text: string;
    userId: string;
    threadId?: string;
    mentions: string[];
    attachments: Attachment[];
  };
  timestamp: Date;
  idempotencyKey: string;
}

export interface SlashCommandInvokedEvent {
  type: 'slash_command.invoked';
  workspaceId: string;
  channelId: string;
  command: string;
  args: string[];
  userId: string;
  triggerId: string;  // Used for 3-second response window
  timestamp: Date;
}

// Mapping table — Bot SDK achieves type safety through generic constraints
export interface BotEventMap {
  'message.created': MessageCreatedEvent;
  'message.updated': MessageUpdatedEvent;
  'slash_command.invoked': SlashCommandInvokedEvent;
  'channel.member_joined': ChannelMemberJoinedEvent;
  // ... other events
}
```

#### Reconnect and Heartbeat

```
        Bot SDK                         Relay Service
           │                                  │
           │──── CONNECT (token) ────────────>│
           │<─── CONNECTED (session_id) ──────│
           │                                  │
           │──── PING ───────────────────────>│  (every 30s)
           │<─── PONG ────────────────────────│
           │                                  │
           │       ⚡ Connection lost           │
           │                                  │
           │  [wait 1s] ──fail──→ [wait 2s]   │  Exponential backoff
           │─→ [wait 4s] ──fail──→ [wait 8s]   │  + random jitter
           │─→ ... [max 30s] ...             │  + infinite retry
           │                                  │
           │──── CONNECT (token + session) ──>│  Resume session
           │<─── CONNECTED (resumed: true) ───│
           │<─── [Replay unacknowledged events] │
```

**Implementation highlights**:
- When WebSocket closes, SDK automatically enables exponential backoff reconnection (`initialDelayMs: 1000, maxDelayMs: 30_000, jitter: true`)
- After successful reconnection, send a `session_resume` message carrying the previous `session_id`, relay-service replays unacknowledged events
- Heartbeat interval defaults to 30 seconds; server actively closes the connection if no PING is received within 2x the heartbeat interval

#### Rate Limiting and Backoff

```typescript
// packages/bot-sdk/src/rate-limiter.ts
export class RateLimiter {
  private bucket: TokenBucket;

  constructor(config: { maxRequestsPerMinute: number; backoffStrategy: 'exponential' | 'linear' }) {
    this.bucket = new TokenBucket({
      capacity: config.maxRequestsPerMinute,
      fillRate: config.maxRequestsPerMinute / 60_000, // tokens per ms
    });
  }

  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.bucket.tryConsume(1)) {
      const waitMs = this.bucket.timeUntilNextToken();
      await sleep(waitMs);
    }
    return fn();
  }
}
```

When relay-service returns `429 Too Many Requests`, the SDK reads the `Retry-After` response header and globally pauses all sending, resuming after the specified time.

**Conclusion**: The SDK adopts a **declarative event listener** + **type-safe operation API** design. WebSocket serves as the primary transport, with the SDK built-in with reconnect, heartbeat, rate limiting, and backoff strategies, so third-party developers don't need to worry about underlying connection management. It is recommended to reference the design philosophies of Slack Bolt SDK and Discord.js, while leveraging the monorepo's shared package to ensure type consistency.

---

## 2. Message Processing Pipeline

### 2.1 Pipeline Stages

After a user sends a message, the message goes through the following stages in sequence:

```
User sends message
    │
    ▼
┌──────────────────┐
│ 1. Message Validation│  ← Verify Token, channel permissions, message format (length/content filtering)
│    (auth guard)   │     Failure → return 4xx directly
└────────┬─────────┘
         │ ✅
         ▼
┌──────────────────┐
│ 2. E2E Encryption Branch│  ← If channel has e2e encryption enabled, use Signal Protocol to encrypt;
│    (conditional)  │     Normal channels skip this stage
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 3. Persist Storage │  ← INSERT INTO messages + update channel.last_message_at
│    (DB write)     │     Use idempotency_key UNIQUE constraint to prevent duplicates
└────────┬─────────┘
         │ ✅ (Message saved, idempotency_key ensures uniqueness)
         ▼
┌──────────────────┐
│ 4. Bot Event Dispatch│  ← Based on which Bots are in the channel, deliver message.created event
│    (async fanout) │     to message queue (Redis Stream / NATS), async parallel processing
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ 5. Real-time Broadcast│  ← Push to all online users' WebSocket connections in the channel via Pub/Sub
│    (relay push)   │     + store unread count for offline users in Redis
└──────────────────┘
```

#### Failure Handling and Retry Strategy

| Stage | Failure Scenario | Handling Strategy | Retry |
|------|---------|---------|------|
| Validation | Token expired | Return 401, client refreshes Token | None |
| Validation | Rate limited | Return 429 + Retry-After | None (handled by client) |
| Storage | DB write timeout | Return 503, client may retry (idempotency_key prevents duplicates) | Client 3x exponential backoff |
| Bot Dispatch | Bot processing timeout | Mark bot as degraded, remove from channel's event routing | Background health check restores after 30s |
| Bot Dispatch | Queue full | Drop low-priority events (typing indicator), ensure high-priority (message) | Log via dead letter queue |
| Broadcast | WebSocket write failure | Mark connection as dead, client SDK auto-reconnects | SDK auto-reconnect |

#### Idempotency Guarantee

```sql
-- Message table design
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  channel_id    UUID NOT NULL REFERENCES channels(id),
  user_id       UUID NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,  -- Generated by client, UNIQUE constraint guarantees idempotency
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at     TIMESTAMPTZ
);

-- Handle idempotency on insert
INSERT INTO messages (workspace_id, channel_id, user_id, idempotency_key, text)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (idempotency_key) DO UPDATE SET text = EXCLUDED.text  -- Or return existing record
RETURNING *;
```

Bot event dispatch also uses event-level `idempotencyKey`:

```typescript
// Event publishing carries idempotency key
const event: MessageCreatedEvent = {
  // ...
  idempotencyKey: `${messageId}:${eventType}`,  // "msg_abc123:message.created"
};
```

After Bot SDK or relay-service receives the event, check whether `idempotencyKey` has already been processed (local LRU cache + Redis `SETNX` double check).

**Conclusion**: The pipeline design follows the principle of **persist-first on write, dispatch asynchronously**. Messages are persisted in the database first to ensure no loss, then asynchronously distributed to Bots and online users. Idempotency is guaranteed through a dual-layer of `idempotency_key` UNIQUE constraint (database layer) + `idempotencyKey` LRU deduplication (application layer).

---

### 2.2 Asynchronous Processing Modes

#### Decoupling Message Writes from Bot Event Distribution

```
                          ┌──────────────┐
     HTTP POST /messages  │ API Gateway  │
          ───────────────>│              │
                          └──────┬───────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Validation+Storage│ │ Bot Dispatch│ │ Real-time Broadcast│
              │ (sync)    │ │ (async)   │ │ (async)   │
              └──────────┘ └──────────┘ └──────────┘
                   │              │              │
                   ▼              ▼              ▼
              PostgreSQL    Redis Stream     Redis Pub/Sub
                            / NATS           (In-channel broadcast)
```

**Key design decisions**:
- Message **validation + storage** completes synchronously within the request-response cycle, ensuring "message is persisted after user sends"
- **Bot event dispatch** and **real-time broadcast** execute asynchronously, without blocking the HTTP response
- Asynchronous stages use task queues rather than `Promise.all`, ensuring failures are retryable and observable

#### Task Queue Selection: BullMQ vs Inngest

| Dimension | BullMQ (Redis-based) | Inngest (Durable Execution) |
|------|-------------------|---------------------------|
| **Architecture** | Self-hosted Redis queue | Cloud-hosted / Self-hosted |
| **Persistence** | Redis RDB/AOF | Built-in step-level persistence |
| **Long-running tasks** | Depends on Redis stability | ✅ Durable Execution, tasks can run for hours |
| **Step-level retry** | ❌ Entire job retries | ✅ Each `step.run()` retries independently |
| **Installation complexity** | Low (Already have Redis) | Very low (`npm install inngest`) |
| **Cost** | ~$0 (Already have Redis) | Free 50K runs/mo, Pro $25/500K |
| **Multi-step orchestration** | Requires manual multi-queue management | ✅ Native `step.run()` + `step.waitForEvent()` |
| **Cloud dependency** | None | Requires Inngest Cloud (self-hosted limited) |
| **Latency** | <50ms | 50-200ms (Cloud polling latency) |
| **Node.js version** | BullMQ v5.x | Inngest v3.x |

#### Recommended Solution: **BullMQ as primary + preset Inngest integration point**

**Phase 1 defaults to BullMQ**: The project already has Redis infrastructure, and BullMQ is the most mature task queue in the Node.js ecosystem. v5.x (released 2025) has significantly optimized performance:

```bash
npm install bullmq@^5
```

```typescript
// packages/queue/src/queues/bot-event.queue.ts
import { Queue, Worker, QueueScheduler } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({ maxRetriesPerRequest: null });

// Event dispatch queue
export const botEventQueue = new Queue<BotEventJob>('bot-event-distribution', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600 },   // Clean successful jobs after 1h
    removeOnFail: { age: 86400 },       // Clean failed jobs after 24h
  },
});

// Worker — handles event dispatch for a single Bot
const worker = new Worker<BotEventJob>(
  'bot-event-distribution',
  async (job) => {
    const { botId, event } = job.data;
    const bot = await botRegistry.get(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);

    if (bot.connectionMode === 'websocket') {
      await relayService.pushEvent(bot.connectionId, event);
    } else if (bot.connectionMode === 'webhook') {
      await webhookDispatcher.deliver(bot.webhookUrl, event);
    }
  },
  {
    connection,
    concurrency: 20,           // Each Worker handles 20 Bots concurrently
    limiter: {
      max: 100,                // Max 100 jobs per second
      duration: 1000,
    },
  },
);
```

**Phase 2+ introduces Inngest for "long-running Bot tasks"**:

Some Bot operations require multiple steps and long waits (e.g., user submits approval → Bot waits for admin confirmation → Bot sends notification). BullMQ handling such scenarios requires manually managing multiple queues and states. Inngest's Durable Execution model natively supports this:

```typescript
// Example: Using Inngest for Bot workflows requiring human interaction
import { inngest } from '@/inngest/client';

export const approvalWorkflow = inngest.createFunction(
  {
    id: 'bot-approval-workflow',
    retries: 0,              // Manual approval workflows do not auto-retry
  },
  { event: 'bot/approval-requested' },
  async ({ event, step }) => {
    // Step 1: Send approval request to admin
    const approval = await step.run('send-approval-request', async () => {
      return await botApi.sendMessage(event.data.adminChannelId, {
        text: `User ${event.data.userId} requests ${event.data.action}`,
        blocks: buildApprovalButtons(event.data),
      });
    });

    // Step 2: Wait for admin to click button (can wait up to 7 days)
    const decision = await step.waitForEvent('wait-for-admin-decision', {
      event: 'interaction/button-clicked',
      match: 'data.approvalId',
      timeout: '7d',
    });

    // Step 3: Execute action based on decision
    await step.run('execute-decision', async () => {
      if (decision.data.action === 'approve') {
        await executeAction(event.data);
      }
      await botApi.sendMessage(event.data.userId, `Request ${decision.data.action}d`);
    });
  },
);
```

**Conclusion**: Daily Bot event dispatch uses **BullMQ** (low latency, zero additional cost, Redis infrastructure reuse); complex Bot workflows requiring human interaction and long waits use **Inngest** (Durable Execution, step-level retry, simplified state management). It is recommended to start with BullMQ in Phase 1 and introduce Inngest on demand in Phase 2 — the two can coexist, with Inngest handling complex workflows and BullMQ handling high-frequency simple dispatch.

---

## 3. Microservices Decoupling Strategy

### 3.1 Service Split Boundaries

#### Target Architecture Diagram

```
                        ┌─────────────────────────────┐
                        │      API Gateway             │
                        │   (Traefik / Kong)           │
                        └──────────┬──────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────────┐
          │                        │                            │
          ▼                        ▼                            ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
│  auth-service    │   │  message-service │   │  relay-service       │
│  ─────────────   │   │  ──────────────  │   │  ──────────────      │
│  - User register/login│   │  - Message CRUD    │   │  - WebSocket connection pool│
│  - JWT sign/verify│   │  - Channel mgmt   │   │  - Real-time broadcast (Pub/Sub)│
│  - OAuth2 flow   │   │  - Message search (ES)│   │  - Online status tracking│
│  - RBAC permissions│   │  - Attachment upload│   │  - Event push to Bots │
│                  │   │                  │   │                      │
│  DB: PostgreSQL  │   │  DB: PostgreSQL  │   │  Stateless + Redis Pub/Sub│
│  (auth schema)   │   │  (chat schema)   │   │                      │
└──────────────────┘   └──────────────────┘   └──────────────────────┘

┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
│  bot-service     │   │  signal-service  │   │ notification-service │
│  ─────────────   │   │  ──────────────  │   │  ──────────────────  │
│  - Bot registration/mgmt│   │  - Signal Protocol│   │  - Push (FCM/APNs)   │
│  - Event subscription routing│   │  - PreKey distribution│   │  - Email notifications│
│  - SDK management │   │  - Key rotation   │   │  - Notification preferences│
│  - Rate limiting  │   │                  │   │                      │
│                  │   │  DB: PostgreSQL  │   │  Stateless            │
│  DB: PostgreSQL  │   │  (signal schema)  │   │                      │
│  (bot schema)    │   │                  │   │                      │
└──────────────────┘   └──────────────────┘   └──────────────────────┘

┌──────────────────────┐
│  search-service      │   ← Phase 2
│  ──────────────────  │
│  - Elasticsearch cluster│
│  - Message indexing/search│
│  - Full-text search   │
│                       │
│  DB: Elasticsearch    │
└──────────────────────┘
```

#### Service Responsibilities and Split Timing

| Service | Phase 1 (Monolith) | Phase 2 (Split) | Split Trigger Condition |
|------|---------------|---------------|------------|
| **auth-service** | `packages/auth/` module | Independent service | WebSocket connections >10K, JWT validation becomes bottleneck |
| **message-service** | `packages/messages/` module | Independent service | Message write QPS >1K and competing with Bot dispatch for resources |
| **relay-service** | Embedded Express + ws | Independent service (split first) | WebSocket connections >5K, needs independent scaling |
| **bot-service** | `packages/bot-engine/` module | Independent service (immediately after relay) | Bot count >50 or Bot processing is CPU-intensive |
| **signal-service** | `packages/signal/` module | Independent service | Split after e2e encryption GA |
| **notification-service** | Embedded firebase-admin | Independent service | Push notification latency >2s or cross-platform push needs |
| **search-service** | PostgreSQL `tsvector` | Independent ES cluster | Message volume >10M or search latency >500ms |

**Priority split order**: relay-service → bot-service → message-service → notification-service → auth-service → search-service → signal-service

Rationale: relay-service (WebSocket connection management) is the service with the most independent scaling needs, and is naturally stateless (state in Redis), making it the lowest-cost split.

---

### 3.2 Inter-Service Communication

#### Communication Evolution Path

```
Phase 1 (Monolith)              Phase 2 (Hybrid)              Phase 3 (Full Microservices)
─────────────────      ─────────────────────      ─────────────────────
                          
Direct function calls between   gRPC (internal critical paths)   gRPC (all sync calls)
  + Redis Pub/Sub       + NATS Pub/Sub (async events)   + NATS JetStream (persistent events)
  + Redis Streams       + Redis (cache)              + Redis (cache)
                                                    + API Gateway unified entry
```

#### gRPC or NATS?

| Scenario | Recommendation | Reason |
|------|------|------|
| Bot requests to query user info | **gRPC** | Request-response pattern, needs type safety + low latency |
| Notify bot-service after message creation | **NATS** | One-to-many broadcast, loose coupling, doesn't care who consumes |
| Bot calls sendMessage API | **gRPC** | Bot needs to get message ID synchronously |
| relay-service broadcasts message to online users | **NATS Pub/Sub** | One-to-many real-time push, decoupled between relay instances |
| Cross-cluster event sync | **NATS Leaf Nodes** | Native cross-cluster support |

**Conclusion**: Use gRPC for synchronous calls, NATS for asynchronous events. Don't try to replace all RPC with NATS (you'll lose type safety and structured error handling), and don't replace all messaging with gRPC (it leads to tight coupling and loss of resilience).

**Code example — gRPC service definition**:

```protobuf
// proto/bot/v1/bot_service.proto
syntax = "proto3";

package bot.v1;

service BotService {
  // Called by Bot admins
  rpc RegisterBot(RegisterBotRequest) returns (RegisterBotResponse);
  rpc GetBot(GetBotRequest) returns (Bot);
  rpc ListWorkspaceBots(ListWorkspaceBotsRequest) returns (ListWorkspaceBotsResponse);

  // Called by Bot runtime (via gRPC bidi streaming or SDK wrapper)
  rpc SendMessage(SendMessageRequest) returns (SendMessageResponse);
  rpc CreateChannel(CreateChannelRequest) returns (CreateChannelResponse);
}

message RegisterBotRequest {
  string workspace_id = 1;
  string name = 2;
  repeated string scopes = 3;
  string connection_mode = 4;     // "websocket" | "webhook"
  optional string webhook_url = 5;
}

message SendMessageRequest {
  string channel_id = 1;
  string text = 2;
  optional string thread_id = 3;
  string auth_token = 4;          // Bot Token
}
```

#### API Gateway Selection

| Dimension | Kong | Traefik | Envoy | Self-built (fastify-reverse) |
|------|------|---------|-------|----------------------|
| **Learning curve** | Medium | **Low** | High | Low |
| **Installation complexity** | Medium | **Very low** | High | Low |
| **Auto service discovery** | K8s Ingress | ✅ **Native K8s auto-discovery** | Requires Istio/Envoy Gateway | Manual |
| **WebSocket support** | ✅ | ✅ | ✅ | ✅ |
| **gRPC support** | ✅ | ⚠️ Basic | ✅ **Native** | ❌ Requires custom implementation |
| **Let's Encrypt** | Requires plugin | ✅ **Built-in** | Requires cert-manager | Manual |
| **Plugin ecosystem** | 100+ | 20+ middleware | WASM Filters | Custom-built |
| **Dashboard** | Kong Manager | ✅ **Built-in** | Requires extra tools | None |
| **Memory usage (idle)** | ~80MB | **~50MB** | ~30MB | ~20MB |
| **Suitable scenarios** | API management platform | Small/medium K8s ingress | High-traffic service mesh | Early-stage rapid prototyping |

**Recommended Solution**: **Phase 1 uses self-built fastify-reverse-proxy (or directly use Caddy) → Phase 2 switches to Traefik**

**Rationale**: In the Phase 1 monolith stage, with a small number of services (maybe only 1-2 processes), a heavyweight API gateway is unnecessary. Use **Caddy** as a reverse proxy + automatic HTTPS, or build the simplest routing layer with fastify.

In Phase 2 after microservices split (>5 services), switch to **Traefik**:
- Auto-discovers K8s/Docker services, zero-config routing
- Built-in Let's Encrypt, automated HTTPS
- Native WebSocket support (core requirement for relay-service)
- Active community, MIT license, lowest learning cost

Unless the team has mature Envoy/Kong ops experience, it is not recommended to start with them — for early small/medium deployments, Traefik's simplicity advantage far outweighs Kong/Envoy's rich feature set.

#### Service Discovery

| Solution | Recommendation | Suitable Scenarios |
|------|-------|---------|
| **Kubernetes DNS** | ⭐⭐⭐ **Recommended** | Deployed on K8s, Service + ClusterIP provides natural service discovery |
| **Consul** | ⭐⭐ | Non-K8s deployment, needs health checks + KV store |
| **etcd** | ⭐ | Only consider if already have etcd cluster |
| **Hardcoded + Env vars** | ⭐ | Phase 1 monolith transitional solution |

**Recommendation**: Directly use **Kubernetes DNS** (`bot-service.namespace.svc.cluster.local`), since nearly all production deployments in 2026 are on K8s. For non-K8s environments (dev/test), use Docker Compose service names as DNS.

---

### 3.3 Database Strategy

#### From Shared Database to Database-per-service

```
Phase 1: Shared DB                    Phase 2: Database-per-service
─────────────────────          ─────────────────────────────────────

┌──────────────────┐            ┌──────────┐ ┌──────────┐ ┌──────────┐
│   PostgreSQL     │            │  auth    │ │  message │ │  bot     │
│                  │            │  DB      │ │  DB      │ │  DB      │
│  public.users    │            │          │ │          │ │          │
│  public.workspace│            └──────────┘ └──────────┘ └──────────┘
│  chat.messages   │
│  chat.channels   │               Each service independently manages its own database schema.
│  bot.bots        │               Cross-service data is queried via API, not direct JOIN.
│  bot.events      │
│  auth.tokens     │
│  signal.keys     │
└──────────────────┘
```

#### Challenges and Solutions During Migration

**Problem 1: Cross-service queries**

After Phase 2 split, message queries need to JOIN the users table (in auth-service), but the databases are already separated.

Solution:
- **API Composition**: message-service calls auth-service's gRPC `GetUser(ids)` to fetch user info, combining at the application layer
- **Materialized View**: message-service stores a "user snapshot" (user_id, display_name, avatar_url), asynchronously updated by listening to `user.updated` events. It's reasonable redundancy for most IM products to attach user names to messages (Slack/Discord both do this)

```typescript
// User snapshot in message-service
interface UserSnapshot {
  userId: string;
  displayName: string;
  avatarUrl: string;
  updatedAt: Date;
}

// Listen for user.updated events, asynchronously update local snapshot
nats.subscribe('identity.user.updated.>', {
  callback: async (err, msg) => {
    const event = JSON.parse(msg.data);
    await db.userSnapshot.upsert({
      where: { userId: event.userId },
      update: { displayName: event.displayName, avatarUrl: event.avatarUrl, updatedAt: now },
      create: { userId: event.userId, displayName: event.displayName, avatarUrl: event.avatarUrl },
    });
  },
});
```

**Problem 2: CQRS + Event Sourcing introduction timing**

| Phase | Pattern | Description |
|------|------|------|
| Phase 1 | Traditional CRUD | Direct read/write to PostgreSQL, simple and straightforward |
| Phase 2 (Message volume >10M) | Lightweight CQRS introduction | Message writes → PostgreSQL (command model), search queries → Elasticsearch (query model), synced via CDC or events |
| Phase 3 (Audit requirements) | Event Sourcing (partial) | Only apply Event Sourcing to the "message" aggregate, storing complete event stream to support compliance auditing and time travel |

**Do not introduce Event Sourcing prematurely**: ES has extremely high learning and ops costs (event version compatibility, snapshot strategy, replay consistency), and will severely slow down development speed in the early stages. 90% of IM applications are fine with CRUD + CDC synced to ES.

**Recommended approach**:

1. **Phase 1**: Shared PostgreSQL, use **schema** to divide logical boundaries (`chat.`, `bot.`, `auth.`, `signal.`), preparing for future splitting
2. **Phase 2 message volume <10M**: Continue shared PostgreSQL, but each service only accesses its own schema (enforced at the code level, no direct cross-schema JOIN)
3. **Phase 2 message volume >10M**: Split message-service and search-service databases; introduce Elasticsearch for search; use Debezium + Kafka Connect (or lightweight `pg-logical-replication` + custom CDC worker) to sync PostgreSQL → ES
4. **Phase 3**: Gradually apply Database-per-service to other services on demand, following the principle of "split stateless services first, split databases last"

**Conclusion**: Database splitting is the most dangerous step in microservices adoption. It is recommended to continue **"Shared Database + Schema Isolation"** until mid-to-late Phase 2, until business needs (such as independent scaling, team autonomy) clearly mandate splitting. Premature database splitting leads to distributed transactions and data consistency issues that greatly increase complexity.

---

## 4. Bot Security

### 4.1 Bot Token Generation and Verification

Adopt a Token format similar to Slack's, but using our own prefix:

```
Format: nxbot-<version>-<random_id>-<signature>
Example: nxbot-v1-a1b2c3d4e5f6-hmac_sha256_signature

Token structure:
┌───────┬────┬────────────────────┬──────────────────────────┐
│ nxbot │ v1 │ base62(16 bytes)    │ HMAC-SHA256(prefix, secret) │
│ Prefix│ Version│ Random Bot identifier │ Signature                 │
└───────┴────┴────────────────────┴──────────────────────────┘
```

**Token generation (server-side)**:

```typescript
// packages/bot-service/src/token.service.ts
import crypto from 'node:crypto';

const BOT_TOKEN_SECRET = process.env.BOT_TOKEN_SIGNING_SECRET!; // 64-byte hex, injected from Vault/K8s Secret

export function generateBotToken(botId: string): string {
  const version = 'v1';
  const randomId = crypto.randomBytes(16).toString('base64url').slice(0, 22); // 22 chars
  const plaintext = `${version}-${randomId}`;
  const signature = crypto
    .createHmac('sha256', Buffer.from(BOT_TOKEN_SECRET, 'hex'))
    .update(plaintext)
    .digest('base64url')
    .slice(0, 32); // 32 chars for readability
  return `nxbot-${plaintext}-${signature}`;
}

export function verifyBotToken(token: string): { botId: string } | null {
  const parts = token.split('-');
  if (parts.length !== 4 || parts[0] !== 'nxbot') return null;
  const [_, version, randomId, providedSig] = parts;
  const plaintext = `${version}-${randomId}`;
  const expectedSig = crypto
    .createHmac('sha256', Buffer.from(BOT_TOKEN_SECRET, 'hex'))
    .update(plaintext)
    .digest('base64url')
    .slice(0, 32);
  if (!crypto.timingSafeEqual(Buffer.from(providedSig), Buffer.from(expectedSig))) {
    return null;
  }
  // Query database to get botId
  return botRegistry.findByTokenHashed(token);
}
```

**Storage**: The database stores only `SHA256(token)` hash + `token_prefix` (first 8 characters for UI display, similar to GitHub's `ghp_xxxx...`). The original Token is shown only once at generation time.

```sql
CREATE TABLE bot_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id      UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA256(token)
  token_prefix TEXT NOT NULL,              -- First 8 chars, e.g., "nxbot-v1"
  scopes      TEXT[] NOT NULL,             -- ['chat:write', 'channels:read']
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ,                 -- NULL = does not expire
  revoked_at  TIMESTAMPTZ                  -- NULL = not revoked
);
CREATE INDEX idx_bot_tokens_bot_id ON bot_tokens(bot_id);
```

### 4.2 Bot Permission Model (OAuth2 Scopes)

```
Scope Design (referencing Slack + Discord):

Message Related:
  chat:read          - Read channel messages
  chat:write         - Send messages to channels
  chat:write.custom  - Send custom Block/UI messages

Channel Related:
  channels:read      - Read channel list/info
  channels:manage    - Create/archive channels
  channels:members   - View channel members

Interactions:
  commands           - Register/respond to slash commands
  interactions       - Respond to button/modal interactions

Users:
  users:read         - Read basic workspace user info
  users:read.email   - Read user email (sensitive, requires approval)

Files:
  files:read         - Read files accessible to Bot
  files:write        - Upload files

Management:
  bot                - Bot self-management (only Bot admins can use)
```

**OAuth2 Bot Installation Flow (simplified)**:

```
1. User clicks "Add Bot" in UI
2. Select Scopes needed by the Bot (configurable default Scopes + user-selectable)
3. Backend generates authorization_code → returns to UI
4. UI calls POST /api/bots/install { code, scopes }
5. Backend verifies code → generates Bot Token → returns Token (only this once)
6. User copies Token to configure in Bot code
```

### 4.3 Rate Limiting

**Two-tier rate limiting model**:

```
Level 1: Per-Bot rate limiting (protects the platform)
  - Default: 120 requests/min/bot
  - Configurable: Premium Bots can apply for higher limits
  - Returns 429 + Retry-After header when exceeded

Level 2: Per-Workspace rate limiting (protects the workspace)
  - Default: All Bots combined 1000 events/min/workspace
  - When exceeded, all Bot event dispatch degrades (drops low-priority events like typing)
  - Keeps high-priority events like message.created delivering normally

Level 3 (Optional): Per-API-Endpoint rate limiting
  - sendMessage: 60/min
  - createChannel: 10/min
  - uploadFile: 30/min
```

**Implementation (using sliding window + Redis)**:

```typescript
// packages/bot-service/src/rate-limiter/sliding-window.ts
import Redis from 'ioredis';

export class SlidingWindowRateLimiter {
  constructor(private redis: Redis) {}

  async isAllowed(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;

    const luaScript = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      if count < tonumber(ARGV[2]) then
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3] .. '-' .. ARGV[4])
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        return {1, tonumber(ARGV[2]) - count - 1, ARGV[3] + ARGV[5]}
      end
      local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]
      return {0, 0, oldest + tonumber(ARGV[5])}
    `;

    const [allowed, remaining, resetAt] = await this.redis.eval(
      luaScript, 1, key, windowStart, limit, now, `${Math.random()}`, windowMs,
    ) as [number, number, number];

    return { allowed: allowed === 1, remaining, resetAt };
  }
}

// Usage
const limiter = new SlidingWindowRateLimiter(redis);

// Bot-level rate limiting
const botKey = `ratelimit:bot:${botId}:minute`;
const botLimit = await limiter.isAllowed(botKey, 120, 60_000);

// Workspace-level rate limiting
const wsKey = `ratelimit:workspace:${workspaceId}:minute`;
const wsLimit = await limiter.isAllowed(wsKey, 1000, 60_000);
```

### 4.4 Bot Data Isolation

Bots can only access data from channels they have been added to, guaranteed through the following mechanisms:

```typescript
// packages/bot-service/src/guards/data-isolation.guard.ts

export async function enforceBotChannelAccess(
  botId: string,
  channelId: string,
  requiredScope: string,
): Promise<boolean> {
  // 1. Check if Bot has been added to this channel
  const membership = await db.botChannelMemberships.findFirst({
    where: { botId, channelId, revokedAt: null },
  });
  if (!membership) return false;

  // 2. Check if Bot's Token has the required scope
  if (!membership.scopes.includes(requiredScope)) return false;

  // 3. Check if the Bot's workspace is active
  const workspace = await db.workspaces.findUnique({
    where: { id: membership.workspaceId },
  });
  if (!workspace || workspace.status !== 'active') return false;

  return true;
}

// Called in every API handler of message-service or bot-service
async function handleSendMessage(req: Request, res: Response) {
  const botId = extractBotIdFromToken(req.headers.authorization);
  const { channelId, text } = req.body;

  if (!await enforceBotChannelAccess(botId, channelId, 'chat:write')) {
    return res.status(403).json({ error: 'bot_not_in_channel' });
  }

  // Continue processing...
}
```

**Filtering during event dispatch**:

```typescript
// After message is created, dispatch event only to Bots in that channel
async function dispatchToBots(channelId: string, event: BaseEvent): Promise<void> {
  const channelBots = await db.botChannelMemberships.findMany({
    where: { channelId, revokedAt: null },
    select: { botId: true, scopes: true },
  });

  for (const { botId, scopes } of channelBots) {
    // Only dispatch event types that the Bot has permission to receive
    const requiredScope = eventScopeMap[event.type];
    if (requiredScope && !scopes.includes(requiredScope)) continue;

    await botEventQueue.add(`bot:${botId}:${event.type}`, {
      botId,
      event,
      channelId,
    });
  }
}
```

**Conclusion**: Bot security design references the Slack OAuth2 Scopes model. Tokens use a self-verifying HMAC format (`nxbot-v1-xxx-signature`), and the database stores only the hash. A **Bot-level + Workspace-level two-tier rate limiting** is adopted, with data isolation implemented through the `bot_channel_memberships` join table + Scope validation.

---

## 5. Observability

### 5.1 Distributed Tracing (OpenTelemetry + Jaeger/Grafana Tempo)

**Recommended Solution**: **OpenTelemetry JS SDK + Grafana Tempo** (Phase 2 replaces Jaeger)

OpenTelemetry is the CNCF observability standard, and the Node.js SDK is stable (`@opentelemetry/sdk-node` v1.x).

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-grpc \
  @opentelemetry/instrumentation-http \
  @opentelemetry/instrumentation-express \
  @opentelemetry/instrumentation-pg \
  @opentelemetry/instrumentation-redis \
  @opentelemetry/instrumentation-grpc
```

```typescript
// packages/tracing/src/tracing.ts — Initialization
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export function initTracing(serviceName: string): NodeSDK {
  return new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.APP_VERSION ?? '0.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4317',
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
}
```

**Bot processing trace example**:

```
Span: "HTTP POST /api/messages" (API Gateway)
├── Span: "auth.verifyToken" (auth-service) — 2ms
├── Span: "message.create" (message-service) — 15ms
│   ├── Span: "db.insert messages" — 8ms
│   └── Span: "event.publish message.created" — 1ms
├── Span: "bot.dispatch" (bot-service) — 45ms
│   ├── Span: "bot.greeting_handler.execute" — 40ms
│   │   └── Span: "bot.sendMessage via WS" — 5ms
│   └── Span: "bot.ci_handler.execute" — 30ms
└── Span: "relay.broadcast" (relay-service) — 3ms
```

### 5.2 Structured Logging (Pino + Loki)

```bash
npm install pino@^9 pino-pretty
```

```typescript
// packages/logger/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    // Inject trace/span context from AsyncLocalStorage
    const context = getTraceContext();
    return {
      traceId: context?.traceId,
      spanId: context?.spanId,
      serviceName: process.env.SERVICE_NAME ?? 'nexus-chat',
    };
  },
  // Production outputs JSON (for Loki ingestion), dev uses pino-pretty
  ...(process.env.NODE_ENV === 'production'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

// Key event log examples
logger.info({ event: 'message.created', messageId, channelId, workspaceId }, 'Message created');
logger.warn({ event: 'bot.timeout', botId, handler: 'onMessage', durationMs: 30000 }, 'Bot handler timeout');
logger.error({ err, event: 'bot.webhook_failed', botId, statusCode: 502 }, 'Webhook delivery failed');
```

**Log ingestion architecture**: `Pino (JSON stdout) → Promtail / Grafana Alloy → Loki → Grafana`

### 5.3 Prometheus + Grafana Monitoring

```bash
npm install prom-client@^15
```

**Core metric definitions**:

```typescript
// packages/metrics/src/metrics.ts
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

export const registry = new Registry();

// Bot execution duration
export const botExecutionDuration = new Histogram({
  name: 'bot_execution_duration_seconds',
  help: 'Bot event handler execution duration',
  labelNames: ['bot_id', 'event_type', 'handler_name'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

// Bot execution count (success/failure)
export const botExecutionTotal = new Counter({
  name: 'bot_execution_total',
  help: 'Total bot event handler executions',
  labelNames: ['bot_id', 'event_type', 'status'], // status: 'success' | 'error' | 'timeout'
  registers: [registry],
});

// Online Bot connection count
export const botConnectionsGauge = new Gauge({
  name: 'bot_connections_active',
  help: 'Number of active bot WebSocket connections',
  labelNames: ['relay_instance'],
  registers: [registry],
});

// Webhook delivery latency
export const webhookDeliveryDuration = new Histogram({
  name: 'webhook_delivery_duration_seconds',
  help: 'Webhook HTTP delivery duration',
  labelNames: ['bot_id', 'status_code'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// Event queue depth
export const eventQueueDepth = new Gauge({
  name: 'bot_event_queue_depth',
  help: 'Bot event queue depth (BullMQ waiting count)',
  labelNames: ['queue_name'],
  registers: [registry],
});

// Bot rate limit hit count
export const botRateLimitHits = new Counter({
  name: 'bot_rate_limit_hits_total',
  help: 'Times bot rate limit was triggered',
  labelNames: ['bot_id', 'workspace_id'],
  registers: [registry],
});
```

**Dashboard suggestions**:
- **Bot Health Overview**: Online Bot count, error rate, P50/P95/P99 latency
- **Event Processing Throughput**: QPS grouped by event type, queue depth
- **Connection Status**: WebSocket connection count, reconnect rate, Webhook success rate
- **Security Monitoring**: Rate limit trigger count, Token verification failure count

### 5.4 Health Check and Readiness Probe

```typescript
// Unified health check endpoint, used by Kubernetes liveness/readiness probe
import { healthChecker } from './health';

app.get('/health', async (_req, res) => {
  const health = await healthChecker.check([
    { name: 'database', check: async () => db.$queryRaw`SELECT 1` },
    { name: 'redis', check: async () => redis.ping() },
    { name: 'nats', check: async () => natsConnected, timeout: 2000 },
  ]);
  const isHealthy = Object.values(health).every((h) => h.status === 'up');
  res.status(isHealthy ? 200 : 503).json(health);
});
```

**Conclusion**: The three pillars of observability — **Tracing (OpenTelemetry + Tempo/Jaeger), Logging (Pino + Loki), Metrics (Prometheus + Grafana)**. Phase 1 at minimum implements structured logging + Prometheus metrics; Phase 2 fully enables distributed tracing.

---

## 6. Summary and Recommendations

### Core Recommended Decision Table

| Decision Point | Phase 1 Recommendation | Phase 2+ Recommendation | Rationale |
|--------|-------------|--------------|------|
| **Event Bus** | Redis Streams | NATS JetStream | Start at zero additional cost → low latency + persistence |
| **Bot Connection** | WebSocket (SDK wrapped) | WebSocket + Webhook fallback | Real-time first, SDK simplifies development |
| **Task Queue** | BullMQ | BullMQ + Inngest (complex workflows) | Mature and stable + introduce Durable Execution on demand |
| **Bot SDK** | Custom `@nexus-chat/bot-sdk` | Continuous iteration | Reference Slack Bolt + Discord.js patterns |
| **Service Communication (sync)** | Function calls | gRPC | Type safety + high performance |
| **Service Communication (async)** | Redis Pub/Sub | NATS | Loose coupling broadcast |
| **API Gateway** | Caddy / Nginx reverse proxy | Traefik | Simple start → K8s native |
| **Database** | Shared PostgreSQL (Schema isolation) | Database-per-service (gradual) | Split services first, databases last |
| **Search** | PostgreSQL `tsvector` | Elasticsearch 8.x | Sufficient for simple cases → full-text search |
| **Bot Token** | HMAC self-verifying `nxbot-v1-xxx` | Same format + full OAuth2 flow | Simple and secure |
| **Permission Model** | OAuth2 Scopes | Same + fine-grained resource-level permissions | Standardized |
| **Rate Limiting** | Bot-level (120/min) | Bot + Workspace two-tier | Gradually tighten |
| **Logging** | Pino | Pino → Loki | Structured first |
| **Metrics** | prom-client | Prometheus + Grafana | Standard approach |
| **Tracing** | Optional | OpenTelemetry + Tempo | Fully enabled in Phase 2 |

### Evolution Roadmap

```
Phase 1 (MVP, 1-3 months)
├── Monolithic Node.js backend
├── Shared PostgreSQL (schema isolation)
├── Redis Streams event bus
├── BullMQ task queue
├── Bot WebSocket SDK + basic events
├── Pino structured logging + prom-client metrics
└── Caddy reverse proxy

Phase 2 (Growth, 3-9 months)
├── Split relay-service (WebSocket scaling)
├── Split bot-service (Bot engine + SDK independent)
├── Introduce NATS (replace Redis Streams)
├── gRPC internal service communication
├── Traefik API Gateway (K8s)
├── Inngest for complex Bot workflows
├── OpenTelemetry full-chain tracing
├── Loki + Grafana log aggregation
└── Elasticsearch full-text search

Phase 3 (Scale, 9-18 months)
├── Full Database-per-service
├── CQRS + CDC (message → ES sync)
├── Multi-region deployment (NATS Leaf Nodes)
├── Bot Marketplace + review process
├── Full OAuth2 Bot installation flow
└── Signal Protocol E2E Encryption GA
```

### Key Principles

1. **Monolith first, microservices later**: Don't prematurely split microservices. The timing for monolith → microservices is: independent scaling needs, team boundaries, clear performance bottlenecks — not "everyone else is doing it"
2. **Async first**: All operations after message persistence (Bot dispatch, notifications, broadcast) should be asynchronous, ensuring API response speed
3. **Sharing is a liability**: Phase 1 shared database is a necessary compromise, but must use Schema isolation + code conventions to prevent cross-boundary JOINs
4. **SDK is a product**: Bot SDK's developer experience determines the quality of the third-party Bot ecosystem. Invest enough effort in polishing type safety, error messages, documentation, and examples
5. **Security built-in**: Token hash storage, Scope least privilege, two-tier rate limiting, data isolation — get it right from Day 1

---

## Appendix: Recommended Dependency Version Table

### Phase 1 Core Dependencies (as of June 2026)

| Package | Version | Purpose | Notes |
|------|------|------|------|
| `typescript` | `^5.7` | Type system | Used across all projects |
| `fastify` | `^5.x` | HTTP framework | Replaces Express, better performance |
| `ioredis` | `^5.5` | Redis client | Supports Streams, Pub/Sub, Cluster |
| `bullmq` | `^5.x` | Task queue | Redis-based |
| `ws` | `^8.x` | WebSocket server | relay-service and bot SDK |
| `@opentelemetry/sdk-node` | `^1.x` | Distributed tracing | Optional Phase 1 introduction |
| `@opentelemetry/auto-instrumentations-node` | `^0.x` | Auto instrumentation | - |
| `pino` | `^9.x` | Structured logging | Fastest in the industry |
| `prom-client` | `^15.x` | Prometheus metrics | - |
| `pg` / `drizzle-orm` | `^8.x` / `^0.40+` | PostgreSQL driver/ORM | Drizzle is more suitable for microservices than Prisma |
| `zod` | `^3.x` | Runtime validation | Share schemas across services |
| `nanoid` | `^5.x` | ID generation | More compact than UUIDv4 |
| `crypto` | Node.js built-in | Token signing/verification | No extra dependency needed |

### Phase 2 Additional Dependencies

| Package | Version | Purpose | Notes |
|------|------|------|------|
| `nats` | `^2.x` | NATS client (Node.js) | Pub/Sub + JetStream |
| `@grpc/grpc-js` | `^1.x` | gRPC client/server | Internal service communication |
| `@grpc/proto-loader` | `^0.7` | Proto file loading | - |
| `inngest` | `^3.x` | Durable Execution | Complex Bot workflows |
| `@elastic/elasticsearch` | `^8.x` | ES client | Full-text search |
| `@opentelemetry/exporter-trace-otlp-grpc` | `^0.x` | OTLP Trace export | Send to Tempo/Jaeger |
| `@opentelemetry/instrumentation-grpc` | `^0.x` | gRPC auto instrumentation | - |

### Infrastructure Version Recommendations

| Component | Recommended Version | Deployment Method |
|------|---------|---------|
| PostgreSQL | 17.x | Managed (RDS / Cloud SQL) or K8s StatefulSet |
| Redis | 7.4+ | Managed (ElastiCache) or K8s StatefulSet |
| NATS Server | 2.11+ | K8s Deployment + JetStream PVC |
| Traefik | 3.x | K8s DaemonSet |
| Elasticsearch | 8.x | Managed (Elastic Cloud) or K8s Operator |
| Grafana | 11.x | K8s Deployment |
| Loki | 3.x | K8s StatefulSet |
| Tempo | 2.x | K8s Deployment |
| OpenTelemetry Collector | 0.1xx | K8s DaemonSet |
| Node.js | 22 LTS | Docker / K8s |

---

> **Next Steps**:
> 1. Review the key recommendations in this report and confirm technical decisions
> 2. Begin initial development of the `@nexus-chat/bot-sdk` package
> 3. Define event type schemas in the `shared` package
> 4. Set up Redis Streams + BullMQ infrastructure for Phase 1
> 5. Prepare a standalone WebSocket connection management module for the relay-service split
