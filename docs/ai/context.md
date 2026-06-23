# Nexus Chat — Session Context Document

> Last updated: 2026-06-24

## 1. Project Overview

**Nexus Chat** is a Slack-like instant messaging desktop application built on a hybrid architecture:

- **Normal Mode**: Full IM (instant messaging) + Bot framework
- **E2E Encrypted Mode**: IM only (no Bots, no server-side search)
- **Granular Encryption**: Encryption level is configured per-channel and per-DM, not globally

The application targets SaaS cloud deployment, with an Electron desktop client and a Node.js backend. The system is designed as a pnpm monorepo managed by Turborepo.

---

## 2. Key Decisions Made

### 2.1 Core Tech Stack

| Layer | Technology | Version (mid-2026) |
|-------|-----------|-------------------|
| Frontend | Electron + React + Vite + Zustand + Tailwind CSS | Electron ^42.5, React ^19.0, Vite ^7.0, Zustand ^5.0, Tailwind ^4.0 |
| Backend HTTP | Hono | ^4.12.x |
| Backend Alternative | Fastify | ^5.8.x (fallback option) |
| WebSocket | Socket.IO v4 + Redis Adapter | ^4.8.0 |
| Database | PostgreSQL + Drizzle ORM | PG 17.x, Drizzle ^0.40 |
| Cache / Pub/Sub | Redis | 7.4+ |
| Encryption | Signal Protocol (`@signalapp/libsignal-client`) | ^0.96.2 |
| Task Queue | BullMQ | ^5.x |
| Object Storage | S3-compatible (R2 / MinIO) | — |
| Desktop Packaging | electron-builder + electron-updater | ^26.0, ^6.3 |

### 2.2 Monorepo & Deployment

- **Monorepo**: pnpm workspaces + Turborepo
- **Deployment**: SaaS cloud, Kubernetes as target platform
- **API Gateway**: Caddy / Nginx reverse proxy (Phase 1) → Traefik (Phase 2)
- **Service Discovery**: Kubernetes DNS (production), Docker Compose service names (dev)

### 2.3 Development Standards

- TypeScript strict mode throughout
- Zod for runtime validation at all I/O boundaries
- ESLint + Prettier for code quality
- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
- Branch naming: `feat/xxx`, `fix/xxx`, `docs/xxx`

---

## 3. Architecture Summary

### 3.1 Five-Layer Architecture

```
┌──────────────────────────────────────────────┐
│ Layer 1: Client Shell                         │
│ Electron main process + React renderer        │
│ Preload bridge (contextBridge) for security   │
├──────────────────────────────────────────────┤
│ Layer 2: Long Connection Gateway              │
│ WebSocket Gateway (Socket.IO + Redis Adapter) │
│ Sticky-session load balancing (Nginx/ALB)     │
│ Connection management + heartbeat + reconnect │
├──────────────────────────────────────────────┤
│ Layer 3: Business Logic                       │
│ REST API (Hono) + Channel/Member management   │
│ Message CRUD + state machine                  │
│ Cursor-based pagination + UUID v7 IDs         │
├──────────────────────────────────────────────┤
│ Layer 4: Async Bot Engine                     │
│ Event-driven architecture (Redis Streams)     │
│ Bot SDK (WebSocket + Webhook hybrid)          │
│ BullMQ task queue for dispatch                │
├──────────────────────────────────────────────┤
│ Layer 5: E2EE (Signal Protocol)               │
│ X3DH handshake + Double Ratchet encryption    │
│ Sender Key distribution for groups            │
│ Client-side key storage (OS keychain)         │
└──────────────────────────────────────────────┘
```

### 3.2 Hybrid Encryption Model

- **Normal Channels**: Server-side plaintext storage — enables server-side search, Bot access, message history for new members
- **E2EE Channels**: Signal Protocol end-to-end encryption — server stores only ciphertext. New members see only messages after join (Pending Join). Server-side search disabled; client-side local search only
- **Per-Channel Granularity**: Each channel/DM independently selects encryption level

### 3.3 Message State Machine

```
DRAFT → SENDING → SENT → DELIVERED → READ
                  ↓
               FAILED (retry ≤3 times, exponential backoff)
```

Key design: `clientMsgId` for idempotent deduplication. UUID v7 for time-ordered message IDs enabling single-field cursor pagination. Read receipts batch-aggregated in Redis (3-second flush window).

### 3.4 Service Split Roadmap

```
Phase 1 (Monolith):
  Single Node.js backend + shared PostgreSQL (schema isolation)
  → Redis Streams event bus + BullMQ task queue

Phase 2 (Hybrid, 3-9 months):
  Split priority: relay-service → bot-service → message-service → notification-service
  → NATS JetStream replaces Redis Streams
  → gRPC for internal sync calls, NATS for async events
  → Traefik API gateway on K8s

Phase 3 (Full Microservices, 9-18 months):
  Database-per-service + CQRS + CDC to Elasticsearch
  → Multi-region (NATS Leaf Nodes) + Signal E2EE GA
```

### 3.5 Database Design

**Core Tables**: `users`, `workspaces`, `channels`, `channel_members`, `messages`, `files`, `read_receipts`

- JSONB for polymorphic data (message `content`, channel `metadata`, reaction counts)
- Cursor-based pagination on `(channel_id, created_at DESC, id DESC)` compound index
- `client_msg_id` UNIQUE constraint for idempotency
- Schema-based logical isolation (`chat.`, `bot.`, `auth.`, `signal.`) preparing for future microservice split

### 3.6 Redis Cache Layers

```
Layer 1: Session & Auth (token → user/permissions)
Layer 2: Online Presence (status + active connections)
Layer 3: Channel State (members, info — lazy load + TTL)
Layer 4: Message Hot Data (Sorted Set, recent 200 per channel)
Layer 5: Read/Unread State (per-user per-channel cursor)
Layer 6: Rate Limiting (Sliding Window, Redis-backed)
```

---

## 4. Research Documents Summary

### 4.1 `backend-im-state-machine.md`
Comprehensive backend architecture research covering HTTP framework selection (Hono recommended over Fastify/NestJS), WebSocket real-time communication (Socket.IO v4 + Redis Adapter), message state machine design (8 states: DRAFT through DELETED), channel/DM state management with RBAC permissions (owner/admin/member), PostgreSQL database schema with Drizzle ORM, 6-layer Redis caching strategy, and security/rate limiting. Recommends Hono for its small bundle size, cross-runtime support, built-in middleware, and fast cold start; Socket.IO for room management and horizontal scaling; and cursor-based pagination with UUID v7.

### 4.2 `bot-engine-microservices.md`
Event-driven Bot engine and microservices decoupling strategy. Recommends Redis Streams for Phase 1 event bus (zero additional cost on existing Redis) with migration to NATS JetStream in Phase 2 for low-latency persistent events with subject hierarchy filtering. Bot connection uses hybrid WebSocket (primary, via SDK) + HTTP Webhook (fallback). Custom `@nexus-chat/bot-sdk` package with declarative event listeners and type-safe operation APIs. BullMQ for task queuing with Inngest integration point for complex long-running workflows. Message processing pipeline: validate → E2EE branch (conditional) → persist → Bot dispatch (async) → real-time broadcast (async). Bot security uses HMAC self-verifying tokens (`nxbot-v1-xxx`), OAuth2 scopes, two-tier rate limiting, and data isolation via `bot_channel_memberships`.

### 4.3 `frontend-architecture.md`
Desktop client architecture with `vite-plugin-electron` v1.0.4 for seamless Vite integration. Process communication via `contextBridge` + IPC with `contextIsolation: true, sandbox: true`. `react-virtuoso` selected as the sole recommendation for IM message list virtual scrolling (dynamic height, bidirectional infinite scroll, auto-follow). Zustand multi-store pattern with `Map`-based normalized message storage for O(1) lookup and deduplication. Tailwind CSS v4 with `@theme` directive for design tokens, `class-variance-authority` for component variants, shadcn/ui on-demand integration. Offline-first strategy using Electron main process caching (not Service Worker), IndexedDB for message persistence, and an offline queue with automatic resend on reconnection. Web Vitals monitoring and React Profiler for performance regression detection.

### 4.4 `security-defense-e2ee-roadmap.md`
Comprehensive security baseline and E2EE roadmap. Phase 1 defense-in-depth includes: Helmet.js v8.1 with strict security headers, strict CORS whitelist, CSP in both HTTP headers and Electron main process, Argon2id password hashing, JWT dual-token strategy (RS256, 15-min access + 7-day refresh with rotation and replay detection), multi-tier rate limiting, Zod input validation, DOMPurify XSS prevention, AES-256-GCM encrypted storage for sensitive fields, append-only audit logs, and key rotation strategy with KID mechanism. Signal Protocol integration deep dive covers X3DH handshake, Double Ratchet, Sender Key vs pairwise encryption for groups, `@signalapp/libsignal-client` usage (AGPL-3.0 license note), PreKey lifecycle management, and multi-device architecture. E2EE phased roadmap: Phase 1 (DM E2EE, 1.5-2 months), Phase 2 (Group E2EE with Sender Key + Pending Join, 2-3 months), Phase 3 (Safety Numbers, Disappearing Messages, Sealed Sender, Transparency Log). Threat model covers server compromise, MITM, client compromise, and DDoS. GDPR compliance checklist and data export/deletion APIs defined.

### 4.5 `ui-components-plugin-protocol.md`
Componentized UI architecture with Atomic Design methodology across three packages: `@nexus-chat/ui` (primitives + composites + design tokens), `@nexus-chat/chat` (business modules), and `@nexus-chat/sdk` (plugin SDK). Storybook 10 + `@storybook/react-vite` for component documentation. Shiki for code syntax highlighting (VS Code-level accuracy, zero client JS). `emoji-mart` v5 for emoji picker with lazy loading. Markdown rendering via `markdown-it` with custom plugins for @mentions, #channels, and :emoji: shortcodes. Plugin ecosystem protocol: iframe sandbox as primary isolation mechanism (referencing Matrix Widget API), Web Worker for background logic, Mattermost Registry pattern for 50+ UI extension points, Chrome Extension Manifest V3-style permission declaration, OAuth-like user authorization flow, inter-plugin EventBus relay (no direct communication), `manifest.json` with SemVer compatibility, and plugin signing + SRI for supply chain security. Bot is positioned as a special case of plugin (UI-less, runs in Worker context).

---

## 5. MVP Scope

### Phase 1 (MVP, 1-3 months)
- Basic text messages with full state machine (send, deliver, read receipts)
- Public/private channels + direct messages (1:1)
- Channel member management with owner/admin/member RBAC
- Bot framework: event-driven engine, WebSocket SDK, slash commands, basic message reply
- JWT authentication with refresh token rotation
- 1:1 DM E2EE via Signal Protocol (X3DH + Double Ratchet)
- Desktop client (Electron) with virtual scrolling, offline queue, system tray
- Security baseline (Helmet, CSP, CORS, rate limiting, audit logs)
- Shared PostgreSQL with schema isolation
- Caddy/Nginx reverse proxy

### Later Phases
- **Phase 2 (Growth, 3-9 months)**: File/image transfer, Group E2EE, microservices split, Elasticsearch full-text search, voice/video calling infrastructure, Inngest for complex Bot workflows, OpenTelemetry tracing
- **Phase 3 (Scale, 9-18 months)**: Disappearing messages, Sealed Sender, Safety Number verification, Bot marketplace, multi-region deployment

---

## 6. Project Conventions

From `AGENTS.md`:

- **Language**: All documentation, code comments, commit messages, and README files MUST be written in English
- **Code Style**: TypeScript strict mode, ESLint + Prettier, no `any` without explicit justification, Zod for runtime validation at boundaries
- **Git**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), branch naming `feat/xxx` / `fix/xxx` / `docs/xxx`, no secrets committed

---

## 7. Open Questions / Next Steps

1. **Framework finalization**: Hono vs Fastify — decision pending on whether serverless/edge deployment is a near-term requirement. Hono is the research recommendation; Fastify is the fallback if JSON throughput becomes a bottleneck and edge deployment is ruled out.

2. **AGPL-3.0 license impact**: `@signalapp/libsignal-client` is AGPL-3.0 licensed. If nexus-chat is closed-source, alternatives such as `2key-ratchet` (MIT) or Matrix Olm (Apache 2.0) must be evaluated.

3. **Electron WebSocket architecture**: Whether the WebSocket connection lives in the main process or renderer process — research suggests main process for persistence and reliability, but final architecture needs design confirmation.

4. **Multi-device E2EE**: Phase 1 targets single-device E2EE only. Multi-device support (per-device independent keys) is deferred to Phase 2.5.

5. **Group E2EE Sender Key rotation**: Exact UX for key rotation during member join/leave events (whether to block the UI during rotation, how to handle offline members) needs detailed design.

6. **Plugin marketplace**: Governance model, review process, and monetization strategy for third-party plugins deferred to Phase 3.

7. **Region-specific compliance**: E2EE legal landscape varies by jurisdiction (EU supports, UK/India challenging, China prohibits). Need to determine whether region-specific builds are required.

8. **Infrastructure provisioning**: Kubernetes cluster setup, Redis Sentinel/Cluster topology, PostgreSQL high-availability configuration, and CDN selection for file storage all require operational planning.

9. **CI/CD pipeline**: Complete pipeline design including dependency security scanning (Snyk, Socket.dev), E2E testing with Playwright, Electron packaging/signing/notarization, and auto-update publishing flow.

10. **Type sharing strategy**: The `@nexus-chat/shared` package needs to define authoritative type definitions for message events, Socket.IO event contracts, Bot SDK types, and E2EE protocol messages — enabling end-to-end type safety across the monorepo.
