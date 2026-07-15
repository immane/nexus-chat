---
lang: en
---

# Nexus Chat — Documentation Hub

> A Slack-like instant messaging platform with **hybrid encryption modes** — [normal] IM + Bot, or [end-to-end encrypted] IM only — delivered as a SaaS multi-tenant Electron desktop application.

---

## Table of Contents

1. [Project Summary](#1-project-summary)
2. [Key Technology Stack](#2-key-technology-stack)
3. [Architecture Overview](#3-architecture-overview)
4. [Project Structure](#4-project-structure)
5. [Phase Roadmap](#5-phase-roadmap)
6. [Document Index](#6-document-index)

---

## 1. Project Summary

Nexus Chat is a desktop-first team communication platform that combines the familiarity of Slack-style messaging with modern cryptographic guarantees. Every channel and direct message operates in one of two modes:

| Mode | Description |
|------|-------------|
| **Normal** | Full IM features: real-time messaging, server-side search, bot participation, slash commands |
| **E2E** | End-to-end encrypted via client-side ECDH + AES-256-GCM (Phase 1-2, MIT-compatible): the server is an opaque relay that cannot read message content, bots are fully excluded, and read-once/disappearing messages are supported for sensitive DMs. Signal Protocol (X3DH + Double Ratchet) planned for Phase 3 on a separate AGPL-3.0 distribution branch. |

A single workspace can contain **both** normal and E2E channels side-by-side, letting teams choose the appropriate security model per conversation.

### Key Differentiators

- **Per-channel encryption mode** — not all-or-nothing; mix normal and E2E in one workspace
- **Desktop and terminal clients** — Electron GUI plus a Phase 1 TUI command-line interface for developers, operators, and keyboard-first users
- **First-class streaming message protocol** — progressive token-by-token AI responses rendered in-channel
- **Bot SDK in 6 languages** — TypeScript, Java, Python, PHP, Go, Rust
- **Bundled base bots** — Welcome, Help, Notifications, Reminders, Polls, Webhooks, Kudos out of the box
- **AI Assistant Bot** — summarize, translate, draft, and search using core full-text search in Phase 2; RAG/semantic memory is Phase 3

---

## 2. Key Technology Stack

### Frontend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Desktop Shell | **Electron** | Cross-platform windowing, system tray, notifications, auto-update |
| UI Framework | **React 19 + Vite 7** | Component-based SPA loaded by Electron |
| State Management | **Zustand** | Lightweight stores with selector precision for high-frequency IM updates |
| Styling | **Tailwind CSS v4 + CVA + shadcn/ui** | Utility-first design tokens, component variants, accessible primitives |
| Virtual Scroll | **react-virtuoso** | Bidirectional infinite scroll for message lists |
| Markdown | **markdown-it + Shiki** | Rich message content with syntax-highlighted code blocks |
| Terminal UI | **Ink + Commander** | Phase 1 TUI/CLI for login, workspace navigation, channel/DM messaging, and E2E DM verification |

### Backend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| HTTP Server | **Hono v4.12** | <50ms cold start, cross-runtime, built-in middleware |
| WebSocket | **Socket.IO v4 + Redis Adapter** | Room management, reconnect, heartbeat, horizontal scaling |
| ORM | **Drizzle ORM** | Type-safe SQL queries, lightweight migration runner |
| Database | **PostgreSQL 16** | ACID storage, full-text search (tsvector), attachment metadata, bot/core state |
| Cache / PubSub | **Redis 7** | Session cache, presence, rate limiting, event bus, Socket.IO adapter |
| Event Bus | **Redis Streams → NATS JetStream** | Phase 1 event bus → Phase 3 upgrade for subject-hierarchy routing |
| Task Queue | **BullMQ** | Per-bot isolation, retries, dead letter queue |

### Encryption & AI

| Component | Technology | Purpose |
|-----------|-----------|---------|
| E2E Encryption | **@noble/curves + @noble/ciphers** (Phase 1-2, MIT) | ECDH key exchange + AES-256-GCM for 1:1 DMs. Phase 3 upgrades to Signal Protocol on a separate AGPL-3.0 branch. |
| AI Agent Framework | **Vercel AI SDK v6** (Phase 2), **LangGraph** (Phase 3) | Streaming-first agent orchestration, tool calling, multi-agent |
| LLM Providers | **OpenAI / Anthropic / Google / OpenRouter / Ollama** | Multi-provider abstraction with fallback chain |
| Vector Store | **pgvector** (Phase 3) | In-database semantic search after full-text search, retention, and deletion semantics are stable |

### Monorepo & DevOps

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Package Manager | **pnpm** + **Turborepo** | Workspace management, parallel builds, task caching |
| Language | **TypeScript** (strict mode) | End-to-end type safety |
| Validation | **Zod** | Runtime type validation at API boundaries |
| Logging | **Pino** | Structured JSON logging with trace context |
| Metrics | **Prometheus + Grafana** | Performance dashboards, alerting rules |
| Tracing | **OpenTelemetry** (Phase 3) | Distributed tracing across services |

---

## 3. Architecture Overview

### 3.1 Layer Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Client Shell (Electron)                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              UI Rendering (React 19 + Vite 7)              │  │
│  │    React components → Zustand stores → IndexedDB cache     │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │         Main Process (Node.js)                             │  │
│  │    Window Manager · System Tray · Notifications · Updater  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTPS / WSS
┌─────────────────────────────┴────────────────────────────────────┐
│               Long Connection & Core Gateway                     │
│     Hono HTTP Server (REST)  ·  Socket.IO Server (WebSocket)     │
│     JWT Auth · Rate Limiting · CORS/Helmet.js · Zod Validation   │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│            Business Logic & Persistence Backend                  │
│     Auth · Workspace · Channel · Message · File · Signal Key     │
│     PostgreSQL · Redis (Cache + Pub/Sub + Rate Limit)            │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│           Async Bot Engine & Event Dispatch                      │
│     Redis Streams Consumer · Bot Command Router · BullMQ Queues  │
│     Bot WebSocket Manager · Webhook Delivery Tracker             │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│           AI Agent & Streaming Engine                            │
│     Command Parser → Agent Router → LLM Provider Abstraction     │
│     Tool Executor · Memory Manager · Stream Manager (100ms)      │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Core Design Principles

- **Monolith-first with clear boundaries** — Phase 1 deploys as a single process; service boundaries in code enable future split without rewrites
- **Zero-knowledge encryption server** — Private keys never leave the client; the E2EE key server stores only public keys and ciphertext
- **Streaming-native protocol** — First-class `stream_start → stream_chunk → stream_end` events in the WebSocket layer
- **Bot SDK parity** — First-party bundled bots use the same public SDK as third-party developers
- **Hybrid mode per channel** — Normal and E2E channels coexist in one workspace; bots are automatically excluded from E2E

---

## 4. Project Structure

```
nexus-chat/
├── apps/
│   ├── server/                  # Node.js backend (Hono + Socket.IO + Bot Engine + AI Engine)
│   ├── web/                     # React SPA (Vite + Zustand + Tailwind)
│   ├── desktop/                 # Electron shell (window, tray, notifications, updater)
│   └── tui/                     # Terminal UI / CLI client (Ink + Commander)
├── packages/
│   ├── shared/                  # Shared types, Zod schemas, constants, event definitions
│   ├── signal/                  # E2EE abstraction layer (IE2eeProvider + 3 implementations)
│   ├── bot-sdk/                 # Public Bot SDK (TypeScript/Node.js)
│   ├── ai-bot/                  # AI Agent Engine (Phase 2)
│   └── ui/                      # Shared React UI component library
├── packages/bots/               # First-party bundled bots
│   ├── welcome-bot/
│   ├── help-bot/
│   ├── notification-bot/
│   ├── reminder-bot/
│   ├── poll-bot/
│   ├── webhook-bot/
│   └── kudos-bot/
├── docs/
│   ├── README.md                # This document
│   ├── ai/                      # AI session context
│   ├── design/                  # Architecture & design documents
│   ├── research/                # Technical research & surveys
│   ├── tasks/                   # Phase implementation task breakdowns
│   └── sdk/                     # Multi-language Bot SDK documentation
├── package.json                 # Workspace root
├── turbo.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── AGENTS.md                    # Project conventions
└── LICENSE                      # MIT
```

---

## 5. Phase Roadmap

> **Full breakdown**: [06 — Phase Roadmap & Milestone Plan](design/06_Phase_Roadmap.md)
>
> **Phase 1 implementation tasks**: see [Implementation Task Documents](#63-implementation-task-documents)

### Phase 1 — MVP Foundation (0–3 months)

**Goal**: Usable Slack-like IM with hybrid encryption.

- Email/password auth, JWT tokens
- Workspace creation, channel management (public/private/DM)
- Text messages with state machine (Draft → Sent → Delivered → Read)
- Markdown rendering, emoji reactions
- ECDH + AES-256-GCM E2EE for 1:1 DMs, including read-once/disappearing message policy (Phase 3: Signal Protocol on separate branch)
- Bot registration, slash command routing, Redis Streams event bus
- **7 base bots**: Welcome, Help, Notification, Reminder, Poll, Webhook, Kudos
- Electron shell with window management, tray, notifications
- TUI command-line client for auth, workspace/channel navigation, messaging, and E2E DM smoke testing
- Monolith deployment: Hono + Socket.IO + Bot Engine in one process

### Phase 2 — Rich Features & Production Hardening (+3–6 months)

**Goal**: Feature-complete IM platform ready for public GA launch.

- File/image upload with S3 presigned URLs, inline previews, thumbnails
- Full-text message search (PostgreSQL tsvector)
- Threaded replies, thread sidebar
- Online presence, typing indicators, read receipts
- Group E2E via Sender Key for multi-member channels
- Bot interactive components (buttons, modals, Block Kit), webhook delivery
- **AI Assistant Bot**: `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft`, `/ai search` using core full-text search; RAG is Phase 3
- **Streaming message protocol**: stream_start → stream_chunk → stream_end
- **7 more base bots**: Todo, GitHub/GitLab, CI/CD, Standup, Celebration, Feedback
- Electron cross-platform packaging, code signing, auto-update
- Offline message queue, IndexedDB cache
- Multi-instance deployment, Redis Sentinel/Cluster

### Phase 3 — Advanced & Enterprise (+6–12 months)

**Goal**: Enterprise-grade platform with voice/video, multi-agent AI, and bot marketplace.

- Voice/video calls (WebRTC), screen sharing
- SSO (SAML/OIDC), Google/Microsoft/GitHub OAuth
- Advanced E2E: safety numbers, device management, sealed sender, transparency/audit UX
- Multi-device session relay
- Enterprise admin dashboard, audit logs, data retention, compliance exports
- **5 advanced bots**: Status, Scheduler, Meeting Notes, AutoMod + Bot Marketplace
- **Multi-agent AI**: LangGraph supervisor-worker, debate patterns, `/ai research`, `/ai code`
- Self-hosted LLM support (Ollama, vLLM)
- Microservices split: Gateway / Message / Bot Engine / File services
- NATS JetStream event bus, database-per-service
- OpenTelemetry distributed tracing

---

## 6. Document Index

### 6.1 Design Documents

| # | Document | Description |
|---|----------|-------------|
| 00 | [System High-Level Architecture](design/00_System_High_Level_Architecture.md) | Layer diagram, tech stack table, data flows (normal/E2E/bot/AI), deployment architecture, cross-cutting decisions |
| 01 | [Client Shell & UI Rendering](design/01_Client_Shell_and_UI_Rendering_Layer.md) | Electron process model, React component tree, Zustand store architecture (7 stores), performance strategy, theme system |
| 02 | [Long Connection & Core Gateway](design/02_Long_Connection_and_Core_Gateway_Layer.md) | WebSocket protocol envelope, connection state machine, REST API route groups, auth flow, rate limiting, message relay pipeline |
| 03 | [Business Logic & Persistence](design/03_Business_Logic_and_Persistence_Backend.md) | Module breakdown (7 services), Drizzle ORM schema (13 tables), message/channel state machines, Signal key server, Redis caching (6 layers), security |
| 04 | [Async Bot Engine & Event Dispatch](design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) | Event pipeline, connection lifecycle, Bot SDK design, slash command framework, BullMQ queues, streaming protocol extension, base bot catalog |
| 05 | [AI Agent Orchestration & Streaming](design/05_AI_Agent_Orchestration_and_Streaming.md) | Streaming protocol, engine architecture (5 subsystems), command router, LLM provider abstraction, tool system, memory, Phase 3 RAG, prompt engineering, privacy |
| 06 | [Phase Roadmap & Milestone Plan](design/06_Phase_Roadmap.md) | Consolidated Phase 1/2/3 goals, week-by-week breakdown, bot catalog rollout, AI implementation sequence, package delivery matrix, infrastructure evolution |
| 07 | [P2P DM Direct Connection](design/07_P2P_DM_Direct_Connection.md) | WebRTC DataChannel for 1:1 E2EE DMs, peer discovery, relay fallback, signal server integration |
| 08 | [TUI Chat Redesign](design/08_TUI_Chat_Redesign.md) | Two-pane terminal UI layout, Ink components, WS event handling, IME-safe CJK input |
| 09 | [Web Client UI Design](design/09_Web_Client_UI_Design.md) | Desktop layout, Zustand store architecture, component tree, mobile adaptation plan (P0/P1/P2) |
| 10 | [E2EE Encryption Abstract Layer](design/10_E2EE_Encryption_Abstract_Layer.md) | IE2eeProvider interface, placeholder/@noble/SubtleCrypto implementations, ECDH + AES-256-GCM, Phase 3 Signal Protocol upgrade path |
| 11 | [PostgreSQL Persistence Integration](design/11_PostgreSQL_Persistence_Integration.md) | Production PostgreSQL migration boundary, schema parity, async query-shaped ports, transaction rules, and vertical-slice rollout |

### 6.2 Research Documents

| Document | Description |
|----------|-------------|
| [Frontend Architecture](research/frontend-architecture.md) | Electron + React + Vite integration, virtual scrolling, Zustand patterns, Tailwind theming, offline strategy, performance monitoring |
| [Backend IM & State Machine](research/backend-im-state-machine.md) | Framework comparison (Hono/Fastify/NestJS), WebSocket architecture, message/channel state machines, database design, Redis caching, security |
| [UI Components & Plugin Protocol](research/ui-components-plugin-protocol.md) | Component hierarchy, message rendering, plugin sandbox (iframe/Worker), extension points, Block Kit-style UI, security isolation |
| [Bot Engine & Microservices](research/bot-engine-microservices.md) | Event-driven architecture, Redis Streams → NATS, connection modes, Bot SDK design, task queues (BullMQ), service split boundaries, observability |
| [Security Defense & E2EE](research/security-defense-e2ee-roadmap.md) | Helmet.js/CORS/CSP, Argon2id, JWT best practices, E2E encryption deep dive, threat model, GDPR compliance |
| [Base Bot Catalog](research/base-bot-catalog.md) | Platform survey (Slack/Discord/Teams/Telegram), 17 recommended bots across 5 domains, priority matrix, interaction models, implementation strategy |
| [AI Agent Orchestration](research/ai-agent-orchestration.md) | Streaming message design, agent frameworks survey (Vercel AI SDK/LangGraph/Mastra/CrewAI), LLM provider abstraction, context/memory, tool calling, prompt engineering |

### 6.3 Implementation Task Documents

| # | Task | Description |
|---|------|-------------|
| 01 | [Project Scaffold](tasks/01-phase-1-project-scaffold.md) | pnpm monorepo, Turborepo, TypeScript, lint/test/build workflow |
| 02 | [Shared Contracts](tasks/02-phase-1-shared-contracts.md) | Zod schemas, API envelopes, message content, attachment refs, bot events |
| 03 | [Database Schema](tasks/03-phase-1-database-schema.md) | Drizzle schema, migrations, core tables, attachment tables, bot membership/subscriptions |
| 04 | [Auth & Security](tasks/04-phase-1-auth-session-security.md) | Registration/login, Argon2id, JWT rotation, Redis sessions, security baseline |
| 05 | [Core Gateway](tasks/05-phase-1-core-gateway.md) | Hono + Socket.IO, auth middleware, rate limits, protocol routing |
| 06 | [Workspace & Channel Service](tasks/06-phase-1-workspace-channel-service.md) | Workspaces, members, public/private channels, DMs, channel mode |
| 07 | [Message Service](tasks/07-phase-1-message-service.md) | Message state machine, pagination, edit/delete, reactions, read receipts, forward/save |
| 08 | [Attachment Service Foundation](tasks/08-phase-1-attachment-service-foundation.md) | Core upload sessions, file records, signed URLs, E2E-safe attachment boundary |
| 09 | [Signal DM E2EE (Placeholder)](tasks/09-phase-1-signal-dm-e2ee.md) | PreKeyBundle infrastructure, session management, ciphertext protocol. Real ECDH + AES-256-GCM encryption deferred to Task #27. |
| 10 | [Bot Engine Core](tasks/10-phase-1-bot-engine-core.md) | Bot registration, opaque tokens, event subscriptions, BullMQ queues, command routing |
| 11 | [Node Bot SDK](tasks/11-phase-1-bot-sdk-node-reference.md) | First Bot SDK implementation, WebSocket transport, reconnect, event API |
| 12 | [Minimal Base Bots](tasks/12-phase-1-base-bots-minimal.md) | Welcome, Help, Notification bots; optional Reminder/Poll/Webhook/Kudos stretch |
| 13 | [Web Client Shell](tasks/13-phase-1-web-client-shell.md) | React app, Zustand stores, chat layout, virtual list, generic bot extension slots |
| 14 | [Electron Shell](tasks/14-phase-1-electron-shell.md) | Secure Electron main/preload, tray, notifications, native integration |
| 15 | [Observability & Hardening](tasks/15-phase-1-observability-security-hardening.md) | Pino logs, audit events, metrics, rate-limit metrics, security checks |
| 16 | [Local Dev, CI & Release](tasks/16-phase-1-local-dev-ci-release.md) | Docker Compose, CI jobs, docs build, preview deploy, closed beta checklist |
| 17 | [TUI Command-Line Client](tasks/17-phase-1-tui-cli.md) | Terminal client for auth, workspace/channel navigation, messaging, and E2E smoke tests |
| 18 | [P2P DM Direct Connection](tasks/18-phase-1-p2p-dm-direct.md) | WebRTC DataChannel, peer signaling, relay fallback, P2P/Signal transport mode |
| 19 | [Web Message Actions & Context Menu](tasks/19-phase-1-web-message-actions.md) | Right-click context menu, reply/forward/copy/edit/delete/react, inline emoji picker |
| 20 | [Web Message Display & Formatting](tasks/20-phase-1-web-message-display.md) | Markdown rendering, relative timestamps, date separators, link previews |
| 21 | [Web Rich Media & Emoji Picker](tasks/21-phase-1-web-rich-media.md) | Emoji picker popover, file upload with progress, clipboard image paste, inline attachment rendering |
| 22 | [Web Presence, Channel Info & Notifications](tasks/22-phase-1-web-presence-notifications.md) | Online status dots, toast notifications, browser notifications, channel info panel |
| 23 | [Server Message Reply & Pin](tasks/23-phase-1-server-message-reply-pin.md) | replyToMessageId in send schema, pin store, REST API, WS events |
| 24 | [Server Channel Mute & Description](tasks/24-phase-1-server-channel-mute-description.md) | Channel description field, mute store, REST endpoints |
| 25 | [TUI Chat Redesign](tasks/25-phase-1-tui-chat-redesign.md) | Two-pane terminal layout, WS event hooks, format utilities, IME-safe CJK input |
| 26 | [Web Mobile Adaptation](tasks/26-phase-1-web-mobile-adaptation.md) | Viewport meta, overlay drawer sidebar, long-press context menu, responsive modals, safe area |
| 27 | [E2EE Real Encryption](tasks/27-phase-1-e2ee-real-encryption.md) | IE2eeProvider interface, @noble/* ECDH + AES-256-GCM, WebCrypto, file encryption helpers, 119 tests |
| 28 | [PostgreSQL Persistence Integration](tasks/28-phase-2-postgresql-persistence-integration.md) | PostgreSQL production persistence, schema parity, async ports, transaction-safe vertical migration, and in-memory test adapters |

### 6.4 Bot SDK Documentation (Multi-Language)

| Language | Document | Package / Module |
|----------|----------|------------------|
| TypeScript / Node.js | [nodejs.md](sdk/nodejs.md) | `@nexus-chat/bot-sdk` (npm) |
| Java | [java.md](sdk/java.md) | `chat.nexus:nexus-bot-sdk` (Maven/Gradle) |
| Python | [python.md](sdk/python.md) | `nexus-bot-sdk` (pip) |
| PHP | [php.md](sdk/php.md) | `nexus-chat/bot-sdk` (Composer) |
| Go | [go.md](sdk/go.md) | `github.com/nexus-chat/bot-sdk-go` |
| Rust | [rust.md](sdk/rust.md) | `nexus-bot-sdk` (crates.io) |

Each SDK doc covers: installation, quick start, connection lifecycle, 9 event types, message/channel API, middleware pipeline, rate limiting, reconnection strategy, slash command registration, bot manifest, error handling, and 3+ complete examples.

### 6.5 Meta Documents

| Document | Description |
|----------|-------------|
| [AI Session Context](ai/context.md) | Record of design decisions and discussion made during the initial architecture session |
| [AGENTS.md](../AGENTS.md) | Project conventions: language, tech stack, code style, Git workflow, branch naming |

---

> **Convention**: All documentation is written in English. Code blocks use TypeScript, and design diagrams use ASCII art. See [AGENTS.md](../AGENTS.md) for full conventions.
