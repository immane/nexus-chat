# Nexus Chat — Session Context Document

> Last updated: 2026-07-17 (Phase 2 — PostgreSQL persistence Task #28 complete, CI unified with 60-check PostgreSQL multi-user smoke test, web demo removed, auto-refresh tokens)
> Current status: Phase 1 complete (27/27), Phase 2 in progress. PostgreSQL persistence Task #28 is complete; production requires `PERSISTENCE=postgres`, while in-memory remains the development/test default. Real ECDH + AES-256-GCM encryption is active for 1:1 E2EE DMs.

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
| Encryption | ECDH + AES-256-GCM (@noble/*, Phase 1-2) / Signal Protocol (@signalapp/libsignal, Phase 3 branch) | ^0.96.2 |
| Task Queue | BullMQ | ^5.x |
| Object Storage | Core Attachment Service + S3-compatible storage (R2 / MinIO) | — |
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

### 3.1 Core Architecture Layers

```
┌──────────────────────────────────────────────┐
│ Layer 1: Client Shell                         │
│ Electron main process + React renderer        │
│ Preload bridge (contextBridge) for security   │
├──────────────────────────────────────────────┤
│ Layer 2: Long Connection Gateway              │
│ WebSocket Gateway (Socket.IO, single process) │
│ Connection management + heartbeat + reconnect │
├──────────────────────────────────────────────┤
│ Layer 3: Business Logic + Persistence         │
│ REST API (Hono) + Channel/Member management   │
│ Message CRUD + state machine                  │
│ Attachment Service (file lifecycle authority) │
│ PostgreSQL (production) / In-memory (dev)     │
│ Cursor-based pagination + UUID v7 IDs         │
├──────────────────────────────────────────────┤
│ Layer 4: Async Bot Engine                     │
│ Event polling via WebSocket /bots namespace   │
│ Bot SDK (WebSocket native)                    │
│ Process-local pending event queue             │
├──────────────────────────────────────────────┤
│ Layer 5: E2EE (ECDH + AES-256-GCM)            │
│ ECDH key exchange + AES-256-GCM encryption    │
│ Client-side key storage (memory)              │
│ P2P WebRTC DataChannel (opportunistic)        │
└──────────────────────────────────────────────┘
```

### 3.2 Hybrid Encryption Model

- **Normal Channels**: Server-side plaintext storage — enables server-side search, Bot access, message history for new members
- **E2EE Channels**: Client-side ECDH + AES-256-GCM end-to-end encryption — server stores only ciphertext. New members see only messages after join (Pending Join). Server-side search disabled; client-side local search only. Signal Protocol (X3DH + Double Ratchet) planned for Phase 3 on a separate AGPL-3.0 distribution branch.
- **Per-Channel Granularity**: Each channel/DM independently selects encryption level
- **E2E Attachments**: Client encrypts files before upload. Core Attachment Service stores opaque encrypted blobs and authorization metadata. Bots, including `@FileBot`, do not participate in E2E attachment upload/download.

### 3.2.1 Bot Responsibility Boundary

Bots are used for product workflows and integrations, but core services own lifecycle-critical platform primitives.

| Responsibility | Owner |
|----------------|-------|
| Message persistence, delivery, edits, deletes, read state | Core IM |
| Workspace/channel membership and authorization | Core IM |
| Search indexes for normal-mode messages | Core IM |
| E2EE key distribution and routing | Core IM |
| Attachment upload sessions, object keys, scan status, signed URLs, retention | Core Attachment Service |
| Bot installation, token validation, scopes, event subscriptions | Core Bot Engine |
| Polls, reminders, kudos, standups, CI/CD, GitHub/GitLab, AI workflows | Bots |
| File-management UX (`/file upload`, `/file list`, cleanup reminders) | `@FileBot` over Core Attachment Service |

### 3.3 Message State Machine

```
DRAFT → SENDING → SENT → DELIVERED → READ
                  ↓
               FAILED (retry ≤3 times, exponential backoff)
```

Key design: `clientMsgId` for idempotent deduplication. UUID v7 for time-ordered message IDs enabling single-field cursor pagination. Read receipts batch-aggregated in Redis (3-second flush window).

### 3.4 Service Split Roadmap

```
Phase 1 (Monolith): ✓ Complete
  Single Node.js backend + shared PostgreSQL (schema isolation)
  In-memory development default; PERSISTENCE=postgres for production

Phase 2 (Growth, in progress):
  Production PostgreSQL persistence ✓ (Task #28)
  Core Attachment Service productionization (S3/R2)
  Full-text search (PostgreSQL tsvector + GIN)
  Group E2EE (Sender Key)
  Threads, production packaging, AI/streaming

Phase 3 (Scale, 9-18 months):
  Microservice extraction (relay → bot → message → notification)
  Database-per-service + CQRS
  Signal Protocol GA, Bot marketplace, multi-region
```

### 3.5 Database Design

**Core Tables**: `users`, `workspaces`, `workspace_members`, `channels`, `channel_members`, `messages`, `message_reactions`, `files`, `upload_sessions`, `message_attachments`, `bot_integrations`, `bot_channel_memberships`, `bot_event_subscriptions`, `signal_prekey_bundles`, `signal_one_time_prekeys`, `signal_sessions`, `audit_logs`

- JSONB for polymorphic data (message `content`, channel `metadata`, reaction counts)
- Cursor-based pagination on `(channel_id, created_at DESC, id DESC)` compound index
- `(sender_id, client_msg_id)` UNIQUE constraint for idempotency
- Schema-based logical isolation (`chat.`, `bot.`, `auth.`, `signal.`) preparing for future microservice split

### 3.6 Operational State Layers

Current implementation uses process-local Maps for transient state. Redis is available for session storage (`SESSION_STORE=redis`) via `RedisRefreshSessionStore`.

Planned Redis migration (Phase 2 operational state):
```
Layer 1: Session & Auth (token → user/permissions) — RedisRefreshSessionStore ✓
Layer 2: Online Presence (status + active connections) — process-local Map
Layer 3: Channel State (members, info — lazy load + TTL) — process-local
Layer 4: Message Hot Data (Sorted Set, recent 200 per channel) — planned
Layer 5: Read/Unread State (per-user per-channel cursor) — PostgreSQL durable
Layer 6: Rate Limiting (Sliding Window) — process-local Map
Socket.IO multi-instance adapter — planned
```

---

## 4. Research Documents Summary

### 4.1 `backend-im-state-machine.md`
Comprehensive backend architecture research covering HTTP framework selection (Hono recommended over Fastify/NestJS), WebSocket real-time communication (Socket.IO v4 + Redis Adapter), message state machine design (8 states: DRAFT through DELETED), channel/DM state management with RBAC permissions (owner/admin/member), PostgreSQL database schema with Drizzle ORM, 6-layer Redis caching strategy, and security/rate limiting. Recommends Hono for its small bundle size, cross-runtime support, built-in middleware, and fast cold start; Socket.IO for room management and horizontal scaling; and cursor-based pagination with UUID v7.

### 4.2 `bot-engine-microservices.md`
Event-driven Bot engine and microservices decoupling strategy. Recommends Redis Streams for Phase 1 event bus (zero additional cost on existing Redis) with migration to NATS JetStream in Phase 2 for low-latency persistent events with subject hierarchy filtering. Bot connection uses hybrid WebSocket (primary, via SDK) + HTTP Webhook (fallback). Custom `@nexus-chat/bot-sdk` package with declarative event listeners and type-safe operation APIs. BullMQ provides per-bot queue isolation. The updated token model uses opaque random `nxbot_v1_...` tokens stored as database hashes for revocation and scope lookup. Bots are excluded from E2E channels and cannot own lifecycle-critical core data.

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
- 1:1 DM E2EE via ECDH + AES-256-GCM, including read-once/disappearing message policy (Phase 3: Signal Protocol on separate AGPL-3.0 branch)
- Desktop client (Electron) with virtual scrolling, offline queue, system tray
- TUI command-line client for auth, workspace/channel navigation, messaging, and E2E/bot smoke tests
- Security baseline (Helmet, CSP, CORS, rate limiting, audit logs)
- Shared PostgreSQL with schema isolation
- Caddy/Nginx reverse proxy

### Phase 1 Implementation Tasks

Detailed, decoupled Phase 1 tasks are stored in `docs/tasks/`:

| # | Task | Status |
|---|------|--------|
| 01 | Project Scaffold & Developer Workflow | Done |
| 02 | Shared Contracts, Event Schemas & Runtime Validation | Done |
| 03 | Database Schema, Migrations & Persistence Boundary | Done |
| 04 | Authentication, Sessions & Security Baseline | Done |
| 05 | Core Gateway: REST, WebSocket, Rate Limits & Protocol | Done |
| 06 | Workspace, Channel, DM & Membership Services | Done |
| 07 | Message Service, State Machine & Core IM Actions | Done |
| 08 | Attachment Service Foundation & E2E-Safe File Boundary | Done |
| 09 | Signal Protocol 1:1 DM E2EE (placeholder, Phase 3 full impl) | Done |
| 10 | Bot Engine Core, Event Dispatch & Command Invocation | Done |
| 11 | Node.js Bot SDK Reference Implementation | Done |
| 12 | Minimal First-Party Base Bots | Done |
| 13 | React Web Client Shell & Core Chat UI | Done |
| 14 | Electron Shell, IPC Boundary & Desktop Integration | Done |
| 15 | Observability, Audit Logs & Security Hardening | Done |
| 16 | Local Development, CI, Preview Deploy & Closed Beta Release | Done |
| 17 | TUI Command-Line Client | Done |
| 18 | P2P DM Direct Connection | Done |
| 19 | Web Message Actions & Context Menu | Done |
| 20 | Web Message Display & Formatting | Done |
| 21 | Web Rich Media & Emoji Picker | Done |
| 22 | Web Presence, Channel Info & Notifications | Done |
| 23 | Server Message Reply & Pin Backend | Done |
| 24 | Server Channel Mute & Description Backend | Done |
| 25 | TUI Chat Interface Redesign | Done |
| 26 | Web Mobile Adaptation | Done |
| 27 | E2EE Real Encryption Implementation | Done |
| 28 | Phase 2 PostgreSQL Persistence Integration | Done |

### Later Phases
- **Phase 2 (Growth, 3-9 months)**: Core Attachment Service productionization, Group E2EE, full-text search, threads, production packaging, streaming protocol, `@AIBot` with basic full-text search tool, advanced Bot SDK workflows, OpenTelemetry preparation
- **Phase 3 (Scale, 9-18 months)**: pgvector RAG, multi-agent AI, Sealed Sender, Safety Number verification, advanced E2E retention controls, Bot marketplace, multi-region deployment

---

## 6. Project Conventions

From `AGENTS.md`:

- **Language**: All documentation, code comments, commit messages, and README files MUST be written in English
- **Code Style**: TypeScript strict mode, ESLint + Prettier, no `any` without explicit justification, Zod for runtime validation at boundaries
- **Git**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), branch naming `feat/xxx` / `fix/xxx` / `docs/xxx`, no secrets committed

---

## 6.5 Current Implementation Stats (as of 2026-07-17)

- **Monorepo layout**: 4 apps + 7 packages (4 apps: server, web, desktop, tui; 7 packages: shared, signal, bot-sdk, ui, help-bot, notification-bot, welcome-bot) across pnpm workspaces with Turborepo
- **CI validation**: Unified `ci.yml` (validate + postgres-smoke + security). `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm coverage`, `pnpm build` all passing. PostgreSQL multi-user smoke test: 60/60 assertions across 12 acts (onboarding, channels, conversation, reactions, edits, pins, read receipts, file upload/download, DM, forward/save, bot /help, concurrent Signal prekeys, server restart persistence).
- **Coverage**: 98.07% statements/lines, 98.85% functions, 90.99% branches across core domain + shared packages
- **Tests**: 136 tests across 21 test files covering server domain services, persistence adapters (memory + Drizzle), persistence-service RBAC, HTTP routes, WS gateway, observability/audit, shared contracts, bot SDK, base bots, signal facade, web shell/store, Electron security config, desktop config, P2P transport, and TUI CLI
- **Phase 1 tasks**: 27/27 done — Phase 1 complete
- **Phase 2 tasks**: Task #28 (PostgreSQL persistence) complete — schema parity, async adapters, `/readyz`, and 60-check smoke test
- **Shared contracts**: 40+ canonical Zod schemas (API envelope, auth, workspace/channel, message, attachment, bot, signal/E2E, WS events) with Zod-based success envelope helper
- **DB schema**: 17 core tables with generated Drizzle migration. PostgreSQL runtime integration active via `PERSISTENCE=postgres` with async adapters (auth, workspace, messages, attachments, bots, signal). `FOR UPDATE SKIP LOCKED` for concurrent prekey allocation. In-memory adapter co-exists for development and tests.
- **Session store**: Dual backend: `InMemoryRefreshSessionStore` (default dev) and `RedisRefreshSessionStore` (activated via `SESSION_STORE=redis`), both with full test coverage
- **Bot infra**: Dedicated `/bots` WS namespace with token auth, per-bot event polling, subscription management; `NexusBotClient` SDK with reconnect backoff, middleware pipeline, channel info API, and rate-limit surface
- **Base bots**: WelcomeBot (member_added), HelpBot (/help), NotificationBot (/announce)
- **Signal/E2E**: Real ECDH + AES-256-GCM encryption via IE2eeProvider interface with 3 implementations (placeholder/noble/webcrypto); @noble/* is default (HTTP-compatible, MIT); WebCrypto (HTTPS only); Placeholder (Phase 3 Signal Protocol stub, @deprecated). E2EE file attachments enabled. E2EE attachment encryption/decryption helpers. PreKey upload/consume with transactional one-time prekey consumption; E2E read-once/TTL tombstones; session storage; P2P WebRTC DataChannel for 1:1 E2E DMs with relay fallback.
- **Web shell**: React/Vite renderer with real-server-only login (demo mode removed), workspace/channel sidebar with 3-tab bottom bar (Chat/Member/Settings), virtualized message list, slash command auto-detect, E2E policy/tombstone UI, typing indicators, read receipts, unread badges, DM creation from member list, auth session persistence with automatic access-token refresh, add channel/DM popup, right sidebar channel members, settings panel (Theme toggle, Compact mode, Sound, Notifications, Log Out), right-click context menu on messages (Reply/Copy/Forward/Edit/Delete/React), emoji reaction picker with 20 emojis, reply quote bar with reference display, forward modal with channel/DM picker, inline message editing, P2P/Signal transport mode selector for 1:1 DMs with peer online status, auto-refresh on channel/DM creation by other clients, online presence indicators (green/gray dots), toast notifications for new messages, browser notifications for background tabs, Markdown rendering (bold/italic/code/quote/lists/tables), relative timestamps, date separators, multiline textarea input (Enter send, Shift+Enter newline), emoji picker popover, image/file upload with inline rendering, clipboard image paste, Discord-style input bar. `ChatRoute.tsx` is now split into focused UI components plus hooks for channel members, attachments, message actions, bootstrap loading, read receipts, typing state, and auth token refresh; Signal/P2P send orchestration and WebSocket connection ownership remain in the route.
- **Server**: REST API with 60+ endpoints, WebSocket gateway with room-based broadcasting, channel description & mute support, message pinning, reply-to with validation, presence tracking with connection count, WS broadcast for reactions/edits/deletes/channel-created, in-memory dev file upload/download endpoints

---

## 7. Recent Fixes (2026-07-05 Post-Phase-1 Review Session)

### 7.1 Bot `/help` Broadcast Fix

The WebSocket gateway at `apps/server/src/ws/gateway.ts:65-68` was reading `messageId` from the top-level result object, but `botService.invokeCommand` returns `{ type: "bot.response", payload: { messageId, ... } }`. The gateway now reads `result.payload.messageId` instead. This was the primary reason `/help` appeared to produce no response — the bot response message was created in the in-memory store but never broadcast to the channel.

### 7.2 Help Bot Name Matching

`botService.invokeCommand` at `apps/server/src/domain/bots/service.ts:67` previously required the installed bot's `manifest.name` to equal `"help"` exactly. Changed to match any bot whose `manifest.commands` includes a `/help` entry, so `HelpBot`, `Help`, and future variants all trigger the inline response.

### 7.3 Double Event Dispatch

`invokeCommand` called `this.publishEvent(...)` (which internally calls `dispatchToBots`) and then redundantly called `this.dispatchToBots(event)` again. Removed the duplicate so each bot command event is enqueued exactly once.

### 7.4 TUI Bot Smoke Install URL

`apps/tui/src/commands/smoke.ts:169-172` passed `workspaceId` via a custom `x-query-workspace-id` header, but the server's `POST /api/v1/bots/install` reads `workspaceId` from the URL query string. Fixed to use `?workspaceId=...` in the request URL.

### 7.5 Web Demo `/help` Fallback (Removed)

The web client demo mode and its fake token (`demo-access-token`) have been removed. The login page now directly shows the real server authentication form only. The local-only `/help` synthesis fallback in `ChatRoute.tsx` was removed along with the demo mode, as was `demo-data.ts` and all `demo-access-token` guard clauses in hooks.

### 7.6 Coverage Enhancement

Coverage improved from ~97.6%/85.6% to 99.83%/92.02% by adding tests for:
- `InMemoryRefreshSessionStore` and `RedisRefreshSessionStore` lifecycle and edge cases
- Auth conflict, missing user, missing current user branches
- `listMembers`, `listChannelMembers`, `canManageChannel` workspace service boundaries
- Self-ack read receipt, missing read receipt flush, private channel FORBIDDEN paths
- Blocked attachment file validation, empty message attachment association
- Bot SDK reconnect lifecycle (connect/disconnect handlers with fake timers)
- Bot SDK generic `on()` event alias, 429 retry header fallback
- Bot SDK `getChannelInfo` missing match, shared `apiSuccessSchema` builder
- WelcomeBot empty payload/displayName, NotificationBot non-announce/no-channel branches

### 7.7 `.gitignore` Updates

Added rules for: `.env.tui*` (with `!.env.example` exception), `.playwright-mcp/`, `playwright-report/`, `test-results/`, common image/video globs (`*.png`, `*.jpg`, `*.jpeg`, `*.webp`, `*.gif`, `*.mp4`, `*.webm`), and Electron packaging outputs (`release/`, `*.dmg`, `*.exe`, `*.AppImage`).

### 7.8 Documentation

Created `README.md` (English, full GitHub-ready), `README.zh-CN.md` (Chinese translation), `QUICKSTART.md` (English step-by-step setup guide), and `QUICKSTART.zh-CN.md` (Chinese translation). All mention Phase 1 limitations explicitly.

### 7.9 Commit Split

Phase 1 codebase committed in 6 functional groups on branch `dev`:

```
4b7d9e2 docs: document phase 1 quickstart and status
1be00cf feat(clients): add web desktop and tui clients
ce1f74b feat(bots): add bot sdk and first-party bots
c9158fe feat(server): implement phase 1 backend
1852dee feat: add shared contracts and signal facade
9f9afc0 chore: scaffold monorepo tooling
```

---

## 8. Phase 1 Web Polish Tasks (Added 2026-07-07)

Based on a Telegram competitive analysis (`docs/research/telegram-interface-analysis.md`), a gap audit revealed that the Web client is missing ~17 Phase 1 UX features despite backend support for most. The following 6 new tasks were created to close this gap:

### Web Tasks (4 tasks, ~80% of remaining gap)

| # | Task | Backend Status | Key Deliverables |
|---|------|---------------|------------------|
| 19 | Message Actions & Context Menu | All CRUD actions + WS events ready | Right-click menu: Reply/Copy/Forward/Edit/Delete/React; quick-reaction bar; reaction badges; reply bar |
| 20 | Message Display & Formatting | Plain text only currently | Markdown rendering (bold/italic/code/quote/lists); markdown input with toolbar; link previews; relative timestamps |
| 21 | Rich Media & Emoji Picker | Attachment service fully ready | Emoji picker popover; file upload button with progress; clipboard paste of images; inline attachment rendering |
| 22 | Presence, Channel Info & Notifications | Presence WS events ready; store exists | Online status dots; channel info panel; toast + browser notifications; loading skeletons; empty states |

### Server Tasks (2 tasks, ~20% of remaining gap)

| # | Task | Key Deliverables |
|---|------|-----------------|
| 23 | Message Reply & Pin Backend | `replyToMessageId` in send schema; pin store + REST API + WS events |
| 24 | Channel Mute & Description Backend | `description` field on channel; mute store + REST endpoints |

### Gap Distribution
- **Web**: ~17 items missing from UI (80%) — backend already supports 13/17
- **Server**: ~4 items missing (20%) — reply, pin, mute, description

### 8.1 Web ChatRoute Refactor (2026-07-08)

The Web chat route was refactored in small, verified steps to reduce `ChatRoute.tsx` size while preserving runtime behavior:

- UI JSX moved into focused components: `ChatHeader`, `ChatComposer`, `RightMemberPanel`, `ForwardModal`, and `DeleteConfirmModal`.
- Store-heavy list rendering optimized so `MessageList` no longer subscribes to the full reactions map; each `MessageRow` subscribes only to the current message's reactions and reply target.
- Business logic moved into hooks:
- `useChannelMembers`: workspace members, channel members, add/remove member actions, and sender display names.
- `useAttachments`: file input ref, upload state, pending attachments, file upload, and pasted image handling.
- `useMessageActions`: copy, edit, delete confirmation, reactions, forwarding state, and forwarding submit.
- `useChatBootstrap`: current-user synchronization, notification permission request, persisted-token validation, workspace/channel/message/reaction bootstrap, and temporary bot manifest seeding.
- `useTyping`: typing user state, typing start/stop emission, and composer draft change handling.
- `useReadReceipts`: visible-message ack batching and read receipt state.
- `ChatRoute.tsx` intentionally still owns Signal identity/session refs, encrypted message decryption, WebSocket connection setup, P2P transport lifecycle, and final message-send orchestration. Those areas are tightly coupled and were left in place to avoid risky behavior changes.
- Verification after the final split passed: `pnpm --filter @nexus-chat/web lint`, `pnpm --filter @nexus-chat/web typecheck`, `pnpm --filter @nexus-chat/web test`, `pnpm build`, and `pnpm test`.

### 8.2 Electron Desktop Launch & README Screenshots (2026-07-08)

- Fixed Vite `base: "./"` in `apps/web/vite.config.ts` so built assets use relative paths. Previously Electron rendered a blank page because `file://` protocol cannot resolve absolute `/assets/...` paths.
- Added login and chat sample screenshots side-by-side to `README.md` and `README.zh-CN.md`.
- Fixed `.gitignore` exception pattern from `!docs/images/` to `!docs/images/*.jpg` so the global `*.jpg` ignore rule is properly re-included.
- Electron desktop verified running with 4 processes (Main, GPU, Network, Renderer).

### 8.3 TUI Chat Redesign Implementation (2026-07-08)

The TUI chat was redesigned and implemented with a two-pane layout featuring a dark semi-transparent background:

- **16 files changed** (+1204/-189): 8 components, 4 hooks, format utilities, WS event expansion, `app.tsx` rewrite.
- **Components**: `TopBar`, `BottomBar`, `Sidebar` (Chat/Members/Settings tabs), `ChatHeader`, `MessageArea` (with date separators, relative timestamps, message focus), `Composer` (with edit/reply modes, IME-safe input), `Overlay` (forward/delete/react modals).
- **Hooks**: `useTerminalSize`, `useChannelData` (members, sender names, online tracking), `useMessages` (send/edit/delete/react/forward via REST, WS event handling), `useFocus` (panel/message index management).
- **WS events**: Extended `ws-client.ts` to handle 9 server events (`message.created/updated/deleted`, `message.reaction`, `message.read`, `typing.updated`, `presence.updated`, `channel.created`, `dm.created`).
- **Layout**: Single outer frame with vertical sidebar divider, tab bar with top border, TopBar/BottomBar outside frame, fullscreen with `useTerminalSize`.
- **Background**: Dark semi-transparent via `\x1b]Ph` OSC sequence for macOS Terminal.app.
- **IME fix**: `isPrintable()` filter strips ANSI escape sequences and control characters to prevent CoreText crashes during CJK input.
- **Screenshots**: Added TUI sample to README alongside Web login/chat screenshots (3 images, 30% each).
- Verification: `pnpm --filter @nexus-chat/tui lint`, `pnpm --filter @nexus-chat/tui typecheck`, `pnpm --filter @nexus-chat/tui test`, `pnpm --filter @nexus-chat/tui build`, `pnpm build`, `pnpm test` all passed.

### 8.4 Server Host & CORS Configuration (2026-07-08)

Added explicit server binding and CORS documentation to support LAN / production deployment:

- `apps/server/src/config/env.ts`: Added `HOST` env var (default `"127.0.0.1"` after CI IPv4/IPv6 fix).
- `apps/server/src/index.ts`: `serve()` now passes `hostname: env.HOST` for binding control.
- `docker-compose.yml`: Added `HOST` with extensive comments covering `localhost`, `0.0.0.0`, `::`, domain, and IP scenarios. Added `WEB_ORIGIN` CORS documentation.
- `.env.example`: Added `HOST`, `WEB_ORIGIN`, and `VITE_API_BASE` with deployment scenario comments.

### 8.5 Docker Web Client (2026-07-08)

Added a Dockerized web client served by nginx:

- `Dockerfile.web`: multi-stage build (pnpm install → turbo build → nginx runner). `VITE_API_BASE` injected as build arg.
- `Dockerfile.web.dockerignore`: web-specific exclusions.
- `docker/nginx-web.conf`: nginx config serving built Vite output, `try_files $uri /index.html` for SPA routing.
- `docker-compose.yml`: added `web` service (port `5173:80`, depends on server). Removed `# syntax=docker/dockerfile:1` from both Dockerfiles to fix Ubuntu IPv6 network timeout.
- README and Quickstart updated with Docker web usage instructions and LAN deployment examples.

### 8.6 Address Configuration Cleanup (2026-07-08)

Standardized network address defaults across the stack:

- `HOST` default: `127.0.0.1` (avoids IPv4/IPv6 localhost ambiguity on Linux).
- Docker Compose server binds `HOST=0.0.0.0`.
- `VITE_API_BASE` default: `http://127.0.0.1:4000`.
- `NEXUS_API_BASE` default (TUI): `http://127.0.0.1:4000`.
- Added `API_PUBLIC_BASE` env var: server-embedded upload/download URLs use this instead of hardcoded `localhost:4000`.
- Added `WEB_ORIGIN=*` wildcard support in HTTP CORS and Socket.IO origin checks for temporary local/LAN testing.
- Docker Compose `WEB_ORIGIN` and `API_PUBLIC_BASE` changed from hardcoded values to `${VAR:-default}` so `.env` overrides work.
- `pnpm dev` (root) filtered to `server, web, desktop` only — TUI CLI excluded to prevent turbo from being killed by help-and-exit.
- TUI `dev` script changed from `tsx src/index.ts` to `tsx src/index.ts chat`.

### 8.7 Documentation Hub Reorganization (2026-07-09)

- `docs/design/07_P2P_DM_Direct_Connection.md`: P2P WebRTC DataChannel design doc.
- `docs/design/08_TUI_Chat_Redesign.md`: TUI two-pane chat redesign doc.
- `docs/design/09_Web_Client_UI_Design.md`: full Web client component architecture, Zustand store map, and mobile adaptation plan (P0/P1/P2).
- `docs/tasks/26-phase-1-web-mobile-adaptation.md`: mobile adaptation task with acceptance criteria.
- `docs/README.md`: extended Design Documents (07/08/09), Implementation Tasks (18–26), Bot SDK docs, and Meta Documents.
- `mkdocs.yml`: removed "Implementation Tasks" nav section, added TUI Chat Redesign and Web Client UI Design entries, added copyright + MIT license footer, footer CSS override for left/right split layout.
- Symlinks: `docs/README.project.md → ../README.md`, `docs/QUICKSTART.md → ../QUICKSTART.md`.
- `AGENTS.md`: added rules prohibiting automatic commits, pushes, and force-pushes without explicit user approval.

### 8.8 Web Mobile Adaptation Plan (2026-07-09)

Design and task documents created for making the Web client usable on phones (<768px):

- **P0 (broken without)**: viewport meta tag, sidebar as overlay drawer (uses existing `useUiStore.sidebarOpen`), hamburger button in ChatHeader, long-press context menu replacing right-click on touch devices.
- **P1 (degraded UX)**: responsive modal widths, emoji picker grid/width, login bottom padding.
- **P2 (polish)**: right panel as bottom sheet, 44px touch targets, safe area insets, composer keyboard avoidance.

### 8.9 AGENTS.md Git Rules (2026-07-09)

Added to `AGENTS.md`:
- **Do NOT commit or create commits unless the user explicitly requests it.**
- **Do NOT push unless the user explicitly approves it.**
- **Do NOT force-push unless the user explicitly asks for it.**

### 8.11 Phase 2 PostgreSQL Persistence (2026-07-17 — complete)

Task #28 complete — PostgreSQL wired as production persistence with async domain adapters:

- **Infrastructure**: `PERSISTENCE=memory|postgres` env switch with production validation. Lazy Drizzle pool, `DB_MIGRATE_ON_BOOT`, graceful `closeDb()`. Schema parity migration with FK constraints, unique indexes, and timestamp defaults.
- **Persistence adapters** (7 new files): `auth/persistence.ts`, `workspaces/persistence.ts` + `persistence-service.ts`, `messages/persistence.ts`, `attachments/persistence.ts`, `bots/persistence.ts`, `signal/persistence.ts`. Each domain has both an `InMemory*Persistence` and `Drizzle*Persistence` class implementing the same interface, selected via `env.PERSISTENCE`.
- **Service refactors** (5 files): All domain services migrated to `async` persistence calls. Signal and attachment services reformatted with full module documentation.
- **HTTP/WS integration**: Routes, gateway, and socket adapted for async service methods. `index.ts` calls `pingDb()` and `runMigrations()` on startup.
- **DB Operations**: `FOR UPDATE SKIP LOCKED` for concurrent one-time prekey allocation. Bot install creates a non-login `users` row for FK satisfaction. Message idempotency via `(sender_id, client_msg_id)` unique index.
- **Tests**: `persistence-memory.test.ts` (24 tests), `persistence-drizzle.test.ts` (16 tests), `persistence-service.test.ts` (13 RBAC tests), updated `services.test.ts` and `gateway.test.ts`.
- **CI**: `postgres-smoke` job in unified `ci.yml` runs `scripts/ci-pg-smoke.sh` — 60 assertions across 12 acts: Alice/Bob onboarding, channel creation/conversation, reactions/edits/pins, read receipts, dev file upload/download with content verification, DM conversation, forward/save, /help bot, concurrent Signal prekey allocation, server restart persistence verification.
- **Security**: GitHub Dependency Review (`actions/dependency-review-action@v4`) replaces deprecated npm audit API.
- **Design Decisions**: Domain-specific persistence ports (not generic repository). Global `getXxxPersistence()` factory pattern with service-locator style. In-memory adapter co-exists in same file as Drizzle adapter. Dev file upload bytes are memory-only and expected to disappear on restart; file metadata persists in PostgreSQL.

### 8.10 E2EE Real Encryption Implementation (2026-07-10)

Task #27 completed — replaced the placeholder Base64 "encryption" with real cryptographic operations:

- **IE2eeProvider interface** (`packages/signal/src/types.ts`): 7-method abstraction with swappable backends.
- **noble.ts**: ECDH P-256 key exchange + AES-256-GCM encryption via `@noble/curves` and `@noble/ciphers`. Pure JS, works over plain HTTP, MIT license. **Default provider.**
- **webcrypto.ts**: SubtleCrypto-based ECDH + AES-256-GCM. Requires `localhost` / HTTPS.
- **placeholder.ts**: Preserves original behavior (Base64 + random hex) marked `@deprecated`. Used when `E2EE_BACKEND=placeholder`.
- **crypto.ts**: File encryption/decryption helpers (AES-256-GCM), shared by all providers.
- **index.ts**: Provider selection via `E2EE_BACKEND` env var. IV embedded in ciphertext (`iv.base64ciphertext` format) for backward compatibility.
- **E2EE file attachments**: Removed the `!isE2e` block hiding the 📎 button. Client-side file encryption/decryption through IE2eeProvider.
- **Shared schema update**: `algorithm` field widened from `"signal-v1"` → `"signal-v1" | "aes-256-gcm-v1"`.
- **P2P types**: `algorithm` widened from `"signal-v1"` → `string` in transport types.
- **Downstream fixes**: `signal-helpers.ts`, `ChatRoute.tsx`, and `smoke.ts` updated for async API (key generation, session establishment now async).
- **Tests**: 33 tests in `packages/signal/src/index.test.ts` covering all 3 providers, crypto helpers, session store, provider selection, and legacy helpers.
- **Coverage**: Signal package 100% lines/statements/functions/branches. Coverage thresholds met project-wide.
- **Verification**: `pnpm build` (11/11), `pnpm test` (15/15), `pnpm coverage` (100/93.34/100/100).

---

## 9. Open Questions / Next Steps

1. **Framework finalization**: Hono vs Fastify — decision pending on whether serverless/edge deployment is a near-term requirement. Hono is the research recommendation; Fastify is the fallback if JSON throughput becomes a bottleneck and edge deployment is ruled out.

2. **AGPL-3.0 license impact**: `@signalapp/libsignal-client` is AGPL-3.0 licensed. If nexus-chat is closed-source, alternatives such as `2key-ratchet` (MIT) or Matrix Olm (Apache 2.0) must be evaluated.

3. **Electron WebSocket architecture**: Whether the WebSocket connection lives in the main process or renderer process — research suggests main process for persistence and reliability, but final architecture needs design confirmation.

4. **Multi-device E2EE**: Phase 1 targets single-device E2EE only. Multi-device support (per-device independent keys) is deferred to Phase 2.5.

5. **Group E2EE Sender Key rotation**: Exact UX for key rotation during member join/leave events (whether to block the UI during rotation, how to handle offline members) needs detailed design.

6. **Plugin marketplace**: Governance model, review process, and monetization strategy for third-party plugins deferred to Phase 3.

7. **Region-specific compliance**: E2EE legal landscape varies by jurisdiction (EU supports, UK/India challenging, China prohibits). Need to determine whether region-specific builds are required.

8. **Infrastructure provisioning**: Kubernetes cluster setup, Redis Sentinel/Cluster topology, PostgreSQL high-availability configuration, and CDN selection for file storage all require operational planning.

9. **CI/CD pipeline**: Complete pipeline design including dependency security scanning (Snyk, Socket.dev), E2E testing with Playwright, Electron packaging/signing/notarization, and auto-update publishing flow.

10. **Type sharing strategy**: Partially resolved. The `@nexus-chat/shared` package already defines 40+ canonical Zod schemas for message events, Socket.IO event contracts, Bot SDK types, and E2EE protocol messages. The remaining gap is end-to-end type propagation from schemas through service interfaces into client-side state management — the schemas exist but are not yet enforced at every compile-time boundary.

11. **Signal Protocol Phase 3**: Real ECDH + AES-256-GCM is active for 1:1 DM E2EE (Task #27). Full X3DH + Double Ratchet via `@signalapp/libsignal-client` is deferred to Phase 3 on a separate AGPL-3.0 distribution branch to avoid copyleft contamination of the MIT-licensed `main` branch.

12. **Docker web VITE_API_BASE**: `VITE_API_BASE` is baked into the web Docker image at build time. Changing the API URL requires rebuilding the web image. A reverse-proxy approach should be considered for production deployments where the API URL may change without rebuilding.

13. **Dependency injection for persistence**: Current `getXxxPersistence()` factory follows service-locator pattern. Future refactoring should consider constructor injection with a DI container for testability and reduced import coupling.

14. **Demo mode removal impact**: `demo-data.ts` and `demo-access-token` guards are removed. Web login is now real-server-only. Screenshots and offline demos require a running server. Alternative: a standalone demo build could be restored if needed.
