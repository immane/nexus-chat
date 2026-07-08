<p align="center">
  <img src="https://img.shields.io/badge/phase-1%20complete-blue" alt="Phase">
  <img src="https://img.shields.io/badge/coverage-100%25-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/tests-89%20passed-green" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9.15-orange" alt="pnpm">
</p>

# Nexus Chat

A Slack-like workspace chat system with **hybrid encryption**: normal channels that support bots, message history, and server-side workflows, alongside end-to-end encrypted DMs where the server sees only ciphertext. Built from the ground up in TypeScript with React, Electron, Hono, and Socket.IO.

Phase 1 delivers a monorepo with a web client, Electron desktop shell, TUI/CLI, REST/WebSocket gateway, full message state machine, bot engine with SDK, three first-party bots, Signal-style E2E service boundaries, opportunistic WebRTC P2P direct connection for 1:1 E2EE DMs, emoji reactions, message reply/forward/context menu, and real-time presence. The test suite covers 18 files, 87 tests, with 100% statement, function, and line coverage.

<p align="center">
  <img src="docs/images/login-sample.jpg" alt="Login Screen" width="30%">
  <img src="docs/images/chat-sample.jpg" alt="Chat Screen" width="30%">
  <img src="docs/images/tui-sample.jpg" alt="TUI Chat" width="30%">
</p>

---

## Table of Contents

- [Encryption Model](#encryption-model)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Message Lifecycle](#message-lifecycle)
- [Bot Framework](#bot-framework)
- [E2EE Design](#e2ee-design)
- [P2P Direct Connection](#p2p-direct-connection)
- [Security](#security)
- [API Reference](#api-reference)
- [WebSocket Protocol](#websocket-protocol)
- [Testing & Coverage](#testing--coverage)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Known Limitations](#known-limitations)
- [Contributing](#contributing)
- [License](#license)

---

## Encryption Model

Every channel and DM independently selects its encryption level. There is no global toggle.

| Mode       | Server-side content | Bots allowed                 | Server search    | Message features                                                  |
| ---------- | ------------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------- |
| **Normal** | Plaintext           | Yes                          | Future (Phase 2) | Full: reactions, edits, deletes, forwarding, saves, read receipts |
| **E2EE**   | Ciphertext only     | No — rejected at the gateway | Disabled         | Reduced: read-once, TTL expiration, tombstoned on deletion        |

**Key design properties:**

- The encryption mode is stored per-channel in the database. Clients and the server agree on it at channel creation time.
- E2EE channels only accept `content.type === "ciphertext"`. Any normal plaintext message sent to an E2EE channel returns `VALIDATION_FAILED`.
- Bots cannot join E2EE channels. If a bot attempts to join, install into, or send a message to an E2EE channel, the server returns `E2E_BOT_NOT_ALLOWED`.
- All bot events (`bot.command.invoke`, `message.created`) are suppressed for E2EE channels — the bot engine skips dispatch when `channel.mode === "e2e"`.
- E2EE attachment metadata is also gated: encrypted files must carry `scanStatus: "skipped"`. Non-skipped E2EE attachments are rejected.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Clients                                         │
│  Electron  ·  React/Vite Web  ·  TUI (Commander) │
└────────────────────────┬─────────────────────────┘
                         │  REST (Hono)  +  Socket.IO
                         ▼
┌──────────────────────────────────────────────────┐
│  Gateway Layer                                   │
│  HTTP API (CORS, Helmet, rate limiting)          │
│  WebSocket (auth, rooms, per-user rate limit)    │
│  /bots WS namespace (token auth, event polling)  │
└────────────────────────┬─────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌───────────┐  ┌──────────────┐  ┌──────────────┐
│ Auth      │  │ Workspace    │  │ Signal/E2EE  │
│  Service  │  │  Service     │  │  Service     │
│           │  │              │  │              │
│ Register  │  │ CRUD         │  │ PreKey CRUD  │
│ Login     │  │ Members/RBAC │  │ Bundle fetch │
│ Refresh   │  │ Channels/DMs │  │ OPK consume  │
│ Logout    │  │ Ownership    │  │ Sessions     │
└───────────┘  └──────────────┘  └──────────────┘
        │                │                 │
        └────────────────┼─────────────────┘
                         ▼
┌──────────────────────────────────────────────────┐
│  Message Service                                 │
│  Send · Edit · Delete · React · Forward · Save   │
│  AckRead · List · ListPage · CleanupExpired      │
│  State machine: SENDING→SENT→DELIVERED→READ      │
└────────────────────────┬─────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────┐
│  Bot Engine                                      │
│  Install · ValidateToken · Subscribe/Poll        │
│  invokeCommand · sendBotMessage · publishEvent   │
│  Inline /help handler (no connected bot needed)  │
└──────────────────────────────────────────────────┘
```

**Data layer in Phase 1:** Domain services use in-memory stores (`Map`-based). The full PostgreSQL schema (17 tables, Drizzle ORM) and Redis infrastructure are defined and validated through migrations, but the runtime store layer has not yet been wired to Postgres. The `SESSION_STORE=redis` path exercises Redis-backed refresh sessions via `RedisRefreshSessionStore`.

**Data flow for a normal message send:**

1. Web client emits `{ type: "message.send", payload: { workspaceId, channelId, clientMsgId, content } }` over Socket.IO.
2. Gateway validates the WS envelope and inner payload against Zod schemas.
3. `messageService.send()` checks channel access, mode compatibility, idempotency (`clientMsgId`), and attachment validity.
4. A new message is created with `id` (UUID v7), state `"sent"`, and stored in-memory.
5. If the channel is normal, `botService.publishEvent({ type: "message.created", ... })` dispatches to subscribed bots.
6. The gateway broadcasts `{ type: "message.created", payload: message }` to all clients in the channel room.
7. The client acknowledges with `{ type: "message.ack", payload: { messageId } }`.
8. Read receipts are buffered in memory and flushed in batches (3-second window in the design, immediate in Phase 1).

---

## Quick Start

**Prerequisites:** Node.js >=22, pnpm 9.15.x, Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The server starts on `http://127.0.0.1:4000`, the web client on `http://localhost:5173`.

**Seed credentials:**

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

You can also register users directly in the web app or via the API. See [QUICKSTART.md](QUICKSTART.md) for a detailed step-by-step guide with troubleshooting.

---

## Repository Structure

```
nexus-chat/
├── apps/
│   ├── server/           Hono REST API, Socket.IO, domain services, Drizzle
│   │   └── src/
│   │       ├── domain/   Auth, Workspaces, Messages, Bots, Signal, Attachments
│   │       ├── http/     Route handlers, middleware, rate limiting
│   │       ├── ws/       Socket.IO gateway and event dispatch
│   │       ├── db/       Drizzle schema, client, migrations, seed
│   │       ├── config/   Environment configuration
│   │       └── observability/  Pino logger, Prometheus, audit
│   ├── web/              React 19 + Vite + Zustand + Tailwind CSS
│   │   └── src/
│   │       ├── components/  App shell, channel sidebar, message list
│   │       └── stores/      Auth, workspace, channel, message, presence, UI
│   ├── desktop/          Electron main/preload with security defaults
│   └── tui/              Commander CLI + Ink interactive UI
├── packages/
│   ├── shared/           40+ Zod schemas, protocol types, API envelope helpers
│   ├── signal/           Local Signal-style facade (pre-key, encrypt/decrypt)
│   ├── bot-sdk/          NexusBotClient: WS connect, middleware, event dispatch
│   ├── ui/               Shared React primitives and design tokens
│   └── bots/
│       ├── help/         Responds to /help
│       ├── notification/ Responds to /announce
│       └── welcome/      Sends onboarding messages on member_added
├── docs/                 Architecture, research, tasks, SDK guides, beta docs
├── docker-compose.yml    PostgreSQL 16 + Redis 7
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

---

## Tech Stack

| Layer | Technology | Phase 1 role |
| --- | --- | --- |
| **Language** | TypeScript `strict` | Entire codebase |
| **Monorepo** | pnpm workspaces + Turborepo | Dependency graph, parallel builds |
| **HTTP** | Hono 4.x | All REST routes, Zod validation middleware |
| **WebSocket** | Socket.IO 4.x | Client gateway + `/bots` namespace |
| **Auth** | `@node-rs/argon2`, `jsonwebtoken` (RS256) | Password hashing, JWT sign/verify |
| **Schemas** | Zod 3.x | Every I/O boundary: API, WS, bots, E2EE |
| **ORM** | Drizzle ORM 0.38 | Schema definitions, migrations, seed |
| **Database** | PostgreSQL 16 (Docker) | Schema live; runtime uses in-memory stores |
| **Cache** | Redis 7 (Docker) | Session store (Redis mode), ready for pub/sub |
| **Frontend** | React 19, Vite, Zustand 5, Tailwind CSS, React Virtuoso | Web client |
| **Desktop** | Electron | BrowserWindow, preload IPC, tray, notifications |
| **CLI** | Commander, Ink (React 19) | TUI chat, smoke tests |
| **Observability** | Pino, `prom-client` | Structured logs, request IDs, metrics |
| **Testing** | Vitest + V8 coverage | 18 test files, 87 tests |
| **P2P** | WebRTC (browser-native, no npm deps) | 1:1 E2EE DM direct connection + server signaling relay |

---

## Message Lifecycle

### State Machine

```
DRAFT ──→ SENDING ──→ SENT ──→ DELIVERED ──→ READ
                        │
                        └──→ FAILED (retry ≤3, exponential backoff)
                              └──→ DELETED (tombstone)
```

### Idempotency

Every message carries a `clientMsgId` (client-generated unique string). The server stores a `(senderId, clientMsgId)` mapping. Duplicate sends return the existing message — no duplicate rows, no replay side effects.

### Pagination

Messages are sorted by `(channel_id, created_at DESC, id DESC)`. The API uses cursor-based pagination with the message `id` as the cursor. This avoids offset drift when new messages arrive.

### Read Receipts

Read receipts (`message.ack`) are buffered in-memory. The design calls for a 3-second Redis flush window; Phase 1 implements immediate flush via `messageService.flushReadReceipts()`.

### E2EE Message Handling

- **Read-once:** When a ciphertext message with `readOnce: true` is acknowledged, it is immediately tombstoned (`type: "tombstone"`, `reason: "read_once_consumed"`).
- **TTL expiration:** `messageService.cleanupExpiredMessages()` scans for ciphertext messages past their `expiresAt` and replaces them with `reason: "expired"` tombstones.
- **Regular deletion:** `softDelete` produces a `reason: "deleted"` tombstone. Original ciphertext is never leaked.

---

## Bot Framework

### Architecture

Bots connect to a dedicated `/bots` Socket.IO namespace with bot-specific token authentication. The namespace runs an event poll loop (500ms interval) that pushes pending events to connected bots.

### Lifecycle

1. **Install:** `POST /api/v1/bots/install` with a manifest. Returns `nxbot_v1_...` token.
2. **Channel membership:** `POST /api/v1/bots/:botId/channels/:channelId`. Bot must have `channels:read` scope.
3. **Event subscription:** `POST /api/v1/bots/subscriptions?eventType=message.created`. Subscribed events are dispatched via `dispatchToBots`.
4. **Message sending:** Bots call `POST /api/v1/bots/messages` with their token. The server validates scope (`messages:write`), channel membership, and E2EE restrictions.

### Bot SDK

```ts
import { NexusBotClient } from "@nexus-chat/bot-sdk";

const bot = new NexusBotClient({
  baseUrl: "http://127.0.0.1:4000",
  token: "nxbot_v1_...",
  manifest: {
    id: "my-bot",
    name: "MyBot",
    commands: [{ name: "/echo", description: "Echo input" }],
    scopes: ["commands:handle", "messages:write"]
  }
});

bot.use(async (event, next) => { /* middleware */ await next(); });
bot.onCommand("/echo", async (event) => { /* handle command */ });
bot.onEvent("message.created", async (event) => { /* handle event */ });
bot.connect();
```

**SDK features:**
- Automatic reconnect with exponential backoff and jitter (max 10 retries, 1s-30s window).
- Middleware pipeline with `use()`.
- Type-safe `sendMessage()`, `getChannelInfo()`, `subscribe()`/`unsubscribe()` REST helpers.
- `redactToken()` utility for log safety.

### Inline `/help`

The server handles `/help` without requiring a connected bot client. `botService.invokeCommand` detects `command === "/help"`, finds any installed bot whose manifest declares a `/help` command, generates a response message listing all commands, and broadcasts it to the channel. This works even when no bot is connected to `/bots`.

### Event Types

| Event | Trigger |
| --- | --- |
| `bot.command.invoke` | User sends a slash command via WS |
| `message.created` | A normal-mode message is sent |
| `workspace.member_added` | A member joins a workspace |

---

## E2EE Design

### Service Boundary

The `signalService` in `apps/server/src/domain/signal/service.ts` provides the server-side pre-key infrastructure:

- **Upload bundle:** Store identity key, signed pre-key, and optional one-time pre-keys.
- **Fetch bundle:** Retrieve a pre-key bundle and transactionally consume one one-time pre-key.
- **Consume one-time pre-key:** Mark a specific OPK as consumed (idempotent; returns `CONFLICT` if already consumed).
- **Session storage:** Store Signal sessions linked to owner and peer user IDs.

### Client Facade

`packages/signal` provides a local facade with `generateIdentity`, `generatePreKeyBundle`, `encryptMessage`, and `decryptMessage`. This is used in tests and smoke scripts. Production Signal Protocol integration (`@signalapp/libsignal-client`) is an AGPL-3.0 dependency evaluated for licensing impact.

### E2EE Channel Restrictions

- Only `content.type === "ciphertext"` is accepted.
- Bots are rejected at gateway, service, and channel membership levels.
- Attachments must carry `scanStatus: "skipped"` — no server-side virus scanning.
- Server-side message events (`message.created`) are suppressed for E2EE channels.

### P2P Direct Connection

1:1 E2EE DMs opportunistically bypass the server using WebRTC Data Channels. The server relays only SDP/ICE signaling — never message data.

```
Alice ═══ WebRTC Data Channel ═══► Bob     (preferred, DTLS + Signal encrypted)
  │                                  │
  └── WebSocket signaling ──► Server ◄── signaling reply ──┘
```

**Connection strategy:**

1. When sending an E2EE DM, the client checks for an active WebRTC connection to the peer.
2. If none exists, it initiates a WebRTC handshake: SDP offer/answer + ICE candidates are exchanged via server WebSocket signaling (`p2p.offer`, `p2p.answer`, `p2p.ice-candidate`).
3. If the connection succeeds within 5 seconds → messages flow over the data channel.
4. If WebRTC fails (NAT/firewall) → transparent fallback to the existing server-relayed WebSocket path.
5. After a failed attempt, the peer enters a 30-second cooldown period before retrying.

**Key properties:**

- No npm dependencies — WebRTC is browser-native (`RTCPeerConnection`, `RTCDataChannel`).
- Double encryption: DTLS (transport) + Signal Protocol (application).
- Server never sees P2P message content, timestamps, or counts — only signaling metadata.
- TUI/CLI clients stay relay-only (Node.js lacks native WebRTC).

**Implementation:** `apps/web/src/lib/p2p/` — `P2pConnectionPool`, `HybridTransport`, signaling handler.

---

## Security

| Layer | Implementation |
| --- | --- |
| Password hashing | Argon2id (`memoryCost: 65536, timeCost: 3, parallelism: 4`) |
| Access tokens | JWT RS256, 15-minute expiry, `sub` claim |
| Refresh tokens | Opaque `nxrefresh_...`, 7-day expiry, single-use rotation, replay detection |
| Session backend | `InMemoryRefreshSessionStore` (dev) or `RedisRefreshSessionStore` |
| Rate limiting | Per-IP login rate limiter + per-user WS event limiter (50 events/10s) |
| CORS | Configurable origin via `WEB_ORIGIN` |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection` |
| Log redaction | Pino redaction for secrets, tokens, passwords |
| Audit trail | In-memory audit events for auth, workspace, channel, bot, and attachment actions |

---

## API Reference

All routes are mounted under `/api/v1`. Authenticated routes require `Authorization: Bearer <accessToken>`.

### Auth

| Method | Path | Body/Notes |
| --- | --- | --- |
| `POST` | `/auth/register` | `{ email, password, displayName }` |
| `POST` | `/auth/login` | `{ email, password }` — rate-limited per IP+email |
| `POST` | `/auth/refresh` | `{ refreshToken }` — rotates token, detects replay |
| `POST` | `/auth/logout` | `{ refreshToken }` — revokes session |
| `GET` | `/auth/me` | Returns current user |

### Workspaces

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/workspaces` | `{ name }` — auto-creates #general channel |
| `GET` | `/workspaces` | List user's workspaces |
| `GET` | `/workspaces/:id` | Get workspace details |
| `PATCH` | `/workspaces/:id` | `{ name }` — owner/admin only |
| `POST` | `/workspaces/:id/members` | `{ userId, role }` — add member |
| `DELETE` | `/workspaces/:id/members/:userId` | Remove member |
| `GET` | `/workspaces/:id/members` | List members |
| `POST` | `/workspaces/:id/transfer-ownership` | `{ newOwnerUserId }` |

### Channels & DMs

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/workspaces/:id/channels` | `{ name, mode, isPrivate }` |
| `GET` | `/workspaces/:id/channels` | List accessible channels |
| `POST` | `/channels/:id/members` | `{ userId }` |
| `DELETE` | `/channels/:id/members/:userId` | |
| `GET` | `/channels/:id/members` | |
| `POST` | `/channels/:id/archive` | |
| `DELETE` | `/channels/:id` | Soft delete |
| `POST` | `/dms?workspaceId=...` | `{ peerUserId, mode }` — idempotent |

### Messages

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/messages` | `{ workspaceId, channelId, clientMsgId, content }` |
| `GET` | `/channels/:id/messages` | `?cursor=&limit=` — cursor pagination |
| `PATCH` | `/messages/:id` | `{ text }` — edit own text messages only |
| `DELETE` | `/messages/:id` | Soft delete → tombstone |
| `POST` | `/messages/:id/reactions` | `{ emoji }` — toggle add/remove |
| `POST` | `/messages/:id/forward` | `{ targetChannelId, clientMsgId }` |
| `POST` | `/messages/:id/save` | Bookmark message |

### Bots

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/bots/install?workspaceId=...` | `BotManifest` — returns token |
| `POST` | `/bots/:botId/channels/:channelId` | Add bot to channel |
| `DELETE` | `/bots/:botId/channels/:channelId` | Remove bot from channel |
| `POST` | `/bots/subscriptions?eventType=...` | Subscribe (bot token auth) |
| `DELETE` | `/bots/subscriptions?eventType=...` | Unsubscribe (bot token auth) |
| `GET` | `/bots/:botId/subscriptions` | |
| `POST` | `/bots/messages` | Bot-authenticated message send |
| `POST` | `/bots/commands` | HTTP fallback for command invocation |

### Signal / E2EE

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/signal/prekey-bundles` | Upload identity + pre-keys |
| `GET` | `/signal/prekey-bundles/:userId/:deviceId` | Fetch and consume OPK |
| `POST` | `/signal/prekey-bundles/:userId/:deviceId/consume?keyId=` | Explicit OPK consumption |
| `GET` | `/signal/prekey-bundles/:userId/:deviceId/count` | Remaining OPK count |
| `POST` | `/signal/sessions?peerUserId=&deviceId=` | Store session |
| `GET` | `/signal/sessions` | List user sessions |
| `GET` | `/signal/sessions/:id` | Get session |

### Attachments

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/attachments/upload-sessions` | Create presigned session |
| `POST` | `/attachments/upload-sessions/:id/complete` | Mark upload done |
| `GET` | `/attachments/:fileId` | File metadata |
| `POST` | `/attachments/:fileId/download-url` | Generate download URL |

### Ops

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/healthz` | `{ status: "ok" }` |
| `GET` | `/metrics` | Prometheus text format |

---

## WebSocket Protocol

Clients connect to the main namespace with JWT auth and automatically join rooms for every accessible channel (`channel:<id>`) and their user inbox (`user:<userId>`).

### Client → Server events

| Event | Payload | Notes |
| --- | --- | --- |
| `message.send` | `{ workspaceId, channelId, clientMsgId, content }` | Creates and broadcasts message |
| `message.ack` | `{ messageId }` | Marks as read, flushes receipts |
| `bot.command.invoke` | `{ type, workspaceId, channelId, botName, command, args[] }` | Routes to bot engine |
| `typing.start` | `{ workspaceId, channelId }` | Broadcasts `typing.updated` |
| `typing.stop` | `{ workspaceId, channelId }` | Broadcasts `typing.updated` |
| `presence.update` | `{ status }` | Sends `presence.updated` to self |
| `p2p.offer` | `{ targetUserId, sdp }` | Relayed to peer for WebRTC handshake |
| `p2p.answer` | `{ targetUserId, sdp }` | Relayed to peer for WebRTC handshake |
| `p2p.ice-candidate` | `{ targetUserId, candidate }` | Relayed to peer for NAT traversal |
| `p2p.hangup` | `{ targetUserId }` | Relayed to peer to close P2P connection |
| `p2p.status` | `{ targetUserId, status }` | Logged server-side only |

### Server → Client events

| Event | Payload |
| --- | --- |
| `message.created` | Full `Message` object |
| `message.updated` | Updated `Message` |
| `message.deleted` | Tombstoned `Message` |
| `message.reaction` | `{ messageId, emoji, count, reacted }` |
| `message.read` | `{ messageId, channelId, readCount, readers[], flushedAt }` |
| `typing.updated` | `{ userId, channelId, workspaceId, typing }` |
| `presence.updated` | `{ userId, status }` |

---

## Testing & Coverage

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm coverage && pnpm build
```

**Coverage** (V8, workspace-wide):

| Metric | Value |
| --- | --- |
| Statements | 100.00% |
| Branches | 92.62% |
| Functions | 100.00% |
| Lines | 100.00% |

**Test breakdown (18 files, 89 tests):**

| Package | Test file | Tests |
| --- | --- | --- |
| `@nexus-chat/server` | `domain/services.test.ts` | 20 |
| `@nexus-chat/server` | `ws/gateway.test.ts` | 9 |
| `@nexus-chat/server` | `http/routes.test.ts` | 4 |
| `@nexus-chat/server` | `observability/audit.test.ts` | 4 |
| `@nexus-chat/server` | `domain/auth/session-store.test.ts` | 2 |
| `@nexus-chat/server` | `observability/logger.test.ts` | 1 |
| `@nexus-chat/server` | `db/schema.test.ts` | 2 |
| `@nexus-chat/bot-sdk` | `index.test.ts` | 11 |
| `@nexus-chat/shared` | `index.test.ts` | 6 |
| `@nexus-chat/web` | `stores/domain.test.ts` | 4 |
| `@nexus-chat/web` | `components/App.test.tsx` | 3 |
| `@nexus-chat/web` | `lib/p2p/transport.test.ts` | 5 |
| `@nexus-chat/help-bot` | `index.test.ts` | 2 |
| `@nexus-chat/notification-bot` | `index.test.ts` | 2 |
| `@nexus-chat/welcome-bot` | `index.test.ts` | 2 |
| `@nexus-chat/signal` | `index.test.ts` | 3 |
| `@nexus-chat/tui` | `index.test.ts` | 5 |
| `@nexus-chat/desktop` | `config.test.ts` | 4 |

CI runs on every push: lint, typecheck, test, coverage, build, dependency audit, and TUI smoke tests.

---

## Configuration

Copy `.env.example` to `.env`. All variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment |
| `HOST` | `127.0.0.1` | Server bind address; use `0.0.0.0` for Docker/LAN/public host access |
| `PORT` | `4000` | HTTP + WebSocket server port |
| `WEB_ORIGIN` | `http://localhost` | CORS/WebSocket allowed browser origin; use `*` only for temporary local/LAN testing |
| `DATABASE_URL` | `postgres://nexus:nexus@localhost:5432/nexus_chat` | PostgreSQL connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `SESSION_STORE` | `memory` | `memory` or `redis` |
| `JWT_ISSUER` | `nexus-chat` | `iss` claim |
| `JWT_AUDIENCE` | `nexus-chat-clients` | `aud` claim |
| `JWT_KID` | `local-dev` | Key ID in JWT header |
| `JWT_PRIVATE_KEY_PEM` | *(auto-generated)* | RS256 signing key |
| `JWT_PUBLIC_KEY_PEM` | *(auto-generated)* | RS256 verification key |
| `LOG_LEVEL` | `info` | Pino log level |
| `API_PUBLIC_BASE` | `http://127.0.0.1:4000` | Public API URL embedded in dev upload/download URLs |
| `VITE_API_BASE` | `http://127.0.0.1:4000` | Web client API URL |
| `OBJECT_STORAGE_ENDPOINT` | `http://localhost:9000` | S3-compatible endpoint |
| `OBJECT_STORAGE_BUCKET` | `nexus-chat-local` | Storage bucket name |
| `NEXUS_STUN_SERVERS` | `stun:stun.l.google.com:19302` | WebRTC STUN servers (comma-separated) |
| `NEXUS_TURN_SERVERS` | *(empty)* | WebRTC TURN servers (comma-separated) |
| `NEXUS_TURN_USERNAME` | *(empty)* | TURN authentication username |
| `NEXUS_TURN_CREDENTIAL` | *(empty)* | TURN authentication credential |
| `NEXUS_P2P_CONNECTION_TIMEOUT_MS` | `5000` | WebRTC connection timeout in ms |
| `NEXUS_P2P_RELAY_COOLDOWN_MS` | `30000` | Cooldown after failed P2P attempt in ms |

For host or LAN access, set all externally visible URLs to the same host name or IP:

```env
HOST=0.0.0.0
WEB_ORIGIN=http://192.168.1.20:5173
VITE_API_BASE=http://192.168.1.20:4000
API_PUBLIC_BASE=http://192.168.1.20:4000
```

TUI clients can connect to that host with `NEXUS_API_BASE=http://192.168.1.20:4000`. Desktop uses the same Web renderer, so build it with `VITE_API_BASE` set to the host API URL.

---

## Documentation

| Document | Content |
| --- | --- |
| [QUICKSTART.md](QUICKSTART.md) | Step-by-step local setup with troubleshooting |
| [docs/ai/context.md](docs/ai/context.md) | Full session context for AI agents |
| [docs/design/](docs/design/) | Architecture documents (7 docs, 5 layers + P2P + roadmap) |
| [docs/research/](docs/research/) | Technical surveys: backend, frontend, E2EE, bots, UI, AI |
| [docs/tasks/](docs/tasks/) | 18 implementation task breakdowns |
| [docs/sdk/](docs/sdk/) | Bot SDK guides (Node.js, Java, Python, PHP, Go, Rust) |
| [docs/beta-checklist.md](docs/beta-checklist.md) | Closed beta readiness checklist |
| [docs/backup-restore.md](docs/backup-restore.md) | Backup and recovery procedures |
| [docs/known-limitations.md](docs/known-limitations.md) | Phase 1 limitations and planned resolutions |

---

## Known Limitations

Phase 1 is a local-development and closed-beta milestone. Key limitations:

- **In-memory stores:** Domain services use `Map`-based state. PostgreSQL schema and migrations are defined, but the runtime persistence layer is not wired. Redis is available for session storage via `SESSION_STORE=redis`.
- **Single-device E2EE:** One device per user. Multi-device support and group E2EE (Sender Key) are deferred.
- **No full-text search:** Message search is limited to cursor-based pagination. `tsvector` indexing is planned for Phase 2.
- **No WebSocket horizontal scaling:** Socket.IO runs single-process without Redis Adapter in dev.
- **Electron packaging:** No production code signing, notarization, or auto-update publishing.
- **Attachment UX:** Server-side attachment primitives exist; web/desktop upload UI is not built.
- **P2P client support:** WebRTC-based P2P direct connection is available in web (browser) and Electron clients. TUI/CLI remains server-relay-only (Node.js lacks native `RTCPeerConnection`).

See [docs/known-limitations.md](docs/known-limitations.md) for the complete list.

---

## Contributing

- **Language:** All documentation, comments, and commit messages in English.
- **Code style:** TypeScript strict mode, ESLint, Prettier. No `any` without justification.
- **Validation:** Zod at every I/O boundary (HTTP, WS, bot events, E2EE metadata).
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).
- **Before PR:** `pnpm lint`, `pnpm typecheck`, `pnpm test`.

See `AGENTS.md` for the full convention reference.

---

## License

MIT — see [LICENSE](LICENSE).
