---
lang: en
---

# Nexus Chat — System High-Level Architecture Design

> **Document version**: v1.0  
> **Last updated**: 2026-06-24  
> **Status**: Draft  
> **References**:
> - [Frontend Architecture Research](../research/frontend-architecture.md)
> - [IM Backend Architecture Research](../research/backend-im-state-machine.md)
> - [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md)
> - [Bot Engine & Microservices Research](../research/bot-engine-microservices.md)
> - [Base Bot Catalog Research](../research/base-bot-catalog.md)
> - [AI Agent Orchestration Research](../research/ai-agent-orchestration.md)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Layers](#2-architecture-layers)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Tech Stack Summary](#4-tech-stack-summary)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [Deployment Architecture](#6-deployment-architecture)
7. [Phase Roadmap](#7-phase-roadmap)
8. [Related Design Documents](#8-related-design-documents)

---

## 1. System Overview

### 1.1 Project Vision

Nexus Chat is a **Slack-like instant messaging (IM) platform** built as an Electron desktop application, a Phase 1 terminal UI client, and a Node.js backend. It supports workspaces, channels, direct messages (DMs), threaded conversations, file sharing, and an extensible bot framework — all delivered as a **SaaS multi-tenant cloud deployment**.

### 1.2 Core Differentiator: Hybrid Encryption Modes

Every channel and DM in Nexus Chat operates in one of two encryption modes, selectable at creation time:

| Mode | Label | Capabilities | Limitations |
|------|-------|-------------|-------------|
| **Normal** | `normal` | Full IM features + Bot integration + server-side search/indexing | Messages are readable by the server |
| **End-to-End Encrypted** | `e2e` | IM only (text, attachments), read-once/disappearing messages; server is opaque relay | No bot participation; no server-side search; no message previews |

Key design implications of the hybrid model:

- **Normal channels** allow bots to participate in conversations, execute slash commands, and react to message events. The server processes and stores message content in plaintext (encrypted at rest via PostgreSQL TDE or filesystem encryption).
- **E2E channels** use the [Signal Protocol](https://github.com/signalapp/libsignal) (`@signalapp/libsignal`). The server sees only ciphertext blobs, encrypted metadata, and lifecycle policy metadata for read-once/disappearing messages. Key exchange, ratchet advancement, and message decryption happen exclusively on clients. The server's role is reduced to store-and-forward relay plus tombstone/expiry enforcement without plaintext access.
- A single workspace can contain both normal and E2E channels side-by-side. The mode badge is visible in the channel sidebar.

For detailed E2EE threat modeling and Signal Protocol integration design, see [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md).

### 1.3 Multi-Tenant SaaS Architecture

The platform follows a standard SaaS multi-tenant model:

- A **tenant** maps to a **Workspace** — an isolated namespace containing users, channels, bots, and files.
- Workspace data is logically separated at the application layer (workspace-scoped queries with `workspaceId` foreign keys). No shared database-per-tenant strategy is used in Phase 1 (single PostgreSQL cluster for all tenants).
- Authentication is workspace-scoped: a user may belong to multiple workspaces and switch between them in the client.

---

## 2. Architecture Layers

```
┌──────────────────────────────────────────────────────────────────┐
│                    Client Shell (Electron)                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              UI Rendering (React 19 + Vite 7)              │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │  │
│  │  │ Sidebar  │  │ Chat View│  │ Thread   │  │ Settings  │  │  │
│  │  │ Panel    │  │ (Virtuoso│  │ Panel    │  │ Panel     │  │  │
│  │  │          │  │  virtual)│  │          │  │           │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │  │
│  │                    Zustand State Layer                      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │  │
│  │  │ Message  │  │ Channel  │  │ User/    │  │ UI State  │  │  │
│  │  │ Store    │  │ Store    │  │ Presence │  │ Store     │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └───────────┘  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────────────┐  │  │
│  │  │ Offline  │  │ Signal   │  │ IndexedDB / localStorage │  │  │
│  │  │ Queue    │  │ Protocol │  │ (persistence)            │  │  │
│  │  └──────────┘  │ Client   │  └──────────────────────────┘  │  │
│  │                └──────────┘                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Preload Bridge (contextBridge + IPC)           │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │         Main Process (Node.js)                              │  │
│  │  ├── Window Manager  ├── Tray & Notifications              │  │
│  │  ├── Auto Updater    ├── Network Monitor                    │  │
│  │  └── Offline Cache (protocol.handle)                        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTPS / WSS
                              │ (REST API + WebSocket)
┌─────────────────────────────┴────────────────────────────────────┐
│               Long Connection & Core Gateway                      │
│  ┌──────────────────────────┐  ┌──────────────────────────────┐  │
│  │   Hono HTTP Server        │  │   Socket.IO WebSocket Server │  │
│  │  ├── Auth (JWT + Session) │  │  ├── Auth Middleware         │  │
│  │  ├── REST API Routes      │  │  ├── Connection Manager     │  │
│  │  ├── Rate Limiter         │  │  ├── Room/Channel Routing   │  │
│  │  ├── CORS / Helmet / CSP  │  │  ├── Message ACK + Retry   │  │
│  │  └── Zod Validation       │  │  └── Heartbeat (25s/20s)   │  │
│  └──────────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│            Business Logic & Persistence Backend                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Auth     │  │ Workspace│  │ Channel  │  │ Message Service  │  │
│  │ Service  │  │ Service  │  │ Service  │  │ ├── Send/Receive │  │
│  │          │  │          │  │          │  │ ├── Edit/Delete  │  │
│  │          │  │          │  │          │  │ ├── Pagination   │  │
│  │          │  │          │  │          │  │ └── Read Receipts│  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────────────────┐ │
│  │ Signal   │  │ Attach.  │  │ Bot Router + Event Bus           │ │
│  │ Key      │  │ Service  │  │ (Redis Streams → NATS Phase 2)   │ │
│  │ Service  │  │          │  │                                  │ │
│  └──────────┘  └──────────┘  └──────────────────────────────────┘ │
│                                                                   │
│  ┌────────────────────────┐  ┌────────────────────────────────┐  │
│  │  PostgreSQL             │  │  Redis                         │  │
│  │  ├── Users              │  │  ├── Session / Auth Token      │  │
│  │  ├── Workspaces         │  │  ├── Online Presence           │  │
│  │  ├── Channels           │  │  ├── Channel Members (cache)   │  │
│  │  ├── Messages (JSONB)   │  │  ├── Recent Messages (hot)     │  │
│  │  ├── Attachments / Files│  │  ├── Read Cursors             │  │
│  │  ├── Read Receipts      │  │  ├── Rate Limit Counters       │  │
│  │  └── Signal Key Bundles │  │  └── Socket.IO Pub/Sub Adapter│  │
│  └────────────────────────┘  └────────────────────────────────┘  │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│           Async Bot Engine & Event Dispatch                       │
│  ┌─────────────────────┐  ┌───────────────┐  ┌────────────────┐  │
│  │ Event Listener      │  │ Bot SDK       │  │ Bot WebSocket  │  │
│  │ (Redis Streams      │  │ (Multi-lang    │  │ Connection     │  │
│  │  Consumer Group)    │  │  SDK for devs) │  │ (per-bot WS)   │  │
│  └────────┬────────────┘  └───────────────┘  └────────────────┘  │
│           │                                                       │
│  ┌────────┴──────────────────────────────────────────────────┐   │
│  │ Bot Command Router                                         │   │
│  │ ├── /slash commands → per-bot BullMQ queues                │   │
│  │ ├── @mentions → event dispatch                             │   │
│  │ ├── Interactive (buttons, modals)                          │   │
│  │ └── Streaming relay (stream_start/chunk/end/cancel)        │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌───────────────┐  ┌───────────────┐  ┌────────────────────┐   │
│  │ Built-in Bots │  │ @AIBot        │  │ @FileBot           │   │
│  │ (Welcome/Help │  │ (LLM/Agent/   │  │ (UX/workflow over  │   │
│  │  Notify/Poll/ │  │  Tools)       │  │  Attachment Svc)   │   │
│  │  Remind/Kudos)│  │               │  │                    │   │
│  └───────────────┘  └───────────────┘  └────────────────────┘   │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │ 3rd-party Bots (any language — SDK: TS/Java/Py/PHP/Go/Rs) │   │
│  │ ├── GitHub/GitLab Bot    ├── CI/CD Bot    ├── Standup Bot  │   │
│  │ ├── Todo Bot             ├── Status Bot   └── ...          │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Key Components |
|-------|---------------|----------------|
| **Client Shell** | Desktop runtime, native OS integration, offline persistence, Signal Protocol E2EE client | Electron main process, preload bridge, Zustand stores, IndexedDB |
| **Core Gateway** | Authentication, request validation, WebSocket connection management, rate limiting, message routing | Hono HTTP server, Socket.IO server, Redis Adapter for horizontal WebSocket scaling |
| **Business Logic Backend** | Domain logic for auth, workspaces, channels, messages, Signal key distribution, attachment lifecycle, and bot event routing. Bots may initiate workflows, but core owns persistence, authorization, indexing, encryption boundaries, and lifecycle-critical state. | Service modules, Drizzle ORM, PostgreSQL, Redis caching layers, Attachment Service |
| **Async Bot Engine** | Decoupled bot lifecycle, event-driven message processing, multi-language Bot SDK, streaming relay, built-in bots (@AIBot, @FileBot, @WelcomeBot, etc.), third-party bot hosting | Redis Streams consumer groups, BullMQ per-bot queues, Bot WebSocket connections, slash-command router, chunk batcher |

---

## 3. Monorepo Structure

```
nexus-chat/
├── apps/
│   ├── server/                 # Hono + Socket.IO backend application
│   │   ├── src/
│   │   │   ├── index.ts        # Entry point (Hono serve + Socket.IO attach)
│   │   │   ├── routes/         # REST API route handlers
│   │   │   ├── services/       # Business logic (auth, workspace, channel, message)
│   │   │   ├── ws/             # WebSocket event handlers, connection manager
│   │   │   ├── middleware/     # Helmet, CORS, rate-limiter, JWT guard
│   │   │   ├── db/             # Drizzle schema, migrations, seed scripts
│   │   │   ├── bot/            # Bot engine: event bus, router, bot WS manager
│   │   │   └── lib/            # Utilities (pagination, id generation, logging)
│   │   ├── drizzle/            # Drizzle migration files
│   │   └── package.json
│   │
│   ├── web/                    # Vite + React renderer application
│   │   ├── src/
│   │   │   ├── main.tsx        # React entry point
│   │   │   ├── App.tsx         # Root layout + routing
│   │   │   ├── components/     # UI components (shared + page-specific)
│   │   │   ├── pages/          # Page-level components
│   │   │   ├── stores/         # Zustand stores (message, channel, user, ui, etc.)
│   │   │   ├── hooks/          # Custom React hooks
│   │   │   ├── lib/            # API client, WebSocket client, crypto utils
│   │   │   └── styles/         # Tailwind CSS theme + global styles
│   │   └── package.json
│   │
│   ├── desktop/                # Electron main process + preload
│   │   ├── src/
│   │   │   ├── main.ts         # Electron entry, window creation, tray
│   │   │   ├── preload.ts      # contextBridge API exposure
│   │   │   ├── ipc-handlers.ts # IPC handler registration
│   │   │   ├── window-manager.ts
│   │   │   ├── tray.ts         # System tray icon
│   │   │   ├── notifications.ts
│   │   │   ├── updater.ts      # Auto-update logic
│   │   │   ├── offline-cache.ts # protocol.handle offline cache
│   │   │   └── network-monitor.ts
│   │   └── package.json
│   │
│   └── tui/                    # Ink + Commander terminal client
│       ├── src/
│       │   ├── cli.ts          # Command entry point
│       │   ├── app.tsx         # Interactive TUI root
│       │   ├── api-client.ts   # REST + WebSocket client
│       │   ├── signal.ts       # E2E helper using packages/signal
│       │   └── commands/       # login, send, read, e2e-smoke, bot-smoke
│       └── package.json
│
├── packages/
│   ├── shared/                 # Shared types, constants, validation schemas
│   │   ├── src/
│   │   │   ├── types/          # Message, Channel, User, Workspace types
│   │   │   ├── schemas/        # Zod validation schemas (shared between client & server)
│   │   │   ├── constants/      # Event names, error codes, status enums
│   │   │   └── utils/          # Shared utility functions
│   │   └── package.json
│   │
│   ├── signal/                 # @signalapp/libsignal abstraction layer
│   │   ├── src/
│   │   │   ├── protocol.ts     # Key generation, PreKey bundle management
│   │   │   ├── session.ts      # Session cipher (encrypt/decrypt per session)
│   │   │   ├── store.ts        # Signal Protocol Store implementation
│   │   │   └── group.ts        # Group messaging (Sender Key distribution)
│   │   └── package.json
│   │
│   ├── bot-sdk/                # Bot development SDK for third-party developers
│   │   ├── src/
│   │   │   ├── client.ts       # Bot WebSocket client
│   │   │   ├── handler.ts      # Event handler registration
│   │   │   ├── commands.ts     # Slash command builder
│   │   │   └── types.ts        # Bot-specific type definitions
│   │   └── package.json
│   │
│   └── ui/                     # Shared UI component library (shadcn/ui based)
│       ├── src/
│       │   ├── components/     # Button, Input, Dialog, Avatar, etc.
│       │   ├── hooks/          # Shared UI hooks
│       │   └── lib/            # cn() utility, CVA variants
│       └── package.json
│
├── docs/
│   ├── research/               # Technology research reports
│   ├── design/                 # Architecture & design documents
│   └── ai/                     # AI-assisted development context
│
├── turbo.json                  # Turborepo pipeline configuration
├── pnpm-workspace.yaml         # pnpm workspace definition
├── package.json                # Root package.json (scripts + devDependencies)
└── tsconfig.base.json          # Shared TypeScript configuration
```

### Cross-Package Dependency Graph

```
apps/desktop ──→ apps/web ──→ packages/ui
    │                │
    │                ├──→ packages/shared
    │                ├──→ packages/signal
    │                └──→ packages/bot-sdk
    │
     └──→ apps/server ──→ packages/shared
                          └──→ packages/signal

apps/tui ───────→ packages/shared
    └───────────→ packages/signal
```

---

## 4. Tech Stack Summary

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Desktop Shell** | Electron | ^42.5 | Cross-platform desktop, mature ecosystem, native OS integration |
| **UI Framework** | React 19 + Vite 7 | ^19.0 / ^7.0 | Concurrent features (`useTransition`, `useDeferredValue`), fast HMR, ESM-native |
| **Build Integration** | vite-plugin-electron | ^1.0.4 | Flexible Vite+Electron integration, supports multi-env mode, notBundle for fast HMR |
| **State Management** | Zustand | ^5.0 | Lightweight, selector-precision rendering, Map-based normalized storage, middleware ecosystem |
| **Styling** | Tailwind CSS v4 + CVA | ^4.0 / ^0.4 | Utility-first with CSS-variable design tokens, `class-variance-authority` for component variants |
| **Virtual Scrolling** | react-virtuoso | latest | Built-in bidirectional infinite scroll, auto-follow-output, sticky group headers |
| **UI Primitives** | shadcn/ui (cherry-picked) | latest | Accessible Radix UI primitives, copy-paste ownership, Tailwind v4 compatible |
| **Terminal UI** | Ink + Commander | latest | React-style terminal rendering plus deterministic non-interactive commands for smoke tests |
| **HTTP Server** | Hono | ^4.12 | Cold start <50ms, cross-runtime (Node/Bun/CF Workers), built-in middleware (CORS, JWT, rate-limiter), RPC type sharing |
| **WebSocket** | Socket.IO v4 + Redis Adapter | ^4.8 / ^8.3 | Room/channel management, reconnect, heartbeat, ACK built-in; Redis Adapter for horizontal scaling |
| **ORM** | Drizzle ORM | ^0.40 | Type-safe SQL, lightweight, native PostgreSQL JSONB support, cursor pagination |
| **Database** | PostgreSQL 16+ | — | ACID compliance, JSONB for polymorphic message content, mature indexing, UUID v7 support |
| **Cache / Pub/Sub** | Redis 7+ | — | Multi-layer caching (session, presence, hot messages, read cursors), Pub/Sub for Socket.IO horizontal scaling, rate limiting |
| **Event Bus (Phase 1)** | Redis Streams | built-in via ioredis | Zero-cost event bus on existing Redis; consumer groups for bot engine |
| **Event Bus (Phase 2+)** | NATS JetStream | latest | Subject-hierarchy routing, persistence, cross-cluster federation, <0.5ms p50 latency |
| **Encryption** | @signalapp/libsignal | latest | Signal Protocol (X3DH key agreement + Double Ratchet), FOSS, audited |
| **Validation** | Zod | ^3.23 | Runtime type validation at API boundaries, schema sharing between client and server |
| **Logging** | Pino | ^9.5 | High-performance structured JSON logging, negligible overhead |
| **File Storage** | Core Attachment Service + S3-compatible storage (R2 / MinIO) | — | Core owns upload sessions, authorization, scan status, object keys, signed URLs, and E2E opaque blobs; @FileBot only provides file-management UX/workflows |
| **Package Manager** | pnpm + Turborepo | latest | Fast, disk-efficient, parallel builds with dependency-aware pipeline |
| **Packaging** | electron-builder + electron-updater | ^26.0 / ^6.3 | Cross-platform packaging, GitHub Releases auto-update |
| **AI SDK** | Vercel AI SDK v6 (Phase 2), LangGraph (Phase 3) | — | Streaming-first, MCP support, TypeScript-native |
| **Vector Store** | pgvector (PostgreSQL extension, Phase 3) | — | In-database semantic search after core full-text search, retention, and deletion semantics are stable |
| **LLM Providers** | OpenAI / Anthropic / Google / OpenRouter / Ollama | — | Multi-provider abstraction |

---

## 5. Data Flow Diagrams

### 5.1 Normal Mode Message Flow

```
Sender Client                  Gateway/Server                   Recipient Client(s)
     │                              │                                  │
     │ 1. message:send ────────────→│                                  │
     │    {channelId, clientMsgId,  │                                  │
     │     content}                 │                                  │
     │                              │ 2. Auth + Rate Limit Check       │
     │                              │ 3. Idempotency Check (Redis)     │
     │                              │ 4. Validate Content (Zod)        │
     │                              │ 5. INSERT INTO messages          │
     │                              │    (assign server ID, UUID v7)   │
     │ 6. message:ack ─────────────│                                  │
     │    {messageId, status:      │                                  │
     │     "sent"}                  │                                  │
     │                              │ 7. Cache → Redis (ZADD hot)      │
     │                              │ 8. Publish Event → Redis Streams │
     │                              │ 9. Bot Engine consumes event     │
     │                              │    (if channel has bots)         │
     │                              │10. message:new ─────────────────→│
     │                              │    {full Message object}         │
     │                              │                                  │
     │                              │11. ← message:delivered ─────────│
     │                              │    {messageId, userId}           │
     │12. ← message:delivered ─────│                                  │
     │                              │                                  │
     │                              │13. ← message:read ──────────────│
     │                              │    {channelId, userId,           │
     │                              │     lastReadMessageId}           │
     │14. ← message:read ──────────│                                  │
     │                              │15. Read Receipt Aggregator       │
     │                              │    (buffer 3s → batch UPSERT)    │
```

**Key characteristics:**

- Server is the source of truth for message IDs (UUID v7, time-ordered).
- `clientMsgId` provides idempotency: if the same message is retried due to network issues, the server deduplicates via Redis (`dedup:{clientMsgId}`).
- Messages are stored as plaintext in PostgreSQL (server-readable). For normal mode, server-side search and bot participation are possible.
- Read receipts are aggregated in a 3-second buffer, then batch-upserted to PostgreSQL to avoid write amplification (see [IM Backend Research §3.5](../research/backend-im-state-machine.md#35-read-receipt-batch-aggregation-strategy)).
- Bot engine receives a copy of every message event via Redis Streams. Bots may respond asynchronously.

### 5.2 E2E Mode Message Flow

```
Sender Client                  Gateway/Server                   Recipient Client(s)
     │                              │                                  │
     │ 1. Encrypt locally:          │                                  │
     │    - Resolve PreKey bundle   │                                  │
     │      for each recipient      │                                  │
     │    - Advance Double Ratchet  │                                  │
     │    - Encrypt content →       │                                  │
     │      ciphertext blob         │                                  │
     │                              │                                  │
     │ 2. message:e2e:send ────────→│                                  │
     │    {channelId, clientMsgId,  │                                  │
     │     ciphertext,              │                                  │
     │     senderDeviceId}          │                                  │
     │                              │ 3. Auth + Rate Limit Check       │
     │                              │ 4. Idempotency Check (Redis)     │
     │                              │ 5. Store ciphertext as-is        │
     │                              │    INSERT INTO messages          │
     │                              │    (content = encrypted blob)    │
     │ 6. message:ack ─────────────│                                  │
     │    {messageId, status:      │                                  │
     │     "sent"}                  │                                  │
     │                              │ 7. message:e2e:new ─────────────→│
     │                              │    {ciphertext blob,             │
     │                              │     senderDeviceId}              │
     │                              │                                  │
     │                              │    ⚠ Server NEVER decrypts      │
     │                              │    ⚠ No bot dispatch possible    │
     │                              │    ⚠ No server-side search       │
     │                              │                                  │
     │                              │ 8. Client decrypts locally:      │
     │                              │    - Lookup session by           │
     │                              │      senderDeviceId              │
     │                              │    - Decrypt with Double Ratchet │
     │                              │    - Render plaintext            │
```

**Key characteristics:**

- All encryption/decryption happens on the client using the shared `packages/signal` library.
- The server is a **blind relay**: it stores and forwards opaque ciphertext blobs. The server cannot read message content, nor can it perform full-text search on E2E channels.
- Read-once/disappearing messages are enforced through metadata only: read acknowledgments, expiry timestamps, and tombstone state. Clients must delete local plaintext when the policy expires.
- Bots **cannot** participate in E2E channels — this is an architectural trade-off. The E2E protocol has no mechanism to include a third-party key in the ratchet without defeating the end-to-end guarantee.
- Key material (PreKey bundles, signed pre-keys) is stored server-side in a dedicated `signal_key_bundles` table, but private keys never leave the client.
- For details on key distribution, group messaging (Sender Key), and device multi-session management, see [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md).

### 5.3 Bot Command Flow

```
User Client                Gateway/Server                   Bot Engine                 Bot (3rd-party)
     │                         │                                │                            │
     │ 1. Type /poll          │                                │                            │
     │    "Best language?"    │                                │                            │
     │ 2. bot.command.invoke ─→│                                │                            │
     │    {botName: "poll",    │                                │                            │
     │     command: "create",  │                                │                            │
     │     args: [...]}         │                                │                            │
     │                         │ 3. Auth + command lookup       │                            │
     │                         │    (bot installed in channel)  │                            │
     │                         │ 4. Publish to Redis Streams    │                            │
     │                         │    XADD events:bot-commands    │                            │
     │ 5. command:ack ───────│                                │                            │
     │                         │                                │ 6. Consumer Group reads    │
     │                         │                                │    event                   │
     │                         │                                │ 7. Route to installed bot  │
     │                         │                                │    (botId from channel)    │
     │                         │                                │ 8. Forward via Bot WS ────→│
     │                         │                                │                            │
     │                         │                                │                            │ 9. Bot processes
     │                         │                                │                            │    command
     │                         │                                │                            │10. Bot responds
     │                         │                                │ ← Bot WS response ────────│
     │                         │                                │11. Validate response       │
     │                         │                                │12. Send to channel ───────→│
     │                         │                                │    io.to(channel).emit()   │
     │                         │                                │                            │
     │ ← Bot response ────────│                                │                            │
     │   (message:new)        │                                │                            │
```

**Key characteristics:**

- Slash commands are interaction events (`bot.command.invoke`), not persisted user messages by default. If an audit trail is required, the server creates a separate `system` message or audit log entry after accepting the command.
- Bot commands are delivered to the bot engine via Redis Streams, decoupling the request-response lifecycle from the main message pipeline.
- Each installed bot maintains a persistent WebSocket connection to the Bot Engine. Commands and responses flow through this dedicated channel.
- Bot responses are injected back into the channel as regular messages (with a `botId` attribution), visible to all channel members.
- For bot SDK design, event subscription patterns, and security constraints, see [Bot Engine Research](../research/bot-engine-microservices.md).

### 5.4 AI Streaming Message Flow

```
User Client                Gateway/Server               AI Agent Engine            LLM Provider
     │                         │                              │                          │
     │ 1. /ai summarize        │                              │                          │
     │    yesterday            │                              │                          │
     │ 2. bot.command.invoke ─→│                              │                          │
     │                         │ 3. Auth + route /ai command  │                          │
     │                         │ 4. Publish to AI Streams ───→│                          │
     │ 5. command:ack ───────│                              │                          │
     │                         │                              │ 6. Command Parser        │
     │                         │                              │    identifies "summarize" │
     │                         │                              │    agent, extracts intent │
     │                         │                              │ 7. Agent Router selects   │
     │                         │                              │    SummarizeAgent + model │
     │                         │                              │ 8. Memory Manager builds  │
     │                         │                              │    context (recent msgs,  │
      │                         │                              │    full-text search tool) │
     │                         │                              │                           │
     │                         │ ← 9. message.stream_start ──│                           │
     │                         │    {placeholderMessageId}    │                           │
     │ ← message.stream_start──│                              │                           │
     │    (placeholder in UI)  │                              │                           │
     │                         │                              │10. Prompt sent ──────────→│
     │                         │                              │                           │
     │                         │                              │ ← stream_chunk (token) ──│
     │                         │ ← 11. message.stream_chunk ─│                           │
     │                         │    {chunkIndex, content}     │    (every ~100ms)         │
     │ ← stream_chunk ────────│                              │                           │
     │    (progressive render) │                              │                           │
     │                         │                              │ ← repeat until done ─────│
     │                         │                              │                           │
     │12. User clicks [Cancel] │                              │                           │
     │13. stream_cancel ──────→│ ────────────────────────────→│                           │
     │                         │                              │14. Abort LLM request ────→│
     │                         │ ← 15. message.stream_end ───│                           │
     │                         │    {status: "cancelled"}     │                           │
     │ ← stream_end ──────────│                              │                           │
     │                         │                              │                           │
     │    OR (if completed):   │                              │                           │
     │                         │ ← 15. message.stream_end ───│                           │
     │                         │    {status: "completed",     │                           │
     │                         │     usage: {tokens...}}      │                           │
     │ ← stream_end ──────────│                              │                           │
     │    (final markdown      │                              │                           │
     │     with token stats)   │                              │                           │
```

**Key characteristics:**

- The `/ai` command prefix is detected server-side. The message is routed to the AI Agent Engine instead of the generic bot engine.
- A `stream_start` event pre-allocates a placeholder message in the channel, appearing in the correct chronological position.
- The Stream Manager's Chunk Batcher buffers tokens and emits `stream_chunk` events every ~100ms to the channel via WebSocket.
- Clients render progressive markdown with a cursor animation. The user can cancel generation at any time via the same WebSocket connection.
- Upon completion, `stream_end` delivers final token usage statistics (`promptTokens`, `completionTokens`, `totalTokens`).
- Tool calls (web fetch, code sandbox, SDK API) are interlaced within the stream as special chunk types.

---

## 6. Deployment Architecture

### 6.1 Phase 1: Monolith with Clear Boundaries

```
                              ┌──────────────────┐
                              │  Load Balancer    │
                              │  (Nginx / AWS ALB)│
                              │  sticky sessions  │
                              └────────┬─────────┘
                                       │
                         ┌─────────────┼─────────────┐
                         ↓             ↓             ↓
                   ┌──────────┐ ┌──────────┐ ┌──────────┐
                   │ App Node │ │ App Node │ │ App Node │
                   │ (Hono +  │ │ (Hono +  │ │ (Hono +  │
                   │ Socket.IO│ │ Socket.IO│ │ Socket.IO│
                   │ + Bot    │ │ + Bot    │ │ + Bot    │
                   │ Engine)  │ │ Engine)  │ │ Engine)  │
                   └────┬─────┘ └────┬─────┘ └────┬─────┘
                        │            │            │
                        └────────────┼────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │         Redis            │
                        │  ├── Socket.IO Adapter   │
                        │  ├── Session / Cache     │
                        │  ├── Rate Limiting        │
                        │  └── Redis Streams        │
                        │     (Bot Event Bus)       │
                        └──────────────────────────┘
                                     │
                        ┌────────────┴────────────┐
                        │      PostgreSQL          │
                        │      (Primary)           │
                        └──────────────────────────┘
```

- All services (HTTP, WebSocket, Bot Engine) run in a **single Node.js process** deployed across multiple instances for availability.
- **Redis** provides:
  - Socket.IO Adapter for cross-instance WebSocket message routing
  - Session store and multi-layer data caching
  - Sliding-window rate limiting (distributed)
  - Redis Streams as the event bus for bot engine message consumption
- **Sticky sessions** (cookie-based or IP hash) required at the load balancer for Socket.IO's Engine.IO handshake. After upgrade to pure WebSocket (`transports: ["websocket"]`), sticky sessions still recommended for connection affinity.
- PostgreSQL runs as a single primary with optional read replicas for scaling query load (read receipts, search queries).

### 6.2 Future Phase 2+: Service Split Boundaries

As the system scales, the monolith splits along domain boundaries already established in the Phase 1 code organization:

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Gateway     │  │  Message     │  │  Bot Engine  │  │  File        │
│  Service     │  │  Service     │  │  Service     │  │  Service     │
│  (Hono REST) │  │  (WS +       │  │  (NATS       │  │  (Upload +   │
│              │  │   Storage)   │  │   consumer)  │  │   CDN)       │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │                 │
       └─────────────────┼─────────────────┼─────────────────┘
                         │                 │
                    ┌────┴────┐       ┌────┴────┐
                    │  NATS   │       │  Redis  │
                    │JetStream│       │(Cache + │
                    │(Event   │       │ Session)│
                    │ Bus)    │       │         │
                    └─────────┘       └─────────┘
```

- **Gateway Service**: Handles REST API authentication, routing, rate limiting. Stateless; horizontally scalable behind a load balancer without sticky sessions.
- **Message Service**: Owns WebSocket connections, message persistence, read receipts. Stateful with Redis Adapter for inter-instance communication.
- **Bot Engine Service**: Independent consumer of NATS JetStream events. Manages bot WebSocket connections and SDK lifecycle.
- **File Service**: Handles upload presigned URLs, virus scanning, thumbnail generation, CDN invalidation.
- All services share **shared type definitions** (`packages/shared`) for API contract and event schema consistency.

For detailed microservices decoupling strategy, inter-service communication patterns, and database-per-service migration planning, see [Bot Engine Research §3](../research/bot-engine-microservices.md#3-microservices-decoupling-strategy).

---

## 7. Phase Roadmap

> **Full detailed roadmap**: [06 — Phase Roadmap & Milestone Plan](06_Phase_Roadmap.md)

### Summary

### Phase 1: MVP Foundation

**Goal**: Usable Slack-like IM with hybrid encryption.

| Feature Area | Deliverables |
|-------------|-------------|
| **Auth** | Email/password registration + login, JWT (access 15min + refresh 7d), session management |
| **Workspace** | Create/join workspace, workspace settings, member invite |
| **Channels** | Public/private channels, DM conversations, channel creation, archive, member management |
| **Messages** | Text messages, message state machine (Draft → Sending → Sent → Delivered → Read), cursor-based pagination, edit/delete, emoji reactions |
| **Rich Content** | Markdown rendering in messages |
| **DM E2E** | Signal Protocol encryption for 1:1 DMs, opaque server relay, client-side key management, read-once/disappearing message policy |
| **Bot (basic)** | Bot registration, `/slash` command parse + routing, bot WebSocket connection, Redis Streams event bus |
| **UI** | Single-window layout (sidebar + chat view), channel list, message list with virtual scrolling, dark/light theme, message input |
| **Desktop Shell** | Electron window, system tray, native notifications, auto-update |
| **TUI Client** | Terminal login, workspace/channel navigation, normal messaging, E2E/bot smoke commands |
| **Infrastructure** | Monolith deployment (Hono + Socket.IO + Bot Engine in one process), PostgreSQL, Redis, Pino logging |

### Phase 2: Rich Features & Production Hardening

**Goal**: Feature-complete IM platform ready for production launch.

| Feature Area | Deliverables |
|-------------|-------------|
| **Search** | Full-text message search (PostgreSQL `tsvector`), channel/user search, search filters |
| **Threads** | Threaded replies, thread sidebar panel, thread notifications |
| **Reactions** | Reaction picker, reaction counts, reaction notifications |
| **Online Presence** | Real-time online/offline status, typing indicators, last seen |
| **Channel E2E** | Group E2E via Sender Key, key distribution for multi-member channels |
| **Bot (advanced)** | Bot SDK interactive components (buttons, modals), webhook delivery, bot permission scopes |
| **Streaming Protocol** | Core WebSocket extension: stream_start → stream_chunk → stream_end events, ChunkBatcher, generation limits — usable by any bot |
| **Base Bots (Phase 2)** | @FileBot (file workflow UX over core Attachment Service), @TodoBot, @GitBot, @CIBot, @StandupBot, @CelebrateBot, @FeedbackBot, @AIBot (LLM/agent/summarize/translate/draft/search) |
| **Electron Package** | Cross-platform packaging (macOS, Windows, Linux), code signing, auto-update via GitHub Releases |
| **Offline Support** | Offline message queue, automated retry on reconnect, IndexedDB message cache, offline indicator |
| **Performance** | Web Vitals monitoring, React Profiler in CI, memory window control (200 messages in-memory), render optimization |
| **Infrastructure** | Multi-instance deployment, Redis Sentinel/Cluster, database read replicas |

### Phase 3: Advanced & Enterprise

**Goal**: Enterprise-grade platform with advanced capabilities.

| Feature Area | Deliverables |
|-------------|-------------|
| **Voice & Video** | 1:1 and group voice/video calls (WebRTC), screen sharing, call history |
| **SSO** | SAML/OIDC integration, Google/Microsoft/GitHub OAuth login, directory sync |
| **Advanced E2E** | Verified safety numbers, device management, sealed sender, transparency/audit UX, advanced retention policy controls |
| **Enterprise** | Admin dashboard, audit logs, data retention policies, compliance exports, custom data residency |
| **Bot Ecosystem** | Public bot marketplace, bot analytics, bot rate limiting and abuse prevention, Bot Marketplace launch |
| **AI Orchestration** | Multi-agent AI orchestration (supervisor-worker, debate patterns), voice/video integration with Meeting Notes Bot |
| **Microservices Split** | Gateway / Message / Bot Engine / File services separated, NATS JetStream event bus, database-per-service |
| **Observability** | Distributed tracing (OpenTelemetry), centralized metrics (Prometheus + Grafana), alerting |

---

## 8. Related Design Documents

| Document | Description |
|----------|-------------|
| [01 - Client Shell & UI Rendering](01_Client_Shell_and_UI_Rendering_Layer.md) | Electron + React + Zustand architecture |
| [02 - Long Connection & Core Gateway](02_Long_Connection_and_Core_Gateway_Layer.md) | WebSocket protocol, REST API, authentication |
| [03 - Business Logic & Persistence](03_Business_Logic_and_Persistence_Backend.md) | Data model, state machines, caching |
| [04 - Async Bot Engine & Event Dispatch](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) | Bot framework, event pipeline, tasks |
| [05 - AI Agent Orchestration & Streaming](05_AI_Agent_Orchestration_and_Streaming.md) | AI Assistant Bot, streaming protocol, LLM abstraction |
| [06 - Phase Roadmap & Milestone Plan](06_Phase_Roadmap.md) | Consolidated Phase 1/2/3 goals, week-by-week breakdown, bot/AI rollout |

---

## Appendix: Key Architecture Decisions Log

| Decision | Rationale | Date |
|----------|-----------|------|
| **Hono over Fastify/NestJS** | Cold start <50ms, cross-runtime, built-in middleware, simple testing. Fastify is the fallback if serverless is ruled out. | 2026-06-24 |
| **Socket.IO over raw WS/uWS** | Room management, reconnect, heartbeat, Redis Adapter for horizontal scaling — all built-in. Operational simplicity over raw throughput for Phase 1. | 2026-06-24 |
| **Redis Streams over Kafka/NATS (Phase 1)** | Zero additional infrastructure cost (Redis already deployed). Consumer Groups sufficient for early bot engine needs. Upgrade path to NATS JetStream defined for Phase 2. | 2026-06-24 |
| **Zustand over Redux/Jotai** | Lightweight, selector precision, Map-based normalized storage, middleware ecosystem. Suitable for IM's high-frequency state updates. | 2026-06-24 |
| **react-virtuoso over tanstack/react-virtual** | Built-in bidirectional infinite scroll, auto-follow-output, sticky headers — all essential for chat message lists. 17KB bundle cost acceptable. | 2026-06-24 |
| **UUID v7 over UUID v4** | Time-ordered IDs enable single-field cursor pagination (`WHERE id < cursor ORDER BY id DESC`), eliminating the need for `(created_at, id)` compound cursors. | 2026-06-24 |
| **JSONB for message content** | Polymorphic content (text, image, file, system) maps naturally to JSONB. PostgreSQL JSONB supports indexing (`@>` containment) for attachment-type queries. | 2026-06-24 |
| **Per-channel encryption mode** | A workspace can mix normal and E2E channels. This avoids an all-or-nothing trade-off and lets users choose the appropriate security model per conversation. | 2026-06-24 |
| **Monolith-first deployment** | All services co-located in Phase 1 with clear domain boundaries in code. Service split deferred until scale demands it, avoiding premature distribution complexity. | 2026-06-24 |
