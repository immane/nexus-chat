---
lang: en
---

# Nexus Chat — Long Connection & Core Gateway Layer Design

> Version: v1.0 | Last Updated: 2026-06-24 | Status: Draft  
> References: [Backend IM State Machine Research](../research/backend-im-state-machine.md), [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md), [Bot Engine & Microservices](../research/bot-engine-microservices.md)

---

## Table of Contents

1. [Gateway Layer Responsibilities](#1-gateway-layer-responsibilities)
2. [WebSocket Protocol Design](#2-websocket-protocol-design)
3. [Connection Management](#3-connection-management)
4. [REST API Architecture](#4-rest-api-architecture)
5. [Authentication Flow](#5-authentication-flow)
6. [Rate Limiting](#6-rate-limiting)
7. [Message Relay Pipeline](#7-message-relay-pipeline)
8. [Security Headers & CORS](#8-security-headers--cors)

---

## 1. Gateway Layer Responsibilities

The Gateway Layer is the single entry point for all client-server communication. It is responsible for:

### 1.1 Responsibility Matrix

| Responsibility | Implementation | Remarks |
|---|---|---|
| WebSocket connection lifecycle | Socket.IO v4 server | Connection, disconnection, heartbeat, reconnection |
| REST API routing & middleware | Hono v4.12 | Trie-tree routing with per-route middleware groups |
| Authentication & authorization at edge | JWT validation middleware + Socket.IO auth middleware | Reject unauthorized traffic before it reaches internal services |
| Rate limiting | `hono-rate-limiter` (REST) + in-process/Redis counters (WS) | Dual IP + user-level limiting |
| Message relay (broadcast, unicast, multicast) | Socket.IO rooms + Redis Adapter | `io.to("room").emit()` with horizontal scaling |
| Protocol definition | JSON envelope over WebSocket | Enforce schema validation at ingress |

### 1.2 Architectural Position

```
                        ┌──────────────────────────┐
                        │     Nginx / ALB           │
                        │   (TLS termination,       │
                        │    sticky sessions)        │
                        └───────────┬──────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                │       Gateway Layer (this doc)         │
                │  ┌────────────┐  ┌─────────────────┐  │
                │  │  Hono REST  │  │  Socket.IO WS   │  │
                │  │  (Port 3000)│  │  (attached to   │  │
                │  │            │  │   HTTP server)   │  │
                │  └────────────┘  └─────────────────┘  │
                └───────────────────┬───────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ↓               ↓               ↓
        ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
        │  Auth Service  │  │ Message Svc  │  │  Bot Engine  │
        └───────────────┘  └──────────────┘  └──────────────┘
                                    │
                            ┌───────┴───────┐
                            │ PostgreSQL    │
                            │ + Redis       │
                            └───────────────┘
```

In Phase 1 (monolith), the Gateway Layer and internal services share a single process. In Phase 2+, the Gateway Layer is extracted as a standalone stateless service, communicating with backend microservices via Redis Streams or NATS JetStream (see [Bot Engine & Microservices Research](../research/bot-engine-microservices.md#33-database-strategy)).

---

## 2. WebSocket Protocol Design

### 2.1 Connection URL

```
wss://gateway.nexus.chat/ws?token=<jwt_access_token>
```

The JWT is passed as a query parameter during the WebSocket handshake. Socket.IO's `auth` middleware extracts and validates it before the connection is established.

### 2.2 Message Envelope

All messages over the WebSocket follow a unified JSON envelope format:

```typescript
interface GatewayMessage {
  type: string;                          // message type identifier (see §2.3–2.4)
  seq?: number;                          // client sequence number for ACK tracking
  ack?: number;                          // acknowledge server sequence number
  channelId: string;                     // target channel UUID
  workspaceId: string;                   // workspace UUID (for multi-tenant routing)
  payload: unknown;                      // message-type-specific payload
  timestamp: number;                     // Unix ms timestamp
  encryption?: "none" | "e2e";           // encryption mode indicator
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Event type string. Server and client share a typed contract. |
| `seq` | No | Client-side monotonic sequence number. Server echoes it in ACK responses for out-of-order detection. |
| `ack` | No | When the client acknowledges receipt of a server-pushed message, it sets this to the server's message `seq`. |
| `channelId` | Yes | UUID of the target channel (or `system` for non-channel events). |
| `workspaceId` | Yes | Workspace UUID for routing. |
| `payload` | Yes | Type-specific data. Schema varies per `type`. |
| `timestamp` | Yes | Client-generated timestamp in milliseconds since Unix epoch. |
| `encryption` | No | `"e2e"` when message content is end-to-end encrypted (Phase 3+). Defaults to `"none"`. |

### 2.3 Client → Server Event Types

```typescript
const ClientEvents = {
  "message.send":          (data: { content: MessageContent; replyToId?: string; threadId?: string }) => void,
  "message.ack":           (data: { messageId: string; status: "delivered" | "read" }) => void,
  "typing.start":          (data: { channelId: string }) => void,
  "typing.stop":           (data: { channelId: string }) => void,
  "presence.update":       (data: { status: "online" | "away" | "dnd" | "offline" }) => void,
  "channel.join":          (data: { channelId: string }) => void,
  "channel.leave":         (data: { channelId: string }) => void,
  "bot.command.invoke":    (data: { botName: string; command: string; args: string[]; channelId: string; triggerId?: string }) => void,
  "signal.prekey.fetch":   (data: { userIds: string[] }) => void,
  "signal.prekey.upload":  (data: { prekeys: PreKeyBundle[] }) => void,
} as const;
```

### 2.4 Server → Client Event Types

```typescript
const ServerEvents = {
  "message.receive":       (data: Message) => void,
  "message.ack":           (data: { clientSeq: number; messageId: string; status: "sent" | "failed"; error?: string }) => void,
  "message.error":         (data: { code: string; message: string; clientSeq?: number }) => void,
  "typing.indicator":      (data: { channelId: string; userId: string; userName: string }) => void,
  "presence.change":       (data: { userId: string; status: string; lastSeen: number }) => void,
  "channel.created":       (data: Channel) => void,
  "channel.updated":       (data: { channelId: string; changes: Partial<Channel> }) => void,
  "channel.member_joined": (data: { channelId: string; userId: string }) => void,
  "channel.member_left":   (data: { channelId: string; userId: string }) => void,
  "bot.response":          (data: { botId: string; channelId: string; content: MessageContent }) => void,
  "error":                 (data: { code: string; message: string }) => void,
  "force.disconnect":      (data: { reason: string }) => void,
  "signal.prekey.response":(data: { userIds: Record<string, PreKeyBundle> }) => void,
} as const;
```

### 2.5 Heartbeat Mechanism

Socket.IO provides built-in heartbeat. The recommended configuration:

```typescript
const io = new Server(httpServer, {
  transports: ["websocket"],       // disable HTTP long-polling
  pingInterval: 30_000,            // server sends ping every 30s
  pingTimeout: 10_000,             // client must pong within 10s or disconnected
  connectTimeout: 10_000,          // handshake must complete within 10s
});
```

- **pingInterval (30s)**: Must be less than the load balancer's idle timeout. AWS ALB defaults to 60s; setting 30s ensures ALB does not prematurely close the connection.
- **pingTimeout (10s)**: Slightly less than pingInterval to avoid false disconnections from transient network jitter.
- **Transports**: Server-side, only `websocket` is enabled. Client-side, `socket.io-client` should also be configured with `transports: ["websocket"]` to skip the HTTP long-polling upgrade round-trip.

### 2.6 Reconnection Strategy (Client-Side)

```typescript
const socket = io("wss://gateway.nexus.chat", {
  transports: ["websocket"],
  auth: (cb) => cb({ token: getAccessToken() }),
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1_000,           // 1s initial delay
  reconnectionDelayMax: 30_000,       // 30s maximum delay
  randomizationFactor: 0.5,           // ±50% jitter
});
```

Exponential backoff formula: `delay = min(reconnectionDelay × 2^attempt, reconnectionDelayMax)` + random jitter (±50%). This yields the sequence: 1s → 2s → 4s → 8s → 16s → 30s → 30s...

On successful reconnection, the client must replay unacknowledged messages from its local pending queue, each identified by a unique `clientMsgId`. The server deduplicates using `clientMsgId` to prevent duplicate writes (see [Backend IM Research §3.7](../research/backend-im-state-machine.md#37-failure-retry-strategy)).

---

## 3. Connection Management

### 3.1 Socket.IO v4 with Redis Adapter

Horizontal scaling is achieved via `@socket.io/redis-adapter`, which transparently forwards `io.to("room").emit()` calls across all gateway instances through Redis Pub/Sub.

```typescript
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server } from "socket.io";
import { createServer } from "http";

const httpServer = createServer();

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);

const io = new Server(httpServer, {
  adapter: createAdapter(pubClient, subClient),
  transports: ["websocket"],
  pingInterval: 30_000,
  pingTimeout: 10_000,
});
```

**Graceful degradation on Redis failure**: If Redis becomes unreachable, the gateway enters single-node mode — it can serve clients connected directly to itself but cross-pod broadcasting ceases. The gateway logs a `REDIS_ADAPTER_DISCONNECTED` alert and continues operating locally until Redis recovers.

```typescript
pubClient.on("error", (err) => {
  logger.error({ err }, "Redis pubClient error — entering single-node mode");
  // io.of("/").adapter falls back to in-memory adapter for local connections
});

pubClient.on("ready", () => {
  logger.info("Redis pubClient reconnected — resuming cluster mode");
});
```

### 3.2 Room-Based Routing

Each user and channel is represented as a Socket.IO room, creating a simple routing table:

```typescript
// On connection, join rooms based on authenticated user data
io.on("connection", async (socket) => {
  const { userId, workspaceIds } = socket.data;

  // Personal notification pipe
  socket.join(`user:${userId}`);

  // Join all channels the user belongs to
  const memberships = await getChannelMemberships(userId);
  for (const ch of memberships) {
    socket.join(`channel:${ch.id}`);
  }
});
```

| Room Pattern | Purpose | Example Usage |
|---|---|---|
| `user:{userId}` | Unicast notifications, DM delivery, force-disconnect | `io.to("user:abc123").emit(...)` |
| `channel:{channelId}` | Broadcast to all online members of a channel | `io.to("channel:ch-456").emit(...)` |
| `workspace:{workspaceId}` | Workspace-wide announcements | `io.to("workspace:ws-789").emit(...)` |

### 3.3 Connection State Machine

```
                            ┌──────────────────┐
                            │   DISCONNECTED   │
                            └────────┬─────────┘
                                     │ client initiates WebSocket
                                     ↓
                            ┌──────────────────┐
                     ┌─────→│   CONNECTING     │
                     │      └────────┬─────────┘
                     │               │ handshake complete
                     │               ↓
                     │      ┌──────────────────┐
                     │      │  AUTHENTICATING  │──→ JWT invalid ──→ DISCONNECTED
                     │      └────────┬─────────┘
                     │               │ JWT valid, rooms joined
                     │               ↓
                     │      ┌──────────────────┐
                     │      │   CONNECTED      │
                     │      └────────┬─────────┘
                     │               │
                     │   ┌───────────┼───────────┐
                     │   │           │           │
                     │   ↓           ↓           ↓
                     │ ping timeout  explicit    server
                     │ / transport   disconnect  shutdown
                     │   error
                     │   │           │           │
                     │   ↓           ↓           ↓
                     │      ┌──────────────────┐
                     └─────│  RECONNECTING    │
                            └────────┬─────────┘
                                     │ max attempts exceeded
                                     ↓
                            ┌──────────────────┐
                            │   DISCONNECTED   │
                            └──────────────────┘
```

```typescript
type ConnectionState =
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "disconnected";
```

### 3.4 Max Connections Per User

To prevent a single user from consuming excessive connections, enforce a per-user socket limit:

```typescript
const MAX_SOCKETS_PER_USER = 5;

io.on("connection", async (socket) => {
  const userId = socket.data.userId;

  // Count existing connections for this user
  const existingSockets = await io
    .in(`user:${userId}`)
    .fetchSockets();

  if (existingSockets.length >= MAX_SOCKETS_PER_USER) {
    // Kick the oldest socket
    const oldest = existingSockets[0];
    oldest.emit("force.disconnect", {
      reason: "max_connections_reached",
    });
    oldest.disconnect(true);
  }

  socket.join(`user:${userId}`);
});
```

### 3.5 Duplicate Login Handling

When the same user connects from a new device, the old device's session is replaced (not duplicated):

```typescript
// Track session → socket mapping per user
const userSessions = new Map<string, Map<string, string>>();
// userId → Map<sessionId, socketId>

io.on("connection", (socket) => {
  const { userId, sessionId } = socket.data;

  if (!userSessions.has(userId)) {
    userSessions.set(userId, new Map());
  }

  const sessions = userSessions.get(userId)!;
  const existingSocketId = sessions.get(sessionId);

  if (existingSocketId) {
    io.to(existingSocketId).emit("force.disconnect", {
      reason: "logged_in_elsewhere",
    });
    io.sockets.sockets.get(existingSocketId)?.disconnect(true);
  }

  sessions.set(sessionId, socket.id);

  socket.on("disconnect", () => {
    sessions.delete(sessionId);
  });
});
```

---

## 4. REST API Architecture

### 4.1 Hono v4.12 Route Groups

Hono is chosen for its lightweight footprint (14KB), built-in middleware ecosystem, and cross-runtime support (see [Backend IM Research §1.5](../research/backend-im-state-machine.md#15-recommended-solution)).

```
                    ┌───────────────┐
                    │  Hono App     │
                    │  basePath:    │
                    │  /api/v1      │
                    └───────┬───────┘
            ┌───────────────┼───────────────┐
            ↓               ↓               ↓
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ /auth/*      │ │ /workspaces/*│ │ /channels/*  │
    │ (public)     │ │              │ │              │
    └──────────────┘ └──────────────┘ └──────────────┘
            ↓               ↓               ↓
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ /messages/*  │ │ /bots/*      │ │ /signal/*    │
    │              │ │              │ │              │
    └──────────────┘ └──────────────┘ └──────────────┘
```

| Route Group | Endpoints | Auth Required | Rate Limit Tier |
|---|---|---|---|
| `/api/v1/auth/*` | `POST /login`, `POST /register`, `POST /refresh`, `POST /logout` | No (except logout) | Strict (5 req/5min for login) |
| `/api/v1/workspaces/*` | `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `GET /:id/members`, `POST /:id/members`, `DELETE /:id/members/:userId` | Yes | Standard |
| `/api/v1/channels/*` | `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `GET /:id/members`, `POST /:id/members`, `DELETE /:id/members/:userId`, `PATCH /:id/mode` | Yes | Standard |
| `/api/v1/messages/*` | `GET /:channelId/history`, `GET /search` | Yes | Standard |
| `/api/v1/bots/*` | `POST /register`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`, `POST /:id/webhook` | Yes (workspace admin) | Standard |
| `/api/v1/signal/*` | `POST /prekeys`, `GET /prekeys/:userId`, `DELETE /prekeys` | Yes | Standard |

### 4.2 Middleware Chain

Every request flows through the following middleware stack:

```
logger → cors → helmet → jwt-auth → rate-limit → route handler
```

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { jwt } from "hono/jwt";
import { rateLimiter } from "hono-rate-limiter";
import { secureHeaders } from "hono/secure-headers";
import { RedisStore } from "@hono-rate-limiter/redis";

const app = new Hono().basePath("/api/v1");

// --- Global middleware (applied to all routes) ---
app.use("*", logger());
app.use("*", cors({ origin: ALLOWED_ORIGINS }));
app.use("*", secureHeaders(HELMET_CONFIG));

// --- Public routes (no JWT) ---
const auth = new Hono();
auth.post("/login", rateLimiter(LOGIN_RATE_LIMIT), loginHandler);
auth.post("/register", registerHandler);
auth.post("/refresh", refreshTokenHandler);
auth.post("/logout", logoutHandler);
app.route("/auth", auth);

// --- Protected routes (JWT required) ---
const protectedRoutes = new Hono();
protectedRoutes.use("*", jwt({ secret: JWT_SECRET }));
protectedRoutes.use("*", rateLimiter(STANDARD_RATE_LIMIT));

const workspaces = new Hono();
workspaces.post("/", createWorkspace);
workspaces.get("/", listWorkspaces);
// ...
protectedRoutes.route("/workspaces", workspaces);

const channels = new Hono();
// ...
protectedRoutes.route("/channels", channels);

const messages = new Hono();
// ...
protectedRoutes.route("/messages", messages);

const bots = new Hono();
// ...
protectedRoutes.route("/bots", bots);

const signal = new Hono();
// ...
protectedRoutes.route("/signal", signal);

app.route("/", protectedRoutes);
```

### 4.3 Standardized Response Format

All REST API responses follow a uniform structure:

```typescript
interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta?: {
    timestamp: number;
    requestId: string;
    cursor?: string | null;
    hasMore?: boolean;
  };
}
```

Success response:
```json
{
  "ok": true,
  "data": { "id": "uuid", "name": "general" },
  "meta": { "timestamp": 1719234567890, "requestId": "req_abc123" }
}
```

Error response:
```json
{
  "ok": false,
  "error": {
    "code": "CHANNEL_NOT_FOUND",
    "message": "Channel with the given ID does not exist"
  },
  "meta": { "timestamp": 1719234567890, "requestId": "req_abc123" }
}
```

### 4.4 Error Codes

```typescript
enum ErrorCode {
  // Auth (AUTH_*)
  AUTH_INVALID_CREDENTIALS    = "AUTH_INVALID_CREDENTIALS",
  AUTH_TOKEN_EXPIRED          = "AUTH_TOKEN_EXPIRED",
  AUTH_TOKEN_INVALID          = "AUTH_TOKEN_INVALID",
  AUTH_REFRESH_EXPIRED        = "AUTH_REFRESH_EXPIRED",
  AUTH_REFRESH_REUSED         = "AUTH_REFRESH_REUSED",
  AUTH_UNAUTHORIZED           = "AUTH_UNAUTHORIZED",
  AUTH_FORBIDDEN              = "AUTH_FORBIDDEN",

  // Rate Limiting (RATE_*)
  RATE_LIMITED                = "RATE_LIMITED",

  // Validation (VAL_*)
  VALIDATION_ERROR            = "VALIDATION_ERROR",

  // Resource (RES_*)
  WORKSPACE_NOT_FOUND         = "WORKSPACE_NOT_FOUND",
  CHANNEL_NOT_FOUND           = "CHANNEL_NOT_FOUND",
  MESSAGE_NOT_FOUND           = "MESSAGE_NOT_FOUND",
  USER_NOT_FOUND              = "USER_NOT_FOUND",
  BOT_NOT_FOUND               = "BOT_NOT_FOUND",

  // Conflict (CONFLICT_*)
  CONFLICT_CHANNEL_NAME       = "CONFLICT_CHANNEL_NAME",
  CONFLICT_WORKSPACE_SLUG     = "CONFLICT_WORKSPACE_SLUG",

  // Internal (INT_*)
  INTERNAL_ERROR              = "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE         = "SERVICE_UNAVAILABLE",
}
```

---

## 5. Authentication Flow

### 5.1 JWT Token Strategy

| Token Type | Lifetime | Storage (Client) | Rotation |
|---|---|---|---|
| Access Token | 15 minutes | In-memory only | N/A (short-lived) |
| Refresh Token | 7 days | `httpOnly` secure cookie or secure storage | One-time use; new token pair issued on each refresh |

```typescript
interface TokenPayload {
  sub: string;            // userId
  wsId: string;           // current workspace ID
  role: string;           // workspace-level role
  iat: number;            // issued at
  exp: number;            // expiration
  jti: string;            // unique token ID (for revocation)
}

interface RefreshTokenPayload {
  sub: string;            // userId
  jti: string;            // unique token ID
  family: string;         // token family (for rotation detection)
  exp: number;            // expiration (7 days)
}
```

**Refresh token rotation**: When a refresh token is used, both the old and new tokens are invalidated. The `family` field detects token reuse — if a token from the same family is used after rotation, the entire family is revoked (indicating a stolen refresh token).

```typescript
async function refreshTokens(oldRefreshToken: string): Promise<TokenPair> {
  const decoded = verifyRefreshToken(oldRefreshToken);
  const stored = await redis.get(`refresh:${decoded.jti}`);

  if (!stored || stored === "revoked") {
    // Token reuse detected — revoke the whole family
    await revokeTokenFamily(decoded.family);
    throw new AuthError(ErrorCode.AUTH_REFRESH_REUSED);
  }

  // Mark old token as used
  await redis.set(`refresh:${decoded.jti}`, "used", "EX", 7 * 86400);

  // Issue new pair
  const newPair = await issueTokenPair(decoded.sub);
  return newPair;
}
```

### 5.2 JWT Validation Middleware

```typescript
import { jwt } from "hono/jwt";

const jwtMiddleware = jwt({
  secret: process.env.JWT_SECRET!,
  cookie: {
    key: "access_token",
    secret: process.env.COOKIE_SECRET,
  },
});

// Usage on protected routes
app.use("/api/v1/*", async (c, next) => {
  // Skip public auth routes
  if (c.req.path.startsWith("/api/v1/auth/login") ||
      c.req.path.startsWith("/api/v1/auth/register") ||
      c.req.path.startsWith("/api/v1/auth/refresh")) {
    return next();
  }
  return jwtMiddleware(c, next);
});
```

### 5.3 WebSocket Authentication

```typescript
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token
    || socket.handshake.query.token;

  if (!token) {
    return next(new Error("Authentication token required"));
  }

  try {
    const payload = await verifyAccessToken(token as string);
    socket.data.userId = payload.sub;
    socket.data.workspaceId = payload.wsId;
    socket.data.sessionId = payload.jti;
    next();
  } catch (err) {
    next(new Error("Invalid or expired token"));
  }
});
```

### 5.4 Bot Authentication

Bots authenticate via a long-lived API token, passed in the `x-nxbot-token` HTTP header or as a WebSocket query parameter:

```typescript
// REST middleware
app.use("/api/v1/bots/*", async (c, next) => {
  const botToken = c.req.header("x-nxbot-token");
  if (!botToken) return next();

  const bot = await validateBotToken(botToken);
  if (!bot) {
    return c.json({ ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "Invalid bot token" } }, 401);
  }
  c.set("botId", bot.id);
  c.set("workspaceId", bot.workspaceId);
  return next();
});

// WebSocket middleware
io.of("/bots").use(async (socket, next) => {
  const botToken = socket.handshake.auth.token;
  const bot = await validateBotToken(botToken);
  if (!bot) return next(new Error("Invalid bot token"));
  socket.data.botId = bot.id;
  socket.data.workspaceId = bot.workspaceId;
  next();
});
```

---

## 6. Rate Limiting

### 6.1 REST API Rate Limiting

Two-tier rate limiting using `hono-rate-limiter` with a Redis store (see [Backend IM Research §7.1](../research/backend-im-state-machine.md#71-api-rate-limiting-strategy)):

```typescript
import { rateLimiter } from "hono-rate-limiter";
import { RedisStore } from "@hono-rate-limiter/redis";

const standardLimiter = rateLimiter({
  windowMs: 60_000,           // 1-minute sliding window
  limit: 100,                 // per-user
  standardHeaders: true,
  keyGenerator: (c) => c.get("userId") ?? c.req.header("x-forwarded-for") ?? "unknown",
  store: new RedisStore({ client: redis, prefix: "rl:api:" }),
});

const ipLimiter = rateLimiter({
  windowMs: 60_000,
  limit: 200,                 // per-IP
  standardHeaders: true,
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
  store: new RedisStore({ client: redis, prefix: "rl:ip:" }),
});

// Sensitive endpoint — strict rate limit
const loginLimiter = rateLimiter({
  windowMs: 5 * 60_000,       // 5-minute window
  limit: 5,                   // 5 attempts
  standardHeaders: true,
  keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "unknown",
  store: new RedisStore({ client: redis, prefix: "rl:login:" }),
  message: { ok: false, error: { code: "RATE_LIMITED", message: "Too many login attempts. Retry in 5 minutes." } },
});
```

| Limiter | Scope | Window | Max Requests | Key |
|---|---|---|---|---|
| Standard (user) | Per authenticated user | 60s | 100 | `userId` |
| Standard (IP) | Per IP address | 60s | 200 | `x-forwarded-for` |
| Login | Per IP | 300s | 5 | `x-forwarded-for` |
| File Upload | Per user | 60s | 10 | `userId` |
| Bot API | Per bot | Configurable | Configurable | `botId` |

### 6.2 WebSocket Rate Limiting

Per-connection message rate limiting using a sliding window backed by Redis (see [Backend IM Research §7.2](../research/backend-im-state-machine.md#72-websocket-message-rate-limiting)):

```typescript
const WS_RATE_LIMITS: Record<string, { max: number; windowSec: number }> = {
  "message.send":     { max: 50, windowSec: 1 },   // 50 msg/sec
  "typing.start":     { max: 5,  windowSec: 3 },   // 5 events/3sec
  "typing.stop":      { max: 5,  windowSec: 3 },
  "presence.update":  { max: 2,  windowSec: 10 },  // 2 updates/10sec
  "channel.join":     { max: 10, windowSec: 60 },  // 10 joins/min
  "bot.command.invoke": { max: 20, windowSec: 1 }, // 20 commands/sec
};

async function checkWsRateLimit(
  userId: string,
  eventType: string,
): Promise<boolean> {
  const limit = WS_RATE_LIMITS[eventType];
  if (!limit) return true;

  const key = `ws_rl:${userId}:${eventType}`;
  const now = Math.floor(Date.now() / 1000);

  const multi = redis.multi();
  multi.zRemRangeByScore(key, 0, now - limit.windowSec);
  multi.zCard(key);
  multi.zAdd(key, { score: now, value: `${now}:${crypto.randomUUID()}` });
  multi.expire(key, limit.windowSec + 1);

  const [, count] = (await multi.exec()) as [unknown, number];
  return count < limit.max;
}

// Usage in Socket.IO event handler
socket.on("message.send", async (data, ack) => {
  const allowed = await checkWsRateLimit(socket.data.userId, "message.send");
  if (!allowed) {
    ack({ status: "failed", error: "rate_limited", retryAfterMs: 1000 });
    return;
  }
  // ... continue processing
});
```

### 6.3 Bot-Specific Rate Limits

Bot rate limits are admin-configurable per workspace:

```typescript
interface BotRateLimit {
  messagesPerMinute: number;    // default: 30
  commandsPerMinute: number;    // default: 60
  concurrentConnections: number; // default: 5
}

// Admin can update via API
app.patch("/api/v1/bots/:id/rate-limit", async (c) => {
  const botId = c.req.param("id");
  const body = await c.req.json<Partial<BotRateLimit>>();
  // Validate admin permission, persist to DB, broadcast config change via Redis
  await updateBotRateLimit(botId, body);
  await redis.publish("bot:config:updated", JSON.stringify({ botId, rateLimit: body }));
  return c.json({ ok: true });
});
```

---

## 7. Message Relay Pipeline

### 7.1 Pipeline Flow Diagram

```
Client Message
     │
     ↓
┌──────────────────┐
│ 1. Validate &    │  ← Schema validation via Zod
│    Decode        │    Reject malformed envelopes
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ 2. Auth Check    │  ← Verify userId matches token,
│                  │    check channel membership
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ 3. Rate Limit    │  ← WS-level sliding window check
└────────┬─────────┘
         │
         ↓
    ┌────┴────┐
    │ E2E?    │
    │ encrypted│── Yes ──→ Skip content validation
    │ message? │           (opaque payload)
    └────┬────┘
         │ No
         ↓
┌──────────────────┐
│ 4. Content       │  ← Validate content type, size,
│    Validation    │    attachment references
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ 5. Store         │  ← Persist to PostgreSQL via
│    (Internal)    │    internal service call;
│                  │    assign UUID v7 id
└────────┬─────────┘
         │
    ┌────┴────┐
    │ Normal  │
    │ mode?   │── No (bot/dm) ──→ skip bot dispatch
    └────┬────┘
         │ Yes
         ↓
┌──────────────────┐
│ 6. Bot Event     │  ← Publish event to Redis Streams
│    Dispatch      │    for registered bots to consume
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ 7. Broadcast to  │  ← io.to(`channel:${channelId}`)
│    Channel Room  │    .emit("message.receive", msg)
└────────┬─────────┘
         │
         ↓
┌──────────────────┐
│ 8. ACK to Sender │  ← socket.emit("message.ack", {
│                  │      clientSeq, messageId, status: "sent"
│                  │    })
└──────────────────┘
```

### 7.2 Pipeline Implementation

```typescript
// Zod schemas for incoming message validation
import { z } from "zod";

const MessageContentSchema = z.object({
  type: z.enum(["text", "image", "file", "system"]),
  text: z.string().max(40_000).optional(),
  attachments: z.array(z.object({
    fileId: z.string().uuid(),
    name: z.string().max(500),
    mimeType: z.string(),
    size: z.number().max(50 * 1024 * 1024),
    scanStatus: z.enum(["pending", "clean", "blocked"]),
    thumbnailFileId: z.string().uuid().optional(),
    // No client-provided URLs. Download URLs are issued by the core
    // Attachment Service after authz, retention, scan, and E2E checks.
  })).optional(),
  mentions: z.array(z.string().uuid()).max(50).optional(),
});

const IncomingMessageSchema = z.object({
  type: z.literal("message.send"),
  seq: z.number().int().positive().optional(),
  channelId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  payload: z.object({
    content: MessageContentSchema,
    replyToId: z.string().uuid().optional(),
    threadId: z.string().uuid().optional(),
    clientMsgId: z.string().max(64),
  }),
  timestamp: z.number(),
  encryption: z.enum(["none", "e2e"]).default("none"),
});

// Event handler
socket.on("message.send", async (rawData, ack) => {
  const userId = socket.data.userId;

  // 1. Validate & Decode
  const parsed = IncomingMessageSchema.safeParse(rawData);
  if (!parsed.success) {
    ack({ status: "failed", error: "validation_error", details: parsed.error.issues });
    return;
  }
  const { payload, channelId, workspaceId, seq, encryption } = parsed.data;

  // 2. Auth Check — verify channel membership
  const isMember = await isChannelMember(userId, channelId);
  if (!isMember) {
    ack({ status: "failed", error: "not_a_member" });
    return;
  }

  // 3. Rate Limit
  const rateOk = await checkWsRateLimit(userId, "message.send");
  if (!rateOk) {
    ack({ status: "failed", error: "rate_limited", retryAfterMs: 1000 });
    return;
  }

  // 4. E2E Check — the client hint is not trusted. The channel mode from
  // the database is authoritative and must match the requested encryption.
  let messageId: string;
  const channelMode = await getChannelMode(channelId);
  if (channelMode === "e2e" && encryption !== "e2e") {
    ack({ status: "failed", error: "encryption_required" });
    return;
  }

  if (channelMode === "e2e") {
    // Store as-is (opaque payload); no content validation
    messageId = await storeE2EMessage(userId, channelId, payload);
  } else {
    // Normal mode: store with content
    messageId = await storeMessage(userId, channelId, workspaceId, payload);
  }

  // 5. ACK back to sender immediately
  ack({ status: "sent", messageId, clientSeq: seq });

  // 6. Broadcast to channel room (including cross-pod via Redis Adapter)
  const message = await fetchMessageById(messageId);
  io.to(`channel:${channelId}`).emit("message.receive", message);

  // 7. Bot Event Dispatch (normal mode only)
  if (channelMode !== "e2e") {
    await publishBotEvent("message.created", {
      messageId,
      channelId,
      workspaceId,
      senderId: userId,
      content: payload.content,
      timestamp: Date.now(),
    });
  }
});
```

### 7.3 Pipeline Stage Responsibilities

| Stage | Responsibility | Failure Handling |
|---|---|---|
| Validate & Decode | Reject malformed messages early | Return `status: "failed"` with validation details |
| Auth Check | Verify sender is a channel member | Return `status: "failed"`, `error: "not_a_member"` |
| Rate Limit | Prevent spam/flood | Return `status: "failed"`, `error: "rate_limited"` |
| Content Validation | Normal mode: enforce max text length, attachment limits | Return `status: "failed"` with specific reason |
| Store | Persist message, assign server ID, cache in Redis Sorted Set | Retry 3x with backoff; if all fail, ACK with error |
| Bot Dispatch | Publish to Redis Streams for bot subscribers | Fire-and-forget with error logging (non-blocking) |
| Broadcast | Deliver to all online channel members | Best-effort; failed deliveries logged |
| ACK | Confirm receipt to sender | Always executed (synchronous callback) |

---

## 8. Security Headers & CORS

### 8.1 Helmet.js Configuration

```typescript
import helmet from "helmet";

const helmetConfig = helmet({
  contentSecurityPolicy: false,    // Configured separately (see §8.3)
  dnsPrefetchControl: { allow: false },
  frameguard: { action: "deny" },
  hidePoweredBy: true,
  hsts: {
    maxAge: 63_072_000,            // 2 years
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xssFilter: true,
  crossOriginEmbedderPolicy: true,
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "same-origin" },
});
```

### 8.2 CORS Configuration

```typescript
import { cors } from "hono/cors";

const ALLOWED_ORIGINS = [
  // Web app (production)
  "https://app.nexus.chat",
  // Electron renderer (dev + production)
  "http://localhost:5173",
  "http://localhost:3000",
  "app://.",
  // Electron custom protocol
  "file://",
];

app.use("*", cors({
  origin: (origin) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      return origin;
    }
    // Allow Electron's custom protocol patterns
    if (origin.startsWith("file://") || origin.startsWith("app://")) {
      return origin;
    }
    return null; // reject
  },
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "x-nxbot-token",
    "x-request-id",
  ],
  exposeHeaders: [
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "x-request-id",
  ],
  credentials: true,
  maxAge: 86_400,    // 24 hours preflight cache
}));
```

### 8.3 Content Security Policy (CSP)

```typescript
import { secureHeaders } from "hono/secure-headers";

const CSP_CONFIG = {
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "https://cdn.nexus.chat", "data:", "blob:"],
    mediaSrc: ["'self'", "https://cdn.nexus.chat"],
    connectSrc: [
      "'self'",
      "wss://gateway.nexus.chat",
      "https://api.nexus.chat",
    ],
    fontSrc: ["'self'"],
    frameSrc: ["'none'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
};
```

### 8.4 Attack Defense Summary

| Attack Vector | Defense | Implementation |
|---|---|---|
| CSRF | SameSite=Strict cookies + CORS origin whitelist + CSRF token header | Helmet + CORS middleware |
| XSS | CSP headers + input escaping + `textContent` rendering on frontend | `secureHeaders` CSP + Zod schema max-length constraints |
| Clickjacking | `X-Frame-Options: DENY` | Helmet `frameguard` |
| MIME Sniffing | `X-Content-Type-Options: nosniff` | Helmet `noSniff` |
| MITM/Downgrade | HSTS preload + TLS everywhere + cert pinning | Helmet `hsts` + Nginx TLS config |
| JWT Leakage | Short-lived access tokens (15 min) + refresh rotation + `httpOnly` cookies | JWT middleware + refresh flow (§5.1) |
| DDoS/Brute Force | Dual user + IP rate limiting at API and WS layers | `hono-rate-limiter` + WS rate limiter (§6) |
| Enumeration | Uniform response timing on auth endpoints | Constant-time comparison, no field-level hints |
| Token Replay | Token family tracking + one-time-use refresh tokens | Redis-backed refresh token rotation (§5.1) |

See [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md) for the full threat model and E2EE integration plan.

---

## Appendix: Technology Decisions

| Decision | Choice | Rationale |
|---|---|---|
| HTTP framework | Hono v4.12 | 14KB, built-in middleware, cross-runtime, <50ms cold start |
| WebSocket engine | Socket.IO v4 | Built-in rooms, heartbeat, reconnect, Redis Adapter |
| Horizontal scaling | `@socket.io/redis-adapter` | Transparent cross-pod broadcasting via Redis Pub/Sub |
| Rate limiting (REST) | `hono-rate-limiter` + Redis store | Sliding window, distributed, header-standard |
| Rate limiting (WS) | Redis Sorted Set sliding window | Atomic multi-operation, expiring keys |
| Auth | JWT (access + refresh rotation) | Stateless validation, standard, client-agnostic |
| Validation | Zod | TypeScript-first, composable, shareable with client |
| Security headers | Helmet + Hono `secureHeaders` | One-line comprehensive header hardening |
| Logging | Pino | Structured JSON, high throughput, low overhead |
