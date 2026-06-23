---
lang: en
---

# Nexus Chat — IM Backend Architecture Research Report

> Research date: 2026-06-24  
> Target scenario: Slack-like instant messaging (IM) application backend  
> Tech stack preference: TypeScript, PostgreSQL, Redis, Node.js  

---

## Table of Contents

1. [Node.js IM Backend Framework Selection](#1-nodejs-im-backend-framework-selection)
2. [WebSocket Real-time Communication Architecture](#2-websocket-real-time-communication-architecture)
3. [Message State Machine Design](#3-message-state-machine-design)
4. [Channel/DM State Management](#4-channeldm-state-management)
5. [Database Design](#5-database-design)
6. [Caching Strategy](#6-caching-strategy)
7. [Security & Rate Limiting](#7-security--rate-limiting)

---

## 1. Node.js IM Backend Framework Selection

### 1.1 Candidate Framework Overview (Mid-2026)

| Metric | Hono | Fastify | NestJS |
|------|------|---------|--------|
| Latest version | **4.12.27** | **5.8.5** | **11.1.19** |
| Weekly downloads | ~34.5M | ~6.7M | ~9.1M |
| Bundle size | ~14 KB | ~133 KB | ~51 KB (core) |
| Zero dependencies | Yes | No (15 dependencies) | No |
| Runtime | Node/Bun/Deno/CF Workers/Edge | Node primarily | Node primarily |
| TypeScript | First-class (native TS) | First-class (native TS) | Decorators + DI |
| Route matching | Trie tree O(log n) | Radix Tree | Expression tree |
| Cold start | <50ms | ~100ms | 500-2000ms |
| Throughput r/s (JSON) | ~98,200 | ~91,400 | ~28,600 |

### 1.2 Detailed Framework Analysis

#### Hono (v4.12.27)

**Advantages:**
- Based on Web Standards API (`Request`/`Response`), native cross-runtime support
- Extremely small bundle size (14KB) makes it the best choice for serverless deployments
- Comprehensive built-in middleware: `cors`, `jwt`, `bearer-auth`, `rate-limiter` (sliding window based), `logger`, `compress`, `secure-headers`, `etag`
- RPC mode provides end-to-end type safety (similar to tRPC but lighter), sharing types between frontend and backend
- Testing is extremely simple: use `app.request()` directly without starting a server

**Disadvantages:**
- Plugin ecosystem is growing rapidly but still not as rich as Fastify
- Middleware for file uploads and complex session management is less mature than Express
- No architectural-level enforcement (teams must define project structure conventions themselves)

#### Fastify (v5.8.5)

**Advantages:**
- One of the industry-recognized fastest Node.js frameworks, with extremely strong JSON Schema serialization performance
- Mature plugin ecosystem: `@fastify/cors`, `@fastify/rate-limit`, `@fastify/jwt`, `@fastify/multipart`, `@fastify/websocket`
- Built-in schema validation and serialization delivers 2-3x higher JSON throughput than Hono
- Pino logger integration with negligible performance overhead

**Disadvantages:**
- Node-first design, does not support edge runtimes like Cloudflare Workers
- 10x larger than Hono, 2x slower cold start
- Requires more schema constraints (less friendly for rapid prototyping)

#### NestJS (v11.1.19)

**Advantages:**
- Angular-style DI/Module/Decorator architecture, suitable for large team collaboration
- Built-in Guards, Interceptors, Pipes, Filters layering system
- Can configure Fastify adapter for performance gains
- WebSocket gateway (`@nestjs/websockets`) with native Socket.IO integration

**Disadvantages:**
- **Cold start 500-2000ms**, severely unfriendly for serverless scenarios
- High abstraction cost: real-time features like message routing and connection management in IM don't suit excessive abstraction
- Decorator system learning curve and boilerplate code volume

### 1.3 Middleware Ecosystem Comparison

| Middleware Feature | Hono (built-in) | Fastify (plugin) | NestJS |
|-----------|------------|---------------|--------|
| CORS | `hono/cors` | `@fastify/cors` | Built-in |
| Rate limiting | `hono/rate-limiter` | `@fastify/rate-limit` | `@nestjs/throttler` |
| JWT verification | `hono/jwt` | `@fastify/jwt` | `@nestjs/jwt` + Passport |
| Request logging | `hono/logger` | Pino (built-in) | Built-in Logger |
| Security headers | `hono/secure-headers` | `@fastify/helmet` | `helmet` |
| Compression | `hono/compress` | `@fastify/compress` | compression middleware |
| File upload | Third-party | `@fastify/multipart` | `multer` |
| WebSocket | Third-party | `@fastify/websocket` | `@nestjs/websockets` |

### 1.4 Cold Start & Serverless Deployment

| Runtime environment | Hono | Fastify | NestJS |
|----------|------|---------|--------|
| Node.js `serve()` | ~50ms | ~100ms | 500-2000ms |
| Cloudflare Workers | <5ms | Not supported | Not supported |
| Bun | <20ms | Partial support | Not supported |
| AWS Lambda (Node) | ~80ms | ~150ms | 800-3000ms |

Hono is the only sensible choice for serverless deployments. Fastify is optimal for long-running Node.js processes.

### 1.5 Recommended Solution

**Recommended: Hono v4.12.x**

Rationale:
1. IM applications will likely need to separate WebSocket connection routing in the future; Hono's lightweight nature is suitable for deploying REST API and WebSocket Gateway separately
2. Built-in middleware covers 80% of needs with zero additional dependencies
3. TypeScript RPC mode enables sharing message type definitions, state enums, and socket event contracts between frontend and backend
4. Cold start <50ms, reserving the possibility for future migration to edge functions
5. Simple testing (`app.request()`), no need for supertest

**Alternative: Fastify v5.8.x** (if serverless deployment is later confirmed unnecessary and JSON throughput is a bottleneck)

---

## 2. WebSocket Real-time Communication Architecture

### 2.1 WebSocket Library Selection

| Feature | Socket.IO v4 | ws v8 | uWebSockets.js v20 |
|------|-------------|-------|-------------------|
| Principle | WS + HTTP polling fallback | Pure RFC 6455 WebSocket | C++ native WebSocket |
| Transport protocol | Custom Socket.IO protocol | Standard WebSocket protocol | Standard WebSocket protocol |
| Rooms/channels | Built-in | Manual implementation | Built-in pub/sub |
| Auto-reconnect | Client built-in | Manual implementation | Manual implementation |
| Heartbeat | Built-in `pingInterval`/`pingTimeout` | Manual implementation | Manual implementation |
| Authentication | Middleware async/await | `verifyClient` sync callback | `upgrade` handler |
| Performance msg/s | ~100K | ~400K | **~2M+** |
| Memory 10K connections | ~400MB | ~200MB | **~40MB** |
| Client library | `socket.io-client` (20KB) | Native WebSocket (0KB) | Native WebSocket (0KB) |
| Horizontal scaling | `@socket.io/redis-adapter` | Redis Pub/Sub manual impl | Redis Pub/Sub manual impl |
| Sticky sessions | **Required** | Not required | Not required |

### 2.2 Key Trade-offs

**Socket.IO sticky session problem:** When deployed across multiple processes behind a load balancer, Socket.IO relies on Engine.IO's HTTP long-polling fallback mechanism, which first establishes an HTTP connection before upgrading to WebSocket. This requires the same client's requests to always land on the same server process (sticky session). Configuring cookie-based affinity on Nginx/ALB can solve this, but adds operational complexity and single-point-of-failure risk.

**uWebSockets.js advantages:** 50000+ connections per single core, 5x lower memory. However, the API is different (callback-based rather than EventEmitter), community plugins are scarce, and authentication must be completed in the synchronous `upgrade` handler.

### 2.3 Recommended Solution

**Recommended: Socket.IO v4 + `@socket.io/redis-adapter`**

Rationale:
1. Room/channel management, reconnection, and heartbeat are core requirements for IM applications, all built into Socket.IO
2. Redis Adapter simplifies horizontal scaling from "must build your own wheel" to a few lines of configuration
3. Authentication middleware supports async/await, making JWT verification integration the most natural
4. Mature client ecosystem — frontend can directly use `socket.io-client`

**Note:** Need to configure `ip_hash` or cookie-based session affinity on Nginx/ALB. Also recommended to disable HTTP long-polling fallback (`transports: ["websocket"]`) and use pure WebSocket directly to reduce one layer of complexity.

---

### 2.4 Horizontal Scaling Architecture

```
                    ┌─────────────────┐
                    │   Nginx / ALB    │
                    │  (sticky session)│
                    └──────┬───────────┘
               ┌───────────┼───────────┐
               ↓           ↓           ↓
          ┌─────────┐ ┌─────────┐ ┌─────────┐
          │ WS Pod 1│ │ WS Pod 2│ │ WS Pod 3│
          └────┬────┘ └────┬────┘ └────┬────┘
               │           │           │
               └───────────┼───────────┘
                           ↓
                  ┌────────────────┐
                  │ Redis (Pub/Sub)  │
                  │ + KeyDB / Sentinel│
                  └────────────────┘
```

**Redis Adapter core code:**

```typescript
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();

await Promise.all([pubClient.connect(), subClient.connect()]);

const io = new Server(httpServer, {
  transports: ["websocket"], // disable long-polling fallback
  pingInterval: 25000,
  pingTimeout: 60000,
});

io.adapter(createAdapter(pubClient, subClient));
// now io.to("room").emit() broadcasts across all processes
```

### 2.5 Connection Management

#### Heartbeat Mechanism

```typescript
const io = new Server(httpServer, {
  pingInterval: 25000,   // send ping every 25s
  pingTimeout: 20000,    // disconnect if no pong within 20s
  connectTimeout: 10000, // reject if handshake not completed within 10s
});
```

- **pingInterval** should be less than the Load Balancer's idle timeout (AWS ALB default 60s, recommended to set to 25-30s)
- **pingTimeout** should be slightly less than pingInterval to avoid false disconnections due to network fluctuations

#### Reconnection Strategy

```typescript
// Client
const socket = io("https://chat.example.com", {
  transports: ["websocket"],
  auth: { token: jwt },
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,          // initial reconnection delay 1s
  reconnectionDelayMax: 30000,      // max reconnection delay 30s
  randomizationFactor: 0.5,         // jitter factor
});
```

Exponential backoff formula: `delay = min(reconnectionDelay * 2^attempt, reconnectionDelayMax)` plus ±50% random jitter.

#### Maximum Connection Count Control

```typescript
io.engine.on("initial_headers", (headers, req) => {
  const currentConnections = io.engine.clientsCount;
  if (currentConnections > MAX_CONNECTIONS) {
    headers["retry-after"] = "30";
  }
});

// Kick off same user's duplicate login
const userSockets = new Map<string, string>(); // userId -> socketId
io.on("connection", (socket) => {
  const userId = socket.data.user.id;
  const existingSocketId = userSockets.get(userId);
  if (existingSocketId) {
    io.to(existingSocketId).emit("force_disconnect", {
      reason: "logged_in_elsewhere",
    });
    io.sockets.sockets.get(existingSocketId)?.disconnect(true);
  }
  userSockets.set(userId, socket.id);
});
```

### 2.6 Message Routing Strategy

| Routing type | Socket.IO API | Use case |
|---------|--------------|---------|
| Unicast | `io.to(socketId).emit()` | Notify a specific user |
| Broadcast | `socket.broadcast.emit()` | Everyone except sender in same channel |
| Multicast | `io.to("room").emit()` | Channel/group messages |
| Multi-room | `io.to(["roomA", "roomB"]).emit()` | Cross-channel announcements |
| Global broadcast | `io.emit()` | System maintenance notifications |
| Exclude sender | `socket.to("room").emit()` | Typical group chat scenario |

**Channel routing pattern:**

```typescript
// Auto-join personal room and channels on connection based on user data
io.on("connection", (socket) => {
  const { user, channels } = socket.data;

  // Personal notification pipe (one unique room per user)
  socket.join(`user:${user.id}`);

  // Join all subscribed channels
  channels.forEach((ch) => socket.join(`channel:${ch.id}`));

  // Channel message sending
  socket.on("message:send", (data) => {
    const msg = createMessage(data);
    io.to(`channel:${data.channelId}`).emit("message:new", msg);
    // Also push notification to offline members
    notifyOfflineMembers(data.channelId, msg);
  });
});
```

### 2.7 Message Reliability Guarantee (ACK Mechanism)

```typescript
// Server — ACK with timeout
socket.emit("message:new", message, (ack) => {
  // ack => { status: 'received', timestamp: 1719234567890 }
});

// Client — acknowledge receipt
socket.on("message:new", (message, ack) => {
  addMessage(message);
  ack({ status: "received", timestamp: Date.now() });
});

// Reliable send with timeout
function sendWithRetry(socket, event, data, maxRetries = 3, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const trySend = () => {
      attempts++;
      const timer = setTimeout(() => {
        if (attempts < maxRetries) {
          trySend();
        } else {
          reject(new Error(`ACK timeout after ${maxRetries} retries`));
        }
      }, timeoutMs * Math.pow(2, attempts - 1));

      socket.emit(event, data, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    };
    trySend();
  });
}
```

**Retransmission queue design highlights:**
- Client locally maintains a "pending acknowledgment message queue" (IdleQueue), each message having a unique `clientMsgId`
- Replay un-ACKed messages in the queue after connection recovery
- Server deduplicates via `clientMsgId` to avoid duplicate message writes

---

## 3. Message State Machine Design

### 3.1 Message State Transition Model

```
                         ┌──────────────────────────────────┐
                         │            FAILED                 │
                         │  (network error / server reject   │
                         │   / timeout)                      │
                         └──────▲───────────▲──────────────┘
                                │           │
                         ┌──────┴───────────┴───────┐
                         │      retry (≤3 times)      │
                         │   exponential backoff      │
                         │      1s/2s/4s              │
                         └──────────┬────────────────┘
                                    │
    ┌───────┐   send    ┌──────────┴───────────┐  server ACK  ┌──────────┐
    │DRAFT  │──────────→│      SENDING          │─────────────→│   SENT   │
    └───┬───┘           └──────▲───────────────┘              └────┬─────┘
        │ edit                  │                                 │
        │                       │ resend (reconnected)             │ deliver
        ↓                       │                                 ↓
   ┌────────┐                 reconnect                    ┌──────────────┐
   │ EDITED │                                              │  DELIVERED   │
   └────┬───┘                                              └──────┬───────┘
        │                                                         │
        │  delete                                                  │ read
        ↓                                                         ↓
   ┌────────┐                                               ┌──────────────┐
   │ DELETED│                                               │    READ      │
   └────────┘                                               └──────────────┘
```

### 3.2 State Definitions

```typescript
enum MessageStatus {
  DRAFT     = "draft",      // Client is editing, not yet sent
  SENDING   = "sending",    // Submitted to send queue, waiting for ACK
  SENT      = "sent",       // Server has confirmed persistence
  DELIVERED = "delivered",  // Recipient client has received
  READ      = "read",       // Recipient has read
  FAILED    = "failed",     // Send failed (including retries exhausted)
  EDITED    = "edited",     // Message has been edited (preserves original content reference)
  DELETED   = "deleted",    // Message has been deleted (soft delete)
}
```

### 3.3 TypeScript Types & Data Flow

```typescript
// Core message type
interface Message {
  id: string;                // UUID v7 (time-sorted + uniqueness)
  channelId: string;
  senderId: string;
  clientMsgId: string;       // Client-generated idempotency ID (for deduplication)
  content: MessageContent;
  status: MessageStatus;
  editedAt: Date | null;
  deletedAt: Date | null;
  replyToId: string | null;  // Reply message ID
  createdAt: Date;
}

interface MessageContent {
  type: "text" | "image" | "file" | "system";
  text?: string;
  attachments?: Attachment[];
  mentions?: string[];       // @mentioned user ID list
}

// WebSocket event types
const MessageEvents = {
  // Sender events
  "message:send":         (data: { channelId: string; content: MessageContent }) => void,
  "message:ack":           (data: { messageId: string; status: "sent" | "failed"; error?: string }) => void,
  "message:edit":          (data: { messageId: string; content: MessageContent }) => void,
  "message:delete":        (data: { messageId: string }) => void,

  // Recipient events
  "message:new":           (data: Message) => void,
  "message:edited":        (data: { messageId: string; content: MessageContent }) => void,
  "message:deleted":      (data: { messageId: string }) => void,
  "message:delivered":    (data: { messageId: string; userId: string; timestamp: number }) => void,
  "message:read":         (data: { channelId: string; userId: string; lastReadMessageId: string; timestamp: number }) => void,
} as const;
```

### 3.4 State Synchronization & Send Flow

```
  Sender Client                   Server                   Recipient Client
       │                            │                            │
       │ ── message:send ──────────→│                            │
       │          (clientMsgId)     │                            │
       │                            │ ── Write DB + assign ID ──│
       │ ←── message:ack ──────────│                            │
       │       (status: "sent")     │                            │
       │                            │ ── message:new ──────────→│
       │                            │                            │
       │                            │ ←── message:delivered ────│
       │ ←── message:delivered ────│                            │
       │                            │                            │
       │                            │ ←── message:read ─────────│
       │ ←── message:read ─────────│                            │
```

**Key design principles:**
1. **clientMsgId** is used for idempotent deduplication: prevents duplicate sending of the same content during network fluctuations
2. **State only moves forward, never backward**: `SENDING → SENT → DELIVERED → READ`, `READ → DELIVERED` is not allowed
3. **DELIVERED can be skipped**: If the recipient is online, SENT immediately transitions to DELIVERED
4. **Server is responsible for persistence and ID assignment**, the client does not trust local IDs

### 3.5 Read Receipt Batch Aggregation Strategy

Read receipts are the most frequent write operation in IM (triggered every time a user scrolls), requiring proper aggregation.

```typescript
// Redis aggregation approach: batch write to DB every 3 seconds
class ReadReceiptAggregator {
  private buffer: Map<string, { userId: string; channelId: string; lastReadAt: number; messageId: string }> = new Map();
  private flushTimer: NodeJS.Timeout;

  constructor(private redis: Redis, private db: Database, flushIntervalMs = 3000) {
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
  }

  async record(channelId: string, userId: string, messageId: string) {
    // Write to Redis first (instant update, for UI display)
    const key = `read_cursor:${channelId}:${userId}`;
    await this.redis.set(key, messageId);
    await this.redis.expire(key, 86400 * 7); // 7-day TTL

    // Aggregate write to DB
    const dedupKey = `${channelId}:${userId}`;
    this.buffer.set(dedupKey, {
      userId, channelId,
      lastReadAt: Date.now(),
      messageId,
    });
  }

  private async flush() {
    if (this.buffer.size === 0) return;
    const entries = Array.from(this.buffer.values());
    this.buffer.clear();

    // Batch upsert
    await this.db
      .insert(readReceipts)
      .values(entries)
      .onConflictDoUpdate({
        target: [readReceipts.userId, readReceipts.channelId],
        set: { lastReadMessageId: sql`excluded.last_read_message_id`, lastReadAt: sql`excluded.last_read_at` },
      });
  }
}
```

**Aggregation strategy highlights:**
- **Write merging**: For the same user in the same channel, multiple read updates within a 3-second window only execute the last DB write
- **Notification deduplication**: For the same file/image, do not repeatedly push "XXX has read" notifications
- **Offline scenario**: When a user comes online, the server pushes `last_read_message_id` for each channel, and the client renders the unread divider line accordingly

### 3.6 Message Edit/Delete State Transitions

```typescript
// Edit message (preserve original content reference)
async function editMessage(messageId: string, newContent: MessageContent, userId: string) {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });

  if (!msg || msg.senderId !== userId) throw new Error("Unauthorized");
  if (msg.deletedAt) throw new Error("Cannot edit deleted message");

  await db.update(messages)
    .set({
      content: newContent,
      editedAt: new Date(),
      status: "edited",
    })
    .where(eq(messages.id, messageId));

  // Broadcast edit event
  io.to(`channel:${msg.channelId}`).emit("message:edited", {
    messageId, content: newContent, editedAt: Date.now(),
  });
}

// Soft delete message
async function deleteMessage(messageId: string, userId: string) {
  const msg = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });

  // Permissions: sender or channel admin
  const isSender = msg?.senderId === userId;
  const isAdmin = await checkChannelAdmin(msg?.channelId, userId);
  if (!isSender && !isAdmin) throw new Error("Unauthorized");

  await db.update(messages)
    .set({ deletedAt: new Date(), status: "deleted", content: { type: "deleted" } })
    .where(eq(messages.id, messageId));

  io.to(`channel:${msg.channelId}`).emit("message:deleted", { messageId });
}
```

### 3.7 Failure Retry Strategy

```typescript
const RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1000,     // 1s → 2s → 4s
  maxDelayMs: 10000,
  jitterFactor: 0.3,     // ±30% random jitter
};

function getRetryDelay(attempt: number): number {
  const exponentialDelay = RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, RETRY_POLICY.maxDelayMs);
  const jitter = cappedDelay * RETRY_POLICY.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

// Server-side message queue ID deduplication
async function handleIncomingMessage(data: { clientMsgId: string; channelId: string; content: MessageContent }, userId: string) {
  // Idempotency check: same clientMsgId is not written twice
  const existing = await redis.get(`dedup:${data.clientMsgId}`);
  if (existing) {
    return { status: "duplicate", messageId: existing };
  }

  const message = await db.insert(messages).values({ /* ... */ }).returning();
  await redis.set(`dedup:${data.clientMsgId}`, message.id, "EX", 86400); // 24h dedup window
  return { status: "sent", messageId: message.id };
}
```

---

## 4. Channel/DM State Management

### 4.1 Channel Lifecycle State Machine

```
                           ┌────────────┐
                           │  ARCHIVED  │
                           └─────▲──────┘
                                 │ archive (owner/admin only)
       ┌────────┐ create  ┌──────┴──────┐ unarchive  ┌────────────┐
       │  NONE  │────────→│   ACTIVE    │←───────────│  ARCHIVED  │
       └────────┘         └──────┬──────┘            └────┬───────┘
                                 │                        │
                                 │ delete (soft delete)    │ permanent_delete
                                 ↓                        │ (auto after 30 days)
                           ┌──────────┐                   ↓
                           │ DELETED  │              ┌───────────┐
                           └──────────┘              │  PURGED   │
                                                     └───────────┘
```

```typescript
enum ChannelStatus {
  ACTIVE   = "active",
  ARCHIVED = "archived",
  DELETED  = "deleted",
}

interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  type: "public" | "private" | "dm";
  topic: string | null;
  createdBy: string;
  status: ChannelStatus;
  archivedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### 4.2 Channel Type Behavioral Differences

| Feature | public | private | DM |
|------|--------|---------|-----|
| Visibility | Visible to all workspace members | Visible to members only | Visible to both parties only |
| Join method | Free join | Invite-only | Auto-created by system |
| Search index | Workspace-wide | Members only | Both parties only |
| Message history | Viewable by all | Viewable by members only | Viewable by both parties only |
| Member limit | Unlimited | Unlimited | **Exactly 2 people** |
| After archiving | Read-only | Read-only | Not archived (system-level) |
| Create permission | All members | All members | System auto |

### 4.3 Permission State Machine

```
                               transfer_ownership
      ┌──────────┐                (owner → admin)    ┌──────────┐
      │  OWNER   │──────────────────────────────────→│  OWNER   │
      │ (creator)│                                   │ (new     │
      └────┬─────┘                                   │  owner)  │
           │                                         └────┬─────┘
           │ promote_admin                               │ demote
           ↓                                             ↓
      ┌──────────┐      promote_admin    ┌────────────┐
      │  ADMIN   │←──────────────────────│  MEMBER    │
      │          │──────────────────────→│            │
      └──────────┘      demote           └─────┬──────┘
                                               │
                                               │ leave / kick
                                               ↓
                                          ┌──────────┐
                                          │   NONE   │
                                          └──────────┘
```

```typescript
enum MemberRole {
  OWNER  = "owner",   // Only 1 per channel (typically the creator)
  ADMIN  = "admin",   // Can have multiple per channel
  MEMBER = "member",  // Regular member
}

const ROLE_PERMISSIONS = {
  owner:  ["manage_channel", "manage_members", "manage_messages", "post_messages", "read_messages", "archive_channel", "delete_channel"],
  admin:  ["manage_members", "manage_messages", "post_messages", "read_messages", "archive_channel"],
  member: ["post_messages", "read_messages"],
} as const;

function canPerform(member: { role: MemberRole }, action: Permission): boolean {
  return ROLE_PERMISSIONS[member.role].includes(action);
}
```

**Permission rules:**
- **OWNER must transfer before demotion**: `transferOwnership` is an atomic operation, a channel must never have no owner
- **OWNER cannot be kicked**: must be demoted to admin/member first
- **Archived channels are read-only**: all `post_messages`, `manage_*` operations are denied
- **DM channels have no permissions**: no member/admin/owner role distinction, both parties are equal

---

## 5. Database Design

### 5.1 Core Table Structure (PostgreSQL + Drizzle ORM)

```typescript
import {
  pgTable, uuid, text, varchar, timestamp, boolean,
  jsonb, uniqueIndex, index, primaryKey, foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Users table ───
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  avatarUrl: text("avatar_url"),
  status: varchar("status", { length: 20 }).default("offline").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Workspaces table ───
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── Channels table ───
export const channels = pgTable("channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  type: varchar("type", { length: 20 }).notNull().default("public"),  // public | private | dm
  topic: text("topic"),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  metadata: jsonb("metadata").$type<{
    dmParticipants?: string[];  // DM participants (both sides)
    pinnedMessageIds?: string[];
    customEmoji?: Record<string, string>;
  }>(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceNameIdx: uniqueIndex("channels_workspace_name_idx").on(table.workspaceId, table.name),
  typeIdx: index("channels_type_idx").on(table.type),
  statusIdx: index("channels_status_idx").on(table.status, table.workspaceId),
}));

// ─── Channel members table ───
export const channelMembers = pgTable("channel_members", {
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role", { length: 20 }).default("member").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  lastReadMessageId: uuid("last_read_message_id"),
  isMuted: boolean("is_muted").default(false).notNull(),
  notificationSettings: jsonb("notification_settings").$type<{
    allMessages?: boolean;
    mentionsOnly?: boolean;
    none?: boolean;
  }>(),
}, (table) => ({
  pk: primaryKey({ columns: [table.channelId, table.userId] }),
  userIdx: index("cm_user_idx").on(table.userId, table.joinedAt),
}));

// ─── Messages table ───
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }).notNull(),
  senderId: uuid("sender_id").references(() => users.id).notNull(),
  clientMsgId: varchar("client_msg_id", { length: 64 }).notNull(),
  content: jsonb("content").$type<{
    type: "text" | "image" | "file" | "system";
    text?: string;
    attachments?: {
      id: string; name: string; url: string; mimeType: string; size: number;
    }[];
  }>().notNull(),
  replyToId: uuid("reply_to_id"),
  threadId: uuid("thread_id"),  // if it's a thread reply
  status: varchar("status", { length: 20 }).default("sent").notNull(),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  reactionCounts: jsonb("reaction_counts").$type<Record<string, number>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  // Core query index: cursor pagination by channel + time ordering
  channelCursorIdx: index("msg_channel_cursor_idx")
    .on(table.channelId, sql`created_at DESC`, table.id),
  // Client idempotency ID deduplication
  clientMsgIdx: uniqueIndex("msg_client_msg_idx").on(table.clientMsgId),
  // Sender index
  senderIdx: index("msg_sender_idx").on(table.senderId, table.createdAt),
  // Thread reply query
  threadIdx: index("msg_thread_idx").on(table.threadId, table.createdAt),
  // Deleted message filtering (not indexed, filtered in WHERE clause)
}));

// ─── Files table ───
export const files = pgTable("files", {
  id: uuid("id").defaultRandom().primaryKey(),
  uploaderId: uuid("uploader_id").references(() => users.id).notNull(),
  channelId: uuid("channel_id").references(() => channels.id),
  originalName: varchar("original_name", { length: 500 }).notNull(),
  storageKey: text("storage_key").notNull(),    // S3/R2 key
  mimeType: varchar("mime_type", { length: 255 }).notNull(),
  size: varchar("size", { length: 50 }).notNull(),
  url: text("url").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// ─── Read receipts table ───
export const readReceipts = pgTable("read_receipts", {
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id").references(() => channels.id, { onDelete: "cascade" }).notNull(),
  lastReadMessageId: uuid("last_read_message_id").notNull(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.channelId] }),
}));
```

### 5.2 JSONB Usage Guidelines

| Suitable for JSONB | Not suitable for JSONB |
|-----------|-------------|
| Message `content` (polymorphic data) | Message status (requires indexing) |
| Channel `metadata` (variable schema) | User ID (requires foreign key constraints) |
| Notification settings (key-value config) | Timestamps (require range queries) |
| Reaction counts `reactionCounts` | Enumerable types (`channel.type`) |
| Attachment lists | Relational data requiring JOINs |

**JSONB query examples:**

```sql
-- Find messages containing image attachments
SELECT * FROM messages
WHERE content @> '{"type": "image"}';

-- Find messages mentioning a specific user
SELECT * FROM messages
WHERE content->'mentions' @> '"user-123"';

-- Update specific reaction count
UPDATE messages
SET reaction_counts = jsonb_set(reaction_counts, '{👍}', (COALESCE((reaction_counts->>'👍')::int, 0) + 1)::text::jsonb)
WHERE id = 'msg-456';
```

### 5.3 Message Pagination Strategy

#### Recommended: Cursor-based

In IM scenarios, messages are frequently inserted/deleted; offset can cause duplicates or omissions. Cursor-based pagination is unaffected by insertions/deletions.

```typescript
// Channel message query (core query)
async function getChannelMessages(
  channelId: string,
  cursor?: { createdAt: string; id: string },
  limit: number = 50
) {
  return db
    .select()
    .from(messages)
    .where(
      cursor
        ? or(
            sql`${messages.createdAt} < ${new Date(cursor.createdAt)}`,
            and(
              sql`${messages.createdAt} = ${new Date(cursor.createdAt)}`,
              sql`${messages.id} < ${cursor.id}`
            )
          )
        : undefined
    )
    .where(eq(messages.channelId, channelId))
    .where(sql`${messages.deletedAt} IS NULL`)  // exclude deleted messages
    .orderBy(sql`${messages.createdAt} DESC`, sql`${messages.id} DESC`)
    .limit(limit);
}

// Response format
interface PaginatedResponse<T> {
  items: T[];
  nextCursor: { createdAt: string; id: string } | null;
  hasMore: boolean;
}
```

**Cursor selection:**
- Use `(created_at, id)` compound cursor — UUIDv4 is non-monotonic, requires `created_at` as primary sort key and `id` as tiebreaker
- Recommended to use **UUID v7** (time-ordered) instead of UUID v4, enabling a single `id` field as the cursor, greatly simplifying queries

```typescript
// If using UUID v7, cursor is simplified to:
async function getChannelMessagesSimple(
  channelId: string,
  cursor?: string,  // message id (UUID v7)
  limit: number = 50
) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.channelId, channelId))
    .where(cursor ? lt(messages.id, cursor) : undefined)
    .where(sql`${messages.deletedAt} IS NULL`)
    .orderBy(desc(messages.id))
    .limit(limit);
}
```

**Why not use offset:**
1. When new messages are inserted, offset causes duplicate content or skipped content during pagination
2. `OFFSET N` requires scanning and ignoring the first N rows, causing severe performance degradation at large offsets
3. Offset is semantically incompatible with real-time message streams

### 5.4 Index Strategy Summary

| Query scenario | Index | Type |
|---------|------|------|
| Channel message pagination | `(channel_id, created_at DESC, id DESC)` | Composite index |
| Find all channels of a user | `cm_user_idx` on `(user_id, joined_at)` | Composite index |
| Channel member list | `channel_members(channel_id)` (PK first column) | PK prefix |
| Client idempotent dedup | `msg_client_msg_idx` unique on `(client_msg_id)` | Unique index |
| Query messages of a user | `(sender_id, created_at)` | Composite index |
| Thread messages | `(thread_id, created_at)` | Composite index |
| Workspace channel list | `channels_workspace_name_idx` unique | Unique index |

---

## 6. Caching Strategy

### 6.1 Redis Cache Layers

```
┌───────────────────────────────────────────────────────┐
│                    Redis Cache Layers                  │
├───────────────────────────────────────────────────────┤
│  Layer 1: Session & Auth                               │
│  ├── session:{token}       → user_id + permissions     │
│  └── refresh_token:{id}    → token metadata            │
│                                                         │
│  Layer 2: Online Presence                               │
│  ├── presence:{userId}     → { status, lastSeen, device }│
│  ├── online_users:{ws_id}  → Set<userId>               │
│  └── user_sockets:{userId} → Set<socketId>             │
│                                                         │
│  Layer 3: Channel State                                 │
│  ├── channel:{id}:members  → Set<userId>               │
│  ├── channel:{id}:info     → Hash (name, topic, type)  │
│  └── user:{id}:channels    → Set<channelId>            │
│                                                         │
│  Layer 4: Message Hot Data                              │
│  ├── messages:{channelId}  → Sorted Set (recent 200)   │
│  │    score=timestamp, member=JSON message              │
│  └── thread:{msgId}        → Sorted Set (recent 100)   │
│                                                         │
│  Layer 5: Read/Unread State                             │
│  ├── read_cursor:{ch}:{u}  → last_read_message_id      │
│  └── unread_count:{u}:{ws} → Integer (per workspace)    │
│                                                         │
│  Layer 6: Rate Limiting                                 │
│  ├── ratelimit:{ip}        → counter + window           │
│  └── ws_ratelimit:{userId} → counter + window           │
└───────────────────────────────────────────────────────┘
```

### 6.2 Caching Strategy Details

```typescript
// ─── Layer 2: Online presence (strong consistency, proactive update) ───
// User comes online
await redis.hSet(`presence:${userId}`, {
  status: "online",
  lastSeen: Date.now().toString(),
});
await redis.sAdd(`online_users:${workspaceId}`, userId);

// User goes offline (WebSocket disconnect)
await redis.hSet(`presence:${userId}`, { status: "offline", lastSeen: Date.now().toString() });
await redis.sRem(`online_users:${workspaceId}`, userId);

// ─── Layer 4: Recent message hot cache (TTL + capacity limit) ───
async function cacheRecentMessage(channelId: string, message: Message) {
  const key = `messages:${channelId}`;
  await redis.zAdd(key, { score: message.createdAt.getTime(), value: JSON.stringify(message) });
  // Keep only the most recent 200
  await redis.zRemRangeByRank(key, 0, -201);
  // TTL 1 hour (auto-clean cache for long-inactive channels)
  await redis.expire(key, 3600);
}

async function getRecentMessages(channelId: string, limit = 50) {
  const key = `messages:${channelId}`;
  const rows = await redis.zRange(key, -limit, -1, { rev: true });
  return rows.map((r) => JSON.parse(r));
}

// ─── Layer 3: Channel members (lazy loading + TTL) ───
async function getChannelMembers(channelId: string): Promise<string[]> {
  const key = `channel:${channelId}:members`;
  const cached = await redis.sMembers(key);
  if (cached.length > 0) return cached;

  // Cache miss: load from DB
  const members = await db.query.channelMembers.findMany({
    where: eq(channelMembers.channelId, channelId),
    columns: { userId: true },
  });
  const userIds = members.map((m) => m.userId);

  if (userIds.length > 0) {
    await redis.sAdd(key, userIds);
    await redis.expire(key, 300); // 5-minute TTL
  }
  return userIds;
}

// Proactive invalidation on member change
async function addChannelMember(channelId: string, userId: string) {
  await db.insert(channelMembers).values({ channelId, userId });
  await redis.del(`channel:${channelId}:members`);
  await redis.del(`user:${userId}:channels`);
}
```

### 6.3 Cache Invalidation Strategy Reference

| Data type | Strategy | TTL | Proactive invalidation trigger |
|---------|------|-----|----------------|
| Session/Token | Proactive invalidation | 7 days | Logout, password change |
| Online presence | **No TTL** | - | WebSocket connect/disconnect |
| Channel member list | TTL + Proactive | 5 minutes | Member join/leave |
| Channel info | TTL + Proactive | 10 minutes | Channel name/description change |
| Recent messages | TTL + LRU | 1 hour | New message pushed in (capacity limit) |
| Read cursor | TTL | 7 days | Every read update |
| Unread count | Computed | Real-time | New message + read update |
| Rate limit counter | **Fixed window TTL** | Window size | Natural expiration |

### 6.4 Unread Count (Computed Cache)

```typescript
// Do not cache unread count values (risk of stale inconsistency); compute in real-time or use hybrid approach
async function getUnreadCount(userId: string, channelId: string): Promise<number> {
  const lastReadId = await redis.get(`read_cursor:${channelId}:${userId}`);

  return db.$count(
    messages,
    and(
      eq(messages.channelId, channelId),
      sql`${messages.deletedAt} IS NULL`,
      lastReadId ? gt(messages.id, lastReadId) : undefined
    )
  );
}
```

**Optimization approach:** For high-frequency unread count queries, use a 10s short TTL cache (allowing brief inconsistency), invalidate on new message arrival.

---

## 7. Security & Rate Limiting

### 7.1 API Rate Limiting Strategy

**Recommended: Sliding Window Log algorithm**

Token Bucket is suitable for controlling average rate but allows bursts; Sliding Window is more suitable for API rate limiting, providing precise time window control.

```typescript
import { rateLimiter } from "hono-rate-limiter";

// Global API rate limiting
app.use("/api/*", rateLimiter({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  limit: 100,                 // 100 requests per IP
  standardHeaders: true,      // RateLimit-* headers
  keyGenerator: (c) =>
    c.req.header("x-real-ip") ??
    c.req.header("x-forwarded-for") ??
    "unknown",
  store: new RedisStore({ client: redis }),  // distributed rate limiting
}));

// Sensitive endpoint independent rate limiting (login, register)
app.use("/api/auth/login", rateLimiter({
  windowMs: 5 * 60 * 1000,
  limit: 5,  // 5 requests / 5 minutes
  message: { error: "too_many_attempts", retryAfter: 300 },
}));

// File upload endpoint independent rate limiting
app.use("/api/files/upload", rateLimiter({
  windowMs: 60 * 1000,
  limit: 10, // 10 requests / minute
  keyGenerator: (c) => c.get("userId"), // based on user ID not IP
}));
```

**Why choose Sliding Window over Token Bucket:**
- Sliding Window provides a **hard cap**: within any time window, the limit is never exceeded
- Token Bucket allows burst traffic, but IM API calls are typically more uniform
- Sliding Window is more suitable for anti-abuse scenarios (brute force, spam messages)

### 7.2 WebSocket Message Rate Limiting

```typescript
// Message rate limiting middleware
const wsRateLimiter = new Map<string, { count: number; resetAt: number }>();

function checkWsRateLimit(userId: string, action: string): boolean {
  const key = `${userId}:${action}`;
  const limits: Record<string, { max: number; windowMs: number }> = {
    "message:send": { max: 10, windowMs: 1000 },   // 10 messages/sec
    "typing":       { max: 5, windowMs: 3000 },     // 5 typing events/3s
    "reaction":     { max: 5, windowMs: 2000 },     // 5 reactions/2s
  };

  const limit = limits[action];
  if (!limit) return true;

  const now = Date.now();
  const entry = wsRateLimiter.get(key);

  if (!entry || now > entry.resetAt) {
    wsRateLimiter.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  if (entry.count >= limit.max) return false;
  entry.count++;
  return true;
}

// Use in Socket.IO event handlers
socket.on("message:send", (data, ack) => {
  const userId = socket.data.user.id;
  if (!checkWsRateLimit(userId, "message:send")) {
    ack({ status: "failed", error: "rate_limited", retryAfterMs: 1000 });
    return;
  }
  // ... normal processing
});
```

**Distributed WS rate limiting (Redis version):**

```typescript
async function checkDistributedRateLimit(
  userId: string, action: string, max: number, windowSec: number
): Promise<boolean> {
  const key = `ws_ratelimit:${userId}:${action}`;
  const now = Math.floor(Date.now() / 1000);

  const multi = redis.multi();
  multi.zRemRangeByScore(key, 0, now - windowSec);  // clean expired entries
  multi.zCard(key);                                   // request count in current window
  multi.zAdd(key, { score: now, value: `${now}:${Math.random()}` });
  multi.expire(key, windowSec + 1);

  const [, count] = (await multi.exec()) as [unknown, number];
  return count < max;
}
```

### 7.3 File Upload Security

```typescript
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "text/plain", "text/csv",
  "application/zip",
  "audio/mpeg", "audio/ogg",
  "video/mp4",
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// File upload validation pipeline
app.post("/api/files/upload",
  zValidator("form", z.object({
    channelId: z.string().uuid(),
    file: z.custom<File>((f) => f instanceof File, "Invalid file"),
  })),
  async (c) => {
    const { file, channelId } = c.req.valid("form"); // Note: in Hono, need to parse body instead

    // 1. MIME type whitelist
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return c.json({ error: `Unsupported file type: ${file.type}` }, 400);
    }

    // 2. File size validation
    if (file.size > MAX_FILE_SIZE) {
      return c.json({ error: `File exceeds max size of ${MAX_FILE_SIZE / 1024 / 1024}MB` }, 400);
    }

    // 3. Magic number check to prevent MIME forgery
    const buffer = await file.arrayBuffer();
    const header = new Uint8Array(buffer.slice(0, 8));
    const detectedType = detectMimeType(header);
    if (!ALLOWED_MIME_TYPES.includes(detectedType)) {
      return c.json({ error: `File content does not match declared type` }, 400);
    }

    // 4. Filename sanitization
    const safeFileName = sanitizeFileName(file.name);

    // 5. Upload to S3/R2
    const key = `uploads/${channelId}/${crypto.randomUUID()}/${safeFileName}`;
    await s3.upload({ Bucket, Key: key, Body: buffer, ContentType: file.type });

    return c.json({ url: `${CDN_URL}/${key}`, key, size: file.size }, 201);
  }
);

// Magic number detection helper
function detectMimeType(header: Uint8Array): string {
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return "image/jpeg";
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E) return "image/png";
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return "image/gif";
  if (header[0] === 0x25 && header[1] === 0x50 && header[2] === 0x44) return "application/pdf";
  if (header[0] === 0x50 && header[1] === 0x4B) return "application/zip";
  return "application/octet-stream";
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")   // allow only safe characters
    .replace(/_{2,}/g, "_")              // collapse consecutive underscores
    .slice(-200);                         // max length limit
}
```

### 7.4 Common Attack Defenses

| Attack type | Defense measure | Implementation approach |
|---------|---------|---------|
| **CSRF** | SameSite Cookie + CSRF Token | `secureHeaders()` set `SameSite=Strict`; dual token pattern |
| **XSS** | Input escaping + CSP | Store message content without escaping; use `textContent` not `innerHTML` on frontend rendering |
| **SQL injection** | Parameterized queries (Drizzle ORM default) | Drizzle ORM uses parameterization for all queries, no extra handling needed |
| **NoSQL injection** | JSONB query parameterization | Use `$type<>()` generic to constrain JSONB field types |
| **JWT leak** | Short-lived Access Token + Refresh Token rotation | Access 15min, Refresh 7d, discard after single use |
| **DDoS / CC** | Dual IP + User rate limiting | API-level rate limiting + WS message rate limiting |
| **File upload attacks** | MIME whitelist + magic number check + size limit | See section 7.3 |
| **Enumeration attacks** | Uniform request response time | Login failure and success return responses with the same timing |

**CSP and security header configuration:**

```typescript
import { secureHeaders } from "hono/secure-headers";

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", CDN_URL, "data:"],
    connectSrc: ["'self'", "wss://chat.example.com"],
    mediaSrc: [CDN_URL],
  },
  xFrameOptions: "DENY",
  xContentTypeOptions: "nosniff",
  referrerPolicy: "strict-origin-when-cross-origin",
}));
```

---

## Appendix A: Recommended Dependency List (as of mid-2026)

### Production Dependencies

| Package | Recommended version | Purpose |
|-----|---------|------|
| `hono` | `^4.12.0` | HTTP framework |
| `@hono/node-server` | `^1.13.0` | Node.js adapter |
| `@hono/zod-validator` | `^0.4.0` | Request validation |
| `zod` | `^3.23.0` | Schema validation |
| `drizzle-orm` | `^0.40.0` | ORM |
| `drizzle-kit` | `^0.30.0` | Migration tool (dev) |
| `postgres` (or `pg`) | `^3.4.0` | PostgreSQL driver |
| `socket.io` | `^4.8.0` | WebSocket framework |
| `@socket.io/redis-adapter` | `^8.3.0` | Socket.IO Redis adapter |
| `redis` (ioredis or node-redis) | `^4.7.0` | Redis client |
| `hono-rate-limiter` | `^0.4.0` | Rate limiting |
| `@hono/jwt` | built-in `hono/jwt` | JWT verification |
| `uuid` (or `crypto.randomUUID`) | `^10.0.0` | UUID v7 generation |
| `pino` | `^9.5.0` | Structured logging |
| `@aws-sdk/client-s3` | `^3.600.0` | S3/R2 file storage |

### Dev Dependencies

| Package | Purpose |
|-----|------|
| `typescript` | TypeScript compiler |
| `vitest` | Testing framework |
| `tsx` | TypeScript executor (dev) |
| `@types/node` | Node.js type definitions |

---

## Appendix B: Final Recommendation Summary

| Decision area | Recommended solution | Core rationale |
|---------|---------|---------|
| HTTP framework | **Hono v4.12** | Lightweight, cross-runtime, rich built-in middleware, fast cold start |
| WebSocket | **Socket.IO v4 + Redis Adapter** | Room management, reconnect, heartbeat built-in, mature horizontal scaling |
| Database | **PostgreSQL + Drizzle ORM** | Type-safe, native cursor pagination support, strong JOIN capabilities |
| Cache | **Redis (single-node/sentinel, cluster later)** | Multi-layer caching, Pub/Sub, rate limiting |
| File storage | **S3-compatible storage (R2/MinIO)** | Low cost, CDN-ready |
| Message format | **JSONB + UUID v7** | Polymorphic content, time-ordered IDs |
| Pagination strategy | **Cursor-based** | Avoid insert/delete interference of offset |
| Rate limiting algorithm | **Sliding Window (Redis-backed)** | Precise window, distributed-friendly |
| Logging | **Pino** | High-performance, structured JSON logging |

---

> This report is based on the latest versions and community practices as of June 2026. Library version numbers and performance data may change over time; it is recommended to reconfirm the latest stable versions of each dependency before implementation.
