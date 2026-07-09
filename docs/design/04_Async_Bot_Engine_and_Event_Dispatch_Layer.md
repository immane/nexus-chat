---
lang: en
---

# Async Bot Engine & Event Dispatch Layer — Design Document

> nexus-chat · Slack-like IM application  
> Design date: June 2026 · Status: Draft v1.0  
> Phase 1 (Monolith) → Phase 2+ (Microservices)
> - [Bot Engine & Microservices — Research Report](../research/bot-engine-microservices.md)
>   > - [Base Bot Catalog — Research Report](../research/base-bot-catalog.md)
>   > - [AI Agent Orchestration — Research Report](../research/ai-agent-orchestration.md)

---

## Table of Contents

1. [Bot Engine Overview](#1-bot-engine-overview)
2. [Event Pipeline](#2-event-pipeline)
3. [Bot Connection Management](#3-bot-connection-management)
4. [Bot SDK Design (TypeScript)](#4-bot-sdk-design-typescript)
5. [Slash Command Framework](#5-slash-command-framework)
6. [Webhook Delivery (Phase 1.5)](#6-webhook-delivery-phase-15)
7. [Task Queue Design (BullMQ)](#7-task-queue-design-bullmq)
8. [Bot Permissions & Security](#8-bot-permissions--security)
9. [Monitoring & Observability](#9-monitoring--observability)
10. [Streaming Message Protocol Extension](#10-streaming-message-protocol-extension)
11. [Base Bot Catalog Integration](#11-base-bot-catalog-integration)

---

## 1. Bot Engine Overview

### 1.1 Purpose

The Bot Engine is responsible for receiving internal platform events, routing them to registered bots based on channel subscriptions, handling bot responses (messages, channel actions), and enforcing security boundaries. It is the central nervous system for third-party extensibility in nexus-chat.

### 1.2 Key Constraint

**Bots CANNOT access E2E-encrypted channels.** The event pipeline skips bot dispatch entirely when a channel has end-to-end encryption enabled. This is enforced at the routing layer — no event from an E2E channel ever enters the bot dispatch path.

### 1.3 Connection Modes

| Mode | Transport | Suitability | Phase |
|------|-----------|-------------|-------|
| **WebSocket** | Persistent `wss://` connection | Real-time bots (chatbots, interactive components) | Phase 1 |
| **Webhook** | HTTP POST callback | Low-frequency bots (CI/CD, monitoring, daily digests) | Phase 1.5 |

### 1.4 Event Bus Evolution

| Phase | Backend | Rationale |
|-------|---------|-----------|
| **Phase 1** | Redis Streams + Consumer Groups | Leverages existing Redis infrastructure; zero additional ops cost |
| **Phase 2+** | NATS JetStream | Subject-hierarchy filtering, persistence, replay, cross-cluster leaf nodes; <0.5 ms p50 latency |

---

## 2. Event Pipeline

### 2.1 Pipeline Diagram

```
Message Received (normal channel only)
    │
    ▼
┌─────────────────────────────────────────┐
│           Event Enrichment               │
│  Attach workspace context, channel type, │
│  member list snapshot, idempotency key   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│         Bot Subscription Router          │
│  Query bot_channel_memberships for this  │
│  channel; filter by scope permissions;   │
│  skip if channel.is_encrypted === true   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│           Event Queue (BullMQ)           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │ bot:A   │  │ bot:B   │  │ bot:C   │  │
│  │ queue   │  │ queue   │  │ queue   │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  │
│       │            │            │        │
│       ▼            ▼            ▼        │
│  Per-bot isolation; sequential process   │
└────────────────┬────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────┐
│           Bot Dispatcher                 │
│  ┌───────────────┐  ┌─────────────────┐  │
│  │ WebSocket relay│  │ Webhook poster  │  │
│  │ (push to bot's │  │ (HTTP POST +    │  │
│  │  active WS     │  │  HMAC signature)│  │
│  │  connection)   │  │                 │  │
│  └───────────────┘  └─────────────────┘  │
└────────────────┬────────────────────────┘
                 │
                 ▼
        Bot processes event
                 │
                 ▼
┌─────────────────────────────────────────┐
│         Response Handler                 │
│  Validate bot permissions, rate limits,  │
│  channel membership; apply action        │
│  (send message / create channel / etc.)  │
└─────────────────────────────────────────┘
```

### 2.2 Idempotency Guarantee

Every event carries an `idempotencyKey` of the form `{messageId}:{eventType}` (e.g., `msg_abc123:message.created`). Workers check a Redis-backed LRU deduplication cache plus a `SETNX` atomic write before processing. This prevents duplicate delivery from retries or replay.

```typescript
// packages/shared/src/events/deduplicator.ts
import Redis from 'ioredis';

const DEDUP_TTL_SECONDS = 3600;

export class EventDeduplicator {
  constructor(private redis: Redis) {}

  async tryClaim(key: string): Promise<boolean> {
    const result = await this.redis.set(
      `dedup:${key}`,
      Date.now().toString(),
      'EX', DEDUP_TTL_SECONDS,
      'NX',
    );
    return result === 'OK';
  }
}
```

### 2.3 E2E Channel Short-Circuit

```typescript
// packages/bot-engine/src/router/subscription-router.ts

export async function routeEvent(event: EnrichedEvent): Promise<void> {
  // E2E channels are invisible to bots
  const channel = await channelService.getById(event.channelId);
  if (channel.isEncrypted) {
    return; // Skip bot dispatch entirely
  }

  const subscribers = await db.botChannelMemberships.findMany({
    where: { channelId: event.channelId, revokedAt: null },
    include: { bot: true },
  });

  for (const { bot, scopes } of subscribers) {
    const requiredScope = EVENT_SCOPE_MAP[event.type];
    if (requiredScope && !scopes.includes(requiredScope)) continue;

    await queues.getBotQueue(bot.id).add(event.type, {
      botId: bot.id,
      botToken: bot.tokenHash,
      connectionMode: bot.connectionMode,
      webhookUrl: bot.webhookUrl,
      event,
    });
  }
}
```

### 2.4 Pipeline Failure Handling

| Stage | Failure | Strategy |
|-------|---------|----------|
| Enrichment | Workspace/channel not found | Drop event, log warning |
| Subscription Router | DB query timeout | Retry 3× with exponential backoff; dead-letter after exhaustion |
| Event Queue | Queue full | Drop low-priority events (typing indicators); preserve message/command events |
| Bot Dispatcher | WS connection lost | Re-queue with backoff; mark bot degraded after 5 consecutive failures |
| Response Handler | Permission denied | Return structured error to bot; do not retry |

---

## 3. Bot Connection Management

### 3.1 WebSocket Handshake

```
    Bot (SDK)                            Relay Service
       │                                      │
       │── CONNECT wss://gateway/v1/bot ─────>│
       │                                      │
       │── identity {"token":"nxbot_v1_xxx"} ─>│
       │                                      │  Verify HMAC signature
       │                                      │  Look up bot_id + scopes
       │                                      │  Register in connection pool
       │<── connected {"session_id":"s_xxx"} ──│
       │                                      │
       │── subscribe [channels...] ───────────>│  Validate bot membership
       │<── subscribed [channels...] ──────────│  per channel
       │                                      │
       │<── event message.created {...} ──────│  Events begin flowing
```

### 3.2 Connection Lifecycle

```
              ┌──────────┐
     start───>│CONNECTING│
              └────┬─────┘
                   │ WS open
                   ▼
              ┌──────────┐
              │AUTHENTIC.│──── token invalid ────> DISCONNECTED
              └────┬─────┘
                   │ identity accepted
                   ▼
              ┌──────────┐
     subscribe│SUBSCRIBED│
              └────┬─────┘
                   │
                   ▼
              ┌──────────┐
              │  ACTIVE  │<──── events pushed
              └────┬─────┘
                   │ error / timeout / close
                   ▼
              ┌──────────┐
              │ DISCONN. │── auto-reconnect (exponential backoff) ──> CONNECTING
              └──────────┘
```

### 3.3 Heartbeat

Same mechanism as user WebSocket: server expects a `PING` frame every 30 seconds. If no `PING` is received within 2× the heartbeat interval (60 s), the server closes the connection. The bot SDK automatically sends pings.

### 3.4 Connection Pool Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max concurrent bot connections per workspace | 100 | Prevent resource exhaustion; most workspaces need <20 |
| Max connections per relay instance | 5000 | Single-node WS capacity before horizontal scaling |
| Connection rate limit | 10/s per workspace | Throttle reconnect storms |

### 3.5 Auto-Reconnect (SDK Responsibility)

The bot SDK implements exponential backoff with jitter:

```typescript
// packages/bot-sdk/src/transport/reconnect.ts

export class ReconnectManager {
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: {
      maxRetries: number;      // default: 10, 0 = infinite
      initialDelayMs: number;  // default: 1000
      maxDelayMs: number;      // default: 30_000
      jitter: boolean;         // default: true
    },
  ) {}

  schedule(connect: () => Promise<void>): void {
    if (this.config.maxRetries > 0 && this.attempt >= this.config.maxRetries) {
      return; // Give up
    }

    const delay = Math.min(
      this.config.initialDelayMs * 2 ** this.attempt,
      this.config.maxDelayMs,
    );
    const jittered = this.config.jitter
      ? delay * (0.5 + Math.random() * 0.5)
      : delay;

    this.timer = setTimeout(async () => {
      this.attempt++;
      try {
        await connect();
        this.attempt = 0; // Reset on success
      } catch {
        this.schedule(connect);
      }
    }, jittered);
  }

  reset(): void {
    this.attempt = 0;
    if (this.timer) clearTimeout(this.timer);
  }
}
```

---

## 4. Bot SDK Design (TypeScript)

### 4.1 Package Structure

```
packages/bot-sdk/
├── src/
│   ├── index.ts              # Public API exports
│   ├── bot-client.ts         # NexusBot main class
│   ├── events/
│   │   └── types.ts          # BotEvent namespace (imported from @nexus-chat/shared)
│   ├── api/
│   │   ├── messages.ts       # sendMessage, editMessage, deleteMessage
│   │   ├── channels.ts       # getChannelInfo, getMemberList
│   │   └── modals.ts         # openModal (future)
│   ├── transport/
│   │   ├── ws-transport.ts   # WebSocket connection + frame protocol
│   │   └── webhook-server.ts # Inbound webhook listener (future)
│   ├── middleware/
│   │   └── pipeline.ts       # Pluggable middleware chain
│   ├── reconnect.ts          # Exponential backoff reconnect manager
│   └── rate-limiter.ts       # Token bucket + Retry-After watcher
├── package.json
└── tsconfig.json
```

### 4.2 Core API Example

```typescript
// packages/bot-sdk/src/index.ts
import { NexusBot, BotEvent } from '@nexus-chat/bot-sdk';

const bot = new NexusBot({
  token: 'nxbot_v1_xxxx',
  gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
  reconnect: { enabled: true, maxRetries: 10, backoff: 'exponential' },
});

// ── Event listeners ──────────────────────────────────

bot.on('message', async (event: BotEvent.Message) => {
  if (event.text === '/ping') {
    await bot.sendMessage(event.channel_id, 'Pong! 🏓');
  }
});

bot.on('channel_created', async (event: BotEvent.ChannelCreated) => {
  await bot.sendMessage(event.channel_id, 'Thanks for adding me!');
});

bot.on('member_joined', async (event: BotEvent.MemberJoined) => {
  await bot.sendMessage(event.channel_id, `Welcome <@${event.user_id}>!`);
});

// ── Connect ──────────────────────────────────────────
await bot.connect();
```

### 4.3 Supported Event Types

| Event | Trigger | Payload Highlights |
|-------|---------|--------------------|
| `message` | User sends a message in a subscribed channel | `channel_id`, `user_id`, `text`, `thread_id`, `mentions`, `attachments` |
| `message_edited` | User edits an existing message | `channel_id`, `message_id`, `old_text`, `new_text` |
| `message_deleted` | User deletes a message | `channel_id`, `message_id` |
| `channel_created` | A channel the bot is in is created | `channel_id`, `name`, `created_by` |
| `channel_archived` | A channel the bot is in is archived | `channel_id`, `archived_by` |
| `member_joined` | A user joins a subscribed channel | `channel_id`, `user_id` |
| `member_left` | A user leaves a subscribed channel | `channel_id`, `user_id` |
| `slash_command` | User invokes a slash command targeting this bot | `command`, `args[]`, `trigger_id`, `user_id` |
| `button_clicked` | User clicks an interactive button from this bot | `action_id`, `value`, `message_id`, `user_id` |

### 4.4 API Methods

```typescript
// packages/bot-sdk/src/api/messages.ts

export class MessageApi {
  constructor(private transport: Transport) {}

  async sendMessage(channelId: string, text: string, opts?: {
    threadId?: string;
    blocks?: Block[];
  }): Promise<Message> {
    return this.transport.call('chat.sendMessage', { channelId, text, ...opts });
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<Message> {
    return this.transport.call('chat.editMessage', { channelId, messageId, text });
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    return this.transport.call('chat.deleteMessage', { channelId, messageId });
  }

  async sendEphemeral(channelId: string, userId: string, text: string): Promise<void> {
    return this.transport.call('chat.sendEphemeral', { channelId, userId, text });
  }
}
```

### 4.5 Rate Limiting (SDK Built-In)

The SDK enforces a **token bucket** rate limiter client-side before dispatching API calls. When the server returns `429 Too Many Requests`, the SDK reads the `Retry-After` header and globally pauses all outgoing calls.

```typescript
// packages/bot-sdk/src/rate-limiter.ts

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private globalPauseUntil: number = 0;

  constructor(private config: { maxPerMinute: number }) {
    this.tokens = config.maxPerMinute;
    this.lastRefill = Date.now();
  }

  async wrap<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitIfNeeded();

    const response = await fn();
    this.consumeToken();
    return response;
  }

  handle429(retryAfterSeconds: number): void {
    this.globalPauseUntil = Date.now() + retryAfterSeconds * 1000;
  }

  private async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    // Refill tokens
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      this.config.maxPerMinute,
      this.tokens + (elapsed / 60000) * this.config.maxPerMinute,
    );
    this.lastRefill = now;

    // Respect global pause from 429
    if (now < this.globalPauseUntil) {
      await sleep(this.globalPauseUntil - now);
    }

    // Wait for token if needed
    if (this.tokens < 1) {
      const waitMs = (1 - this.tokens) / (this.config.maxPerMinute / 60000);
      await sleep(waitMs);
      this.tokens = 0;
    }
  }

  private consumeToken(): void {
    this.tokens = Math.max(0, this.tokens - 1);
  }
}
```

---

## 5. Slash Command Framework

### 5.1 Command Format

```
/botname command [args...]
```

Examples:
- `/weather tokyo`
- `/poll "Lunch?" "Pizza" "Sushi" "Salad"`
- `/deploy service-cart staging`

### 5.2 Server-Side Parsing

```typescript
// packages/bot-engine/src/commands/parser.ts

const SLASH_COMMAND_REGEX = /^\/(?<botName>\w+)\s+(?<command>\w+)(?:\s+(?<args>.+))?$/;

export function parseSlashCommand(text: string): ParsedCommand | null {
  const match = text.match(SLASH_COMMAND_REGEX);
  if (!match?.groups) return null;

  return {
    botName: match.groups.botName,
    command: match.groups.command,
    args: match.groups.args ? splitArgs(match.groups.args) : [],
  };
}

function splitArgs(raw: string): string[] {
  const args: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}
```

### 5.3 Bot Manifest — Command Registration

Each bot declares its supported commands in a manifest, stored at registration time:

```typescript
// packages/shared/src/bot/manifest.ts
import { z } from 'zod';

export const BotCommandSchema = z.object({
  name: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().max(100),
  usage: z.string().max(200).optional(),       // e.g., "/weather <city>"
  args: z.array(z.object({
    name: z.string(),
    description: z.string(),
    required: z.boolean().default(false),
    type: z.enum(['string', 'number', 'user', 'channel']),
  })).optional(),
});

export const BotManifestSchema = z.object({
  name: z.string().min(1).max(50),
  description: z.string().max(500),
  commands: z.array(BotCommandSchema).max(50),
  scopes: z.array(z.string()),
  connectionMode: z.enum(['websocket', 'webhook']),
  webhookUrl: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
});

export type BotManifest = z.infer<typeof BotManifestSchema>;
```

### 5.4 Command Dispatch Flow

```
User types /weather tokyo
        │
        ▼
┌─────────────────────────────┐
│  Parser extracts:           │
│  botName="weather"          │
│  command="" (bare /weather) │
│  args=["tokyo"]             │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  Look up bot by name in     │
│  workspace; verify bot is   │
│  in this channel; verify    │
│  command is in manifest     │
└────────────┬────────────────┘
             │
             ▼
┌─────────────────────────────┐
│  Enqueue slash_command event│
│  with trigger_id for 3s     │
│  response window            │
└────────────┬────────────────┘
             │
             ▼
     Bot processes
     /weather tokyo
             │
             ▼
     Bot responds with message
```

### 5.5 Client-Side Autocomplete

The client queries the workspace's registered bot commands for a suggestion UI:

```typescript
// packages/shared/src/api/bot-commands.ts

// GET /api/workspaces/:wsId/bot-commands
// Returns all slash commands available in this workspace
export interface BotCommandEntry {
  command: string;       // Full string: "/weather <city>"
  botName: string;       // "weather"
  description: string;   // "Get current weather for a city"
}

// The client filters and displays suggestions as the user types "/"
```

### 5.6 E2E Constraint

Slash commands for bots are **fully disabled in E2E channels**. The client disables the slash-command suggestion UI, and the server rejects any slash-command invocation targeting a bot in an encrypted channel with error code `e2e_bots_disabled`.

---

## 6. Webhook Delivery (Phase 1.5)

### 6.1 Delivery Flow

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────┐
│ Event Queue │────>│ Webhook Poster  │────>│ Bot's HTTP Server│
│ (BullMQ)    │     │                 │     │ (POST /webhook)  │
└─────────────┘     └────────┬────────┘     └──────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Delivery Tracker │
                    │ (status + retry) │
                    └─────────────────┘
```

### 6.2 Payload Format

Each webhook request is an HTTP POST with a signed JWT body:

```
POST https://bot.example.com/webhook
Content-Type: application/json
X-Nexus-Signature: t=1719000000,v1=abc123def456...
X-Nexus-Event: message.created
X-Nexus-Delivery: d_abc123
X-Nexus-Retry: 0

{
  "payload": "<signed JWT containing event data>"
}
```

### 6.3 Signature Verification (HMAC-SHA256)

```typescript
// Bot developer verifies the webhook signature
import crypto from 'node:crypto';

export function verifyWebhookSignature(
  body: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const [timestamp, signature] = signatureHeader
    .split(',')
    .map((s) => s.split('=')[1]);

  // Reject old timestamps (5 min tolerance)
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    return false;
  }

  const signedPayload = `${timestamp}.${body}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

### 6.4 Retry Policy

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1st (initial) | — | 0 s |
| 2nd | 5 s | 5 s |
| 3rd | 15 s | 20 s |
| 4th (final) | 45 s | 65 s |

After 3 failed retries, the event is moved to a **dead letter queue** and the bot is notified via its status dashboard. The delivery status is tracked per event:

```typescript
// packages/bot-engine/src/webhook/delivery-tracker.ts

interface WebhookDelivery {
  id: string;
  botId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'attempting' | 'delivered' | 'failed' | 'dead_lettered';
  attempt: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextRetryAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
}
```

---

## 7. Task Queue Design (BullMQ)

### 7.1 Queue Architecture

```
                       ┌─────────────────────┐
                       │   Event Router       │
                       │   (enqueues jobs)    │
                       └──────┬──────┬───────┘
                              │      │
              ┌───────────────┘      └───────────────┐
              ▼                                      ▼
   ┌─────────────────────┐              ┌─────────────────────┐
   │  Queue: bot:abc123   │              │  Queue: bot:def456   │
   │  ┌────┐ ┌────┐ ┌───┐ │              │  ┌────┐ ┌────┐       │
   │  │job1│ │job2│ │...│ │              │  │job1│ │job2│       │
   │  └────┘ └────┘ └───┘ │              │  └────┘ └────┘       │
   └──────────┬──────────┘              └──────────┬──────────┘
              │                                    │
              ▼                                    ▼
   ┌─────────────────────┐              ┌─────────────────────┐
   │  Worker: bot:abc123  │              │  Worker: bot:def456  │
   │  concurrency: 1      │              │  concurrency: 1      │
   └─────────────────────┘              └─────────────────────┘
              │                                    │
              ▼                                    ▼
        Bot WebSocket                        Bot Webhook
```

### 7.2 Design Principles

| Principle | Implementation |
|-----------|---------------|
| **Per-bot queue isolation** | Each bot gets its own BullMQ queue (`bot:{botId}`); a slow bot never blocks others |
| **Sequential processing** | Concurrency = 1 per bot queue; events for a single bot are processed in order |
| **Job lifecycle** | `waiting → active → completed` or `waiting → active → failed → delayed → waiting` (retry) |
| **Dead letter queue** | Jobs that exhaust all retry attempts move to `bot:{botId}:dlq` for inspection |
| **Backpressure** | Queue depth monitoring; if a bot's queue exceeds 1000 pending jobs, the bot is temporarily marked degraded |

### 7.3 Job Definition

```typescript
// packages/bot-engine/src/queues/definitions.ts

export interface BotEventJob {
  botId: string;
  connectionMode: 'websocket' | 'webhook';
  webhookUrl?: string;
  event: {
    type: BotEventType;
    idempotencyKey: string;
    workspaceId: string;
    channelId: string;
    payload: Record<string, unknown>;
    timestamp: string;
  };
}

// packages/bot-engine/src/queues/factory.ts
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';

const connection = new Redis({ maxRetriesPerRequest: null });

export function createBotQueue(botId: string): Queue<BotEventJob> {
  return new Queue<BotEventJob>(`bot:${botId}`, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: { age: 3600 },    // Clean successful jobs after 1 hour
      removeOnFail: { age: 86400 },       // Clean failed jobs after 24 hours
    },
  });
}

export function createBotWorker(
  botId: string,
  handler: (job: BotEventJob) => Promise<void>,
): Worker<BotEventJob> {
  return new Worker<BotEventJob>(
    `bot:${botId}`,
    async (job) => {
      await handler(job.data);
    },
    {
      connection,
      concurrency: 1,               // Sequential per bot
      limiter: {
        max: 10,                    // Max 10 jobs per second per bot
        duration: 1000,
      },
    },
  );
}
```

### 7.4 Dead Letter Queue

```typescript
// packages/bot-engine/src/queues/dead-letter.ts

export async function moveToDlq(
  botId: string,
  job: BotEventJob,
  error: string,
): Promise<void> {
  const dlq = new Queue<BotEventJob & { dlqError: string; dlqAt: string }>(
    `bot:${botId}:dlq`,
    { connection },
  );

  await dlq.add('dead-letter', {
    ...job,
    dlqError: error,
    dlqAt: new Date().toISOString(),
  }, {
    removeOnComplete: false,
    removeOnFail: false,  // Persist for investigation
  });
}
```

### 7.5 Metrics

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Queue depth | `bot:queue:depth` gauge (per bot) | > 1000 pending |
| Processing rate | `bot:queue:processed` counter | < 0.1/s for > 5 min |
| Failure rate | `bot:queue:failed` / `bot:queue:processed` | > 10% in 5 min window |
| DLQ size | `bot:dlq:depth` gauge | > 0 (any dead-lettered job triggers alert) |
| Avg processing time | `bot:queue:duration` histogram | p95 > 30 s |

---

## 8. Bot Permissions & Security

### 8.1 Permission Scopes

Bots declare required scopes at registration. Scopes are validated on every API call and event delivery.

| Scope | Description | Required for |
|-------|-------------|--------------|
| `messages:read` | Read messages in subscribed channels | Receiving `message` events |
| `messages:write` | Send messages to channels | `sendMessage`, `editMessage` |
| `channels:read` | Read channel metadata | `getChannelInfo` |
| `channels:manage` | Create / archive channels | `createChannel`, `archiveChannel` |
| `members:read` | Read member list | `getMemberList`, `member_joined`, `member_left` events |
| `commands` | Register and respond to slash commands | Slash command dispatch |
| `interactions` | Respond to button / modal interactions | Interactive component events |
| `files:read` | Request authorized file metadata / signed download URLs through the core Attachment Service | File-related events |
| `files:write` | Request upload sessions through the core Attachment Service | `createUploadSession`, `attachFileToMessage` |

### 8.2 Bot Token Format

```
Format:   nxbot_v1_<base64url(random_32_bytes)>
Example:  nxbot_v1_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8

┌──────────┬─────┬───────────────────────────────────────────┐
│  nxbot   │ v1  │          opaque random base64url token     │
│ (prefix) │(ver)│          hashed in DB for revocation       │
└──────────┴─────┴───────────────────────────────────────────┘
```

**Validation**: Bot tokens are opaque credentials. The server stores only `SHA256(token)` in `bot_integrations.token_hash` and performs a DB lookup on connection to resolve bot ID, workspace, scopes, revocation state, and installation policy. This is simpler to revoke and rotate than a self-contained token and avoids inconsistent "self-validation" semantics.

```typescript
// packages/bot-engine/src/auth/token.ts
import crypto from 'node:crypto';

export function generateBotToken(botId: string): string {
  // botId is associated with hashToken(token) in the database.
  // It is not embedded in the token itself.
  return `nxbot_v1_${crypto.randomBytes(32).toString('base64url')}`;
}

export function verifyTokenFormat(token: string): boolean {
  // Fast check: valid prefix and minimum length
  if (!token.startsWith('nxbot_v1_') || token.length < 30) return false;
  return true;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
```

### 8.3 Two-Tier Rate Limiting

```
Level 1: Bot-Level
  ┌──────────────────────────────────────────┐
  │  Default: 120 requests/min per bot       │
  │  Key: ratelimit:bot:{botId}:minute       │
  │  Window: sliding window (Redis ZSET)     │
  │  Response: 429 + Retry-After header      │
  └──────────────────────────────────────────┘

Level 2: Workspace-Level
  ┌──────────────────────────────────────────┐
  │  Default: 1000 events/min per workspace  │
  │  Key: ratelimit:ws:{workspaceId}:minute  │
  │  When exceeded: drop low-priority events │
  │  (typing indicators), preserve critical  │
  │  events (messages, commands)             │
  └──────────────────────────────────────────┘
```

```typescript
// packages/bot-engine/src/rate-limiter/sliding-window.ts

export class SlidingWindowRateLimiter {
  constructor(private redis: Redis) {}

  async isAllowed(
    key: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const windowStart = now - windowMs;

    const lua = `
      redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1])
      local count = redis.call('ZCARD', KEYS[1])
      if count < tonumber(ARGV[2]) then
        redis.call('ZADD', KEYS[1], ARGV[3], ARGV[3] .. ':' .. ARGV[4])
        redis.call('PEXPIRE', KEYS[1], ARGV[5])
        return {1, tonumber(ARGV[2]) - count - 1, 0}
      end
      local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2]
      return {0, 0, oldest}
    `;

    const [allowed, remaining, resetAt] = await this.redis.eval(
      lua, 1, key, windowStart, limit, now, crypto.randomUUID(), windowMs,
    ) as [number, number, number];

    return { allowed: allowed === 1, remaining, resetAt };
  }
}
```

### 8.4 Hard Restrictions

| Restriction | Enforcement Point |
|-------------|-------------------|
| Cannot join E2E channels | Channel membership API rejects bot additions to encrypted channels |
| Cannot impersonate users | Bot token cannot be used for user-scoped endpoints; `bot_id` vs `user_id` auth paths are separate |
| Cannot access other workspaces | Every query scoped by `workspace_id` from token context |
| Cannot exceed declared scopes | Scope check on every API call and event delivery |
| Cannot read DMs not part of | Bots can only be added to multi-user channels, never DMs |

### 8.5 Bot Responsibility Boundary

The platform follows a **bot-first feature model**, but bots do not own lifecycle-critical platform primitives. This keeps the core lean without delegating security-sensitive state to untrusted or replaceable services.

| Responsibility | Owner | Rationale |
|----------------|-------|-----------|
| Message persistence, delivery, edits, deletes, read state | Core IM | Fundamental IM correctness and history integrity |
| Channel / workspace membership and authorization | Core IM | Every feature depends on consistent access control |
| Search indexes for normal-mode messages | Core IM | Search is a necessary IM primitive and must honor authz/retention |
| E2EE key distribution and routing | Core IM | Encryption boundary cannot depend on bots |
| Attachment upload sessions, object keys, scan status, signed URLs, retention | Core Attachment Service | Required for authorization, malware scanning, E2E opaque blobs, and compliance |
| Bot installation, token validation, scopes, event subscriptions | Core Bot Engine | Required for safe extensibility |
| Polls, reminders, kudos, standups, CI/CD, GitHub/GitLab, AI workflows | Bots | Product workflows and integrations; safe to evolve independently |
| File-management UX (`/file upload`, `/file list`, cleanup reminders) | @FileBot | Workflow over core Attachment Service; not storage authority |

Rule of thumb: **bots may initiate workflows and render UX, but core services own data integrity, authorization, persistence, indexing, encryption boundaries, and lifecycle-critical state.**

---

## 9. Monitoring & Observability

### 9.1 OpenTelemetry Tracing

Every stage of the event pipeline emits spans, enabling end-to-end trace visualization:

```
Span: "message.created handler" (API Gateway)
├── Span: "auth.verifyToken" ──────────────── 2 ms
├── Span: "message.persist" ─────────────────── 12 ms
│   ├── Span: "db.insert" ──────────────────── 8 ms
│   └── Span: "redis.publish event" ─────────── 1 ms
├── Span: "bot.dispatch" ────────────────────── 85 ms
│   ├── Span: "router.lookupSubscribers" ────── 3 ms
│   ├── Span: "queue.enqueue bot:weather" ───── 2 ms
│   │   └── Span: "worker.process bot:weather" ─ 75 ms
│   │       └── Span: "ws.push bot:weather" ─── 5 ms
│   └── Span: "queue.enqueue bot:ci" ─────────── 1 ms
└── Span: "relay.broadcast" ──────────────────── 4 ms
```

### 9.2 Prometheus Metrics

```typescript
// packages/bot-engine/src/metrics.ts
import { Counter, Histogram, Gauge } from 'prom-client';

// Bot processing latency
export const botProcessingDuration = new Histogram({
  name: 'nexus_bot_processing_duration_seconds',
  help: 'Time from event enqueue to bot acknowledgement',
  labelNames: ['bot_id', 'event_type'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

// Bot execution counter
export const botExecutionTotal = new Counter({
  name: 'nexus_bot_execution_total',
  help: 'Total bot event processing attempts',
  labelNames: ['bot_id', 'event_type', 'status'], // success / error / timeout
});

// Active bot connections
export const botConnectionsActive = new Gauge({
  name: 'nexus_bot_connections_active',
  help: 'Number of active bot WebSocket connections',
  labelNames: ['relay_instance'],
});

// Webhook delivery duration
export const webhookDeliveryDuration = new Histogram({
  name: 'nexus_webhook_delivery_duration_seconds',
  help: 'HTTP delivery duration for webhook bots',
  labelNames: ['bot_id', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

// Queue depth per bot
export const botQueueDepth = new Gauge({
  name: 'nexus_bot_queue_depth',
  help: 'Number of pending jobs in a bot queue',
  labelNames: ['bot_id', 'queue_name'],
});

// Dead letter queue depth
export const botDlqDepth = new Gauge({
  name: 'nexus_bot_dlq_depth',
  help: 'Number of dead-lettered jobs for a bot',
  labelNames: ['bot_id'],
});

// Rate limit hits
export const botRateLimitHits = new Counter({
  name: 'nexus_bot_rate_limit_hits_total',
  help: 'Times a bot hit the rate limit',
  labelNames: ['bot_id', 'workspace_id'],
});

// Reconnect count
export const botReconnectTotal = new Counter({
  name: 'nexus_bot_reconnect_total',
  help: 'Total WebSocket reconnection attempts',
  labelNames: ['bot_id'],
});
```

### 9.3 Alerting Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| Bot disconnected > 5 min | `nexus_bot_connections_active{bot_id}` = 0 for 5 min | **Warning** | Notify workspace admins; check bot logs |
| Bot queue depth > 1000 | `nexus_bot_queue_depth` > 1000 | **Critical** | Mark bot degraded; throttle incoming events for that bot |
| Bot error rate > 10% | `rate(nexus_bot_execution_total{status="error"}[5m])` / `rate(nexus_bot_execution_total[5m])` > 0.1 | **Warning** | Inspect dead letter queue; notify bot developer |
| Dead letter queue non-empty | `nexus_bot_dlq_depth` > 0 | **Info** | Review failed events; consider manual replay |
| Webhook failure rate > 20% | Failed deliveries / total > 0.2 in 15 min | **Warning** | Check bot's webhook endpoint health |
| Relay instance connection saturation | `nexus_bot_connections_active` > 4500 per instance | **Critical** | Scale relay-service horizontally |

### 9.4 Dashboard Layout

A dedicated Grafana dashboard for the Bot Engine provides four panels:

1. **Bot Health Overview** — Active connections gauge, error rate time-series, P50/P95/P99 processing latency
2. **Queue Status** — Per-bot queue depth heatmap, processing rate (jobs/s), DLQ accumulation
3. **Webhook Delivery** — Success rate, latency histogram by status code, retry count
4. **Rate Limiting** — Rate-limit hit count per bot, per workspace; top-10 rate-limited bots

### 9.5 Structured Logging

All bot engine components use Pino with trace context injection:

```typescript
// packages/bot-engine/src/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  mixin() {
    return {
      component: 'bot-engine',
    };
  },
});

// Key event logging
logger.info({ botId, eventType: 'message.created', channelId }, 'Dispatching event to bot');
logger.warn({ botId, queueDepth: 1050 }, 'Bot queue depth exceeds threshold');
logger.error({ err, botId, eventType, attempt: 3 }, 'Bot event delivery exhausted retries');
```

---

## 10. Streaming Message Protocol Extension

### 10.1 Motivation

Standard IM is message-at-a-time, but the AI Assistant Bot produces output token-by-token via LLM streaming. nexus-chat extends its existing Socket.IO protocol with three new event types to support progressive message updates visible in the chat UI. This is the first mature streaming message primitive in any public IM platform API — a key differentiator.

### 10.2 New Event Types

#### 10.2.1 stream_start

Sent when AI begins generating a response. Creates a placeholder message in the channel UI.

```typescript
// Server → Client
{
  type: "message.stream_start",
  channelId: string,
  workspaceId: string,
  payload: {
    streamId: string,              // UUID v7
    botId: string,
    parentMessageId?: string,      // The user message that triggered this
    threadId?: string,
    placeholderMessageId: string,   // Pre-allocated message ID
    estimatedTokens?: number,      // For progress bar
  },
  timestamp: number,
}
```

#### 10.2.2 stream_chunk

Carries a batched text delta. Appended to the placeholder message. Sent every ~100ms.

```typescript
// Server → Client
{
  type: "message.stream_chunk",
  channelId: string,
  payload: {
    streamId: string,
    chunkIndex: number,    // 0-based, monotonically increasing
    content: string,       // Text delta (batched tokens)
    tokenCount: number,    // Cumulative tokens so far
    toolCall?: {           // Optional: the model called a tool
      toolCallId: string,
      toolName: string,
      arguments: string,   // Partial JSON
    },
    toolResult?: {         // Optional: tool call result
      toolCallId: string,
      result: string,
    },
  },
}
```

#### 10.2.3 stream_end

Sent when generation completes, is cancelled, or errors.

```typescript
// Server → Client
{
  type: "message.stream_end",
  channelId: string,
  payload: {
    streamId: string,
    messageId: string,
    status: "completed" | "cancelled" | "error",
    usage?: {
      promptTokens: number,
      completionTokens: number,
      totalTokens: number,
    },
    error?: {
      code: string,
      message: string,
    },
  },
}
```

#### 10.2.4 stream_cancel (Client → Server)

User clicks [Cancel] during generation.

```typescript
// Client → Server
{
  type: "message.stream_cancel",
  channelId: string,
  payload: { streamId: string },
}
```

### 10.3 Chunk Batching Strategy

The ChunkBatcher buffers individual tokens and flushes them in batches for efficient WebSocket delivery:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max chunk interval | 100ms | Human perception threshold; <100ms feels instantaneous |
| Flush on newline | Yes | Natural break points for progressive markdown rendering |
| Max chunk size | 500 chars | Prevents oversized chunks on fast models |

```typescript
// packages/bot-engine/src/streaming/chunk-batcher.ts

export class ChunkBatcher {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chunkIndex = 0;

  constructor(
    private emit: (chunk: { chunkIndex: number; content: string }) => void,
    private config = { maxIntervalMs: 100, flushOnNewline: true, maxChars: 500 },
  ) {}

  push(token: string): void {
    this.buffer.push(token);
    if (this.config.flushOnNewline && token.includes("\n")) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.config.maxIntervalMs);
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const content = this.buffer.join("").slice(0, this.config.maxChars);
    this.buffer = [];
    this.emit({ chunkIndex: this.chunkIndex++, content });
  }
}
```

### 10.4 Generation Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max output tokens per generation | 4096 | Covers IM use cases; prevents runaway |
| Max generation wall time | 60s | Hard deadline; cancels stream if exceeded |
| Max concurrent streams per workspace | 10 | Prevents abuse |
| Max streams per user | 3 | One per channel/thread is reasonable |
| Max total input context tokens | 32K | Balances richness with cost |

### 10.5 E2E Channel Constraint

Streaming is disabled for E2E channels, consistent with the global bot restriction. The server rejects stream_start attempts in E2E channels with error code `e2e_streaming_disabled`.

## 11. Base Bot Catalog Integration

### 11.1 Overview

nexus-chat ships with a curated set of first-party bots that provide essential IM functionality out of the box. These bots serve double duty: they deliver immediate user value AND act as reference implementations for the public Bot SDK.

### 11.2 MVP Bot Roster (Phase 1)

| # | Bot | Category | Key Commands | Storage Req. |
|---|-----|----------|--------------|-------------|
| 1 | **Welcome Bot** | System/Onboarding | `/welcome preview`, `/welcome set-channel`, `/welcome test` | Yes — templates, channel mappings |
| 2 | **Help Bot** | System | `/help`, `/help <topic>`, `/help faq` | Yes — FAQ entries, doc index |
| 3 | **Notification Bot** | System | `/announce`, `/announce all`, `/announce schedule` | Yes — announcement history |
| 4 | **Reminder Bot** | Productivity | `/remind`, `/reminders list`, `/reminders cancel` | Yes — active reminders |
| 5 | **Poll Bot** | Productivity | `/poll`, `/quickpoll`, `/poll results`, `/poll close` | Yes — active polls, votes |
| 6 | **Webhook Bot** | Developer | `/webhook create`, `/webhook list`, `/webhook test` | Yes — webhook URLs, templates |
| 7 | **Kudos Bot** | Culture | `/kudos`, `/kudos leaderboard`, `/kudos stats` | Yes — kudos records, leaderboard |

### 11.3 Bot Implementation Model

All first-party bots use the same `@nexus-chat/bot-sdk` as third-party developers:

```typescript
// Example: Poll Bot (packages/bots/poll-bot/src/index.ts)
import { NexusBot } from '@nexus-chat/bot-sdk';

const bot = new NexusBot({
  token: process.env.POLL_BOT_TOKEN!,
  gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
});

bot.on('message', async (event) => {
  const cmd = parseSlashCommand(event.text);
  if (cmd?.botName !== 'poll') return;

  switch (cmd.command) {
    case '': { // /poll "Question" "Opt1" "Opt2" ...
      const poll = await createPoll(event.channel_id, cmd.args);
      await bot.sendMessage(event.channel_id, formatPollCard(poll));
      break;
    }
    case 'results':
      await bot.sendMessage(event.channel_id, formatPollResults(cmd.args[0]));
      break;
    case 'close':
      await closePoll(cmd.args[0]);
      await bot.sendMessage(event.channel_id, 'Poll closed.');
      break;
  }
});

bot.on('message.reaction_added', async (event) => {
  // Track emoji reaction as poll vote
  await recordVote(event.message_id, event.user_id, event.emoji);
});

await bot.connect();
```

### 11.4 Bot Storage Architecture

Bots requiring persistent state use two tiers:

| Tier | Technology | Use Case |
|------|-----------|----------|
| **Bot KV Store** | Redis, scoped via `bot.kv.get/set/delete(key)` | Simple key-value state (settings, counters, preference flags) |
| **Bot Database Tables** | PostgreSQL + Drizzle ORM, namespaced per bot | Complex relational data (polls, votes, reminders, kudos records) |

### 11.5 Phase Rollout Plan

| Phase | Bots | Timeline |
|-------|------|----------|
| **Phase 1 (MVP)** | Welcome, Help, Notification, Reminder, Poll, Webhook, Kudos | Launch |
| **Phase 2** | Todo, GitHub/GitLab, CI/CD, Standup, AI Assistant, Celebration, Feedback | +3 months |
| **Phase 3** | Status, Scheduler, Meeting Notes, AutoMod, Bot Marketplace | +6 months |

---

> **Related Documents**:
> - [Bot Engine & Microservices — Research Report](../research/bot-engine-microservices.md)
> - [Backend IM State Machine](../research/backend-im-state-machine.md)
> - [Base Bot Catalog — Research Report](../research/base-bot-catalog.md)
> - [AI Agent Orchestration — Research Report](../research/ai-agent-orchestration.md)
> - [Design: AI Agent & Streaming Engine](05_AI_Agent_Orchestration_and_Streaming.md)
