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
| **E2E** | End-to-end encrypted via the [Signal Protocol](https://github.com/signalapp/libsignal): the server is an opaque relay that cannot read message content, and bots are fully excluded |

A single workspace can contain **both** normal and E2E channels side-by-side, letting teams choose the appropriate security model per conversation.

### Key Differentiators

- **Per-channel encryption mode** — not all-or-nothing; mix normal and E2E in one workspace
- **First-class streaming message protocol** — progressive token-by-token AI responses rendered in-channel
- **Bot SDK in 6 languages** — TypeScript, Java, Python, PHP, Go, Rust
- **Bundled base bots** — Welcome, Help, Notifications, Reminders, Polls, Webhooks, Kudos out of the box
- **AI Assistant Bot** — summarize, translate, draft, search with RAG, all streamed live

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

### Backend

| Component | Technology | Purpose |
|-----------|-----------|---------|
| HTTP Server | **Hono v4.12** | <50ms cold start, cross-runtime, built-in middleware |
| WebSocket | **Socket.IO v4 + Redis Adapter** | Room management, reconnect, heartbeat, horizontal scaling |
| ORM | **Drizzle ORM** | Type-safe SQL queries, lightweight migration runner |
| Database | **PostgreSQL 16 + pgvector** | ACID storage, full-text search (tsvector), vector embeddings for RAG |
| Cache / PubSub | **Redis 7** | Session cache, presence, rate limiting, event bus, Socket.IO adapter |
| Event Bus | **Redis Streams → NATS JetStream** | Phase 1 event bus → Phase 3 upgrade for subject-hierarchy routing |
| Task Queue | **BullMQ** | Per-bot isolation, retries, dead letter queue |

### Encryption & AI

| Component | Technology | Purpose |
|-----------|-----------|---------|
| E2E Encryption | **@signalapp/libsignal** (Signal Protocol) | X3DH key exchange + Double Ratchet for 1:1 and group E2E |
| AI Agent Framework | **Vercel AI SDK v6** (Phase 2), **LangGraph** (Phase 3) | Streaming-first agent orchestration, tool calling, multi-agent |
| LLM Providers | **OpenAI / Anthropic / Google / OpenRouter / Ollama** | Multi-provider abstraction with fallback chain |
| Vector Store | **pgvector** | In-database semantic search over channel history for RAG |

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
│                    Client Shell (Electron)                        │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              UI Rendering (React 19 + Vite 7)              │  │
│  │    React components → Zustand stores → IndexedDB cache     │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │         Main Process (Node.js)                              │  │
│  │    Window Manager · System Tray · Notifications · Updater  │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
                              │ HTTPS / WSS
┌─────────────────────────────┴────────────────────────────────────┐
│               Long Connection & Core Gateway                      │
│     Hono HTTP Server (REST)  ·  Socket.IO Server (WebSocket)      │
│     JWT Auth · Rate Limiting · CORS/Helmet.js · Zod Validation   │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│            Business Logic & Persistence Backend                    │
│     Auth · Workspace · Channel · Message · File · Signal Key     │
│     PostgreSQL + pgvector · Redis (Cache + Pub/Sub + Rate Limit) │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│           Async Bot Engine & Event Dispatch                       │
│     Redis Streams Consumer · Bot Command Router · BullMQ Queues  │
│     Bot WebSocket Manager · Webhook Delivery Tracker             │
└─────────────────────────────┬────────────────────────────────────┘
                              │
┌─────────────────────────────┴────────────────────────────────────┐
│           AI Agent & Streaming Engine                              │
│     Command Parser → Agent Router → LLM Provider Abstraction     │
│     Tool Executor · Memory Manager · Stream Manager (100ms)      │
└──────────────────────────────────────────────────────────────────┘
```

### 3.2 Core Design Principles

- **Monolith-first with clear boundaries** — Phase 1 deploys as a single process; service boundaries in code enable future split without rewrites
- **Zero-knowledge encryption server** — Private keys never leave the client; the Signal Protocol key server stores only public keys
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
│   └── desktop/                 # Electron shell (window, tray, notifications, updater)
├── packages/
│   ├── shared/                  # Shared types, Zod schemas, constants, event definitions
│   ├── signal/                  # Signal Protocol wrapper (@signalapp/libsignal)
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

### Phase 1 — MVP Foundation (0–3 months)

**Goal**: Usable Slack-like IM with hybrid encryption.

- Email/password auth, JWT tokens
- Workspace creation, channel management (public/private/DM)
- Text messages with state machine (Draft → Sent → Delivered → Read)
- Markdown rendering, emoji reactions
- Signal Protocol E2E for 1:1 DMs
- Bot registration, slash command routing, Redis Streams event bus
- **7 base bots**: Welcome, Help, Notification, Reminder, Poll, Webhook, Kudos
- Electron shell with window management, tray, notifications
- Monolith deployment: Hono + Socket.IO + Bot Engine in one process

### Phase 2 — Rich Features & Production Hardening (+3–6 months)

**Goal**: Feature-complete IM platform ready for public GA launch.

- File/image upload with S3 presigned URLs, inline previews, thumbnails
- Full-text message search (PostgreSQL tsvector)
- Threaded replies, thread sidebar
- Online presence, typing indicators, read receipts
- Group E2E via Sender Key for multi-member channels
- Bot interactive components (buttons, modals, Block Kit), webhook delivery
- **AI Assistant Bot**: `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft`, `/ai search` with RAG
- **Streaming message protocol**: stream_start → stream_chunk → stream_end
- **7 more base bots**: Todo, GitHub/GitLab, CI/CD, Standup, Celebration, Feedback
- Electron cross-platform packaging, code signing, auto-update
- Offline message queue, IndexedDB cache
- Multi-instance deployment, Redis Sentinel/Cluster

### Phase 3 — Advanced & Enterprise (+6–12 months)

**Goal**: Enterprise-grade platform with voice/video, multi-agent AI, and bot marketplace.

- Voice/video calls (WebRTC), screen sharing
- SSO (SAML/OIDC), Google/Microsoft/GitHub OAuth
- Advanced E2E: safety numbers, device management, disappearing messages, sealed sender
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
| 05 | [AI Agent Orchestration & Streaming](design/05_AI_Agent_Orchestration_and_Streaming.md) | Streaming protocol, engine architecture (5 subsystems), command router, LLM provider abstraction, tool system, memory/RAG, prompt engineering, privacy |
| 06 | [Phase Roadmap & Milestone Plan](design/06_Phase_Roadmap.md) | Consolidated Phase 1/2/3 goals, week-by-week breakdown, bot catalog rollout, AI implementation sequence, package delivery matrix, infrastructure evolution |

### 6.2 Research Documents

| Document | Description |
|----------|-------------|
| [Frontend Architecture](research/frontend-architecture.md) | Electron + React + Vite integration, virtual scrolling, Zustand patterns, Tailwind theming, offline strategy, performance monitoring |
| [Backend IM & State Machine](research/backend-im-state-machine.md) | Framework comparison (Hono/Fastify/NestJS), WebSocket architecture, message/channel state machines, database design, Redis caching, security |
| [UI Components & Plugin Protocol](research/ui-components-plugin-protocol.md) | Component hierarchy, message rendering, plugin sandbox (iframe/Worker), extension points, Block Kit-style UI, security isolation |
| [Bot Engine & Microservices](research/bot-engine-microservices.md) | Event-driven architecture, Redis Streams → NATS, connection modes, Bot SDK design, task queues (BullMQ), service split boundaries, observability |
| [Security Defense & E2EE](research/security-defense-e2ee-roadmap.md) | Helmet.js/CORS/CSP, Argon2id, JWT best practices, Signal Protocol deep dive (X3DH/Double Ratchet/Sender Key), threat model, GDPR compliance |
| [Base Bot Catalog](research/base-bot-catalog.md) | Platform survey (Slack/Discord/Teams/Telegram), 17 recommended bots across 5 domains, priority matrix, interaction models, implementation strategy |
| [AI Agent Orchestration](research/ai-agent-orchestration.md) | Streaming message design, agent frameworks survey (Vercel AI SDK/LangGraph/Mastra/CrewAI), LLM provider abstraction, context/memory, tool calling, prompt engineering |

### 6.3 Bot SDK Documentation (Multi-Language)

| Language | Document | Package / Module |
|----------|----------|------------------|
| TypeScript / Node.js | [nodejs.md](sdk/nodejs.md) | `@nexus-chat/bot-sdk` (npm) |
| Java | [java.md](sdk/java.md) | `chat.nexus:nexus-bot-sdk` (Maven/Gradle) |
| Python | [python.md](sdk/python.md) | `nexus-bot-sdk` (pip) |
| PHP | [php.md](sdk/php.md) | `nexus-chat/bot-sdk` (Composer) |
| Go | [go.md](sdk/go.md) | `github.com/nexus-chat/bot-sdk-go` |
| Rust | [rust.md](sdk/rust.md) | `nexus-bot-sdk` (crates.io) |

Each SDK doc covers: installation, quick start, connection lifecycle, 9 event types, message/channel API, middleware pipeline, rate limiting, reconnection strategy, slash command registration, bot manifest, error handling, and 3+ complete examples.

### 6.4 Meta Documents

| Document | Description |
|----------|-------------|
| [AI Session Context](ai/context.md) | Record of design decisions and discussion made during the initial architecture session |
| [AGENTS.md](../AGENTS.md) | Project conventions: language, tech stack, code style, Git workflow, branch naming |

---

> **Convention**: All documentation is written in English. Code blocks use TypeScript, and design diagrams use ASCII art. See [AGENTS.md](../AGENTS.md) for full conventions.
