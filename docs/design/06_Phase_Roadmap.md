---
lang: en
---

# 06 — Phase Roadmap & Milestone Plan

> nexus-chat · Slack-like IM application  
> Design date: June 2026 · Status: Draft v1.0  
> Target: SaaS multi-tenant cloud deployment

---

## Table of Contents

1. [Overview & Timeline](#1-overview--timeline)
2. [Phase 1 — MVP Foundation (0–3 months)](#2-phase-1--mvp-foundation-03-months)
3. [Phase 2 — Rich Features & Production Hardening (+3–6 months)](#3-phase-2--rich-features--production-hardening-36-months)
4. [Phase 3 — Advanced & Enterprise (+6–12 months)](#4-phase-3--advanced--enterprise-612-months)
5. [Infrastructure Evolution](#5-infrastructure-evolution)
6. [Bot Catalog Rollout](#6-bot-catalog-rollout)
7. [AI Agent Implementation Sequence](#7-ai-agent-implementation-sequence)
8. [Package Delivery Matrix](#8-package-delivery-matrix)

---

## 1. Overview & Timeline

```
Phase 1 (MVP)           Phase 2 (Production)        Phase 3 (Enterprise)
├───────────────────────┼───────────────────────────┼───────────────────────→
Month 0            Month 3                    Month 6                Month 12
```

| Phase | Duration | Goal | Launch Readiness |
|-------|----------|------|------------------|
| **Phase 1** | Months 0–3 | Usable Slack-like IM with hybrid encryption | Internal alpha, closed beta |
| **Phase 2** | Months 3–6 | Feature-complete IM platform ready for public launch | Public GA launch |
| **Phase 3** | Months 6–12 | Enterprise-grade platform with advanced AI and ecosystem | Enterprise plans |

---

## 2. Phase 1 — MVP Foundation (0–3 months)

### 2.1 Core Goal

Deliver a working Slack-like IM that demonstrates the key differentiator: **per-channel hybrid encryption** (normal = IM + Bot, E2E = IM only).

### 2.2 Feature Deliverables

| Feature Area | Deliverables | Reference Design |
|-------------|-------------|------------------|
| **Project Scaffold** | pnpm monorepo + Turborepo, TypeScript strict mode, ESLint + Prettier, Vitest, CI/CD pipeline | — |
| **Auth** | Email/password registration + login, JWT (access 15 min + refresh 7 days), Argon2id password hashing, token rotation, session management | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Workspace** | Create/join workspace, workspace settings, member invite, role management (owner/admin/member) | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Channels** | Public/private channels, DM conversations, channel creation, archive, member management, per-channel mode toggle (normal/e2e) | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Messages** | Text messages, message state machine (Draft → Sending → Sent → Delivered → Read), cursor-based pagination (UUID v7), edit/delete (soft), emoji reactions | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Rich Content** | Markdown rendering (markdown-it + Shiki for code), emoji picker (emoji-mart), @mention autocomplete | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **DM E2E** | Signal Protocol for 1:1 DMs, X3DH key negotiation, Double Ratchet, client-side encrypt/decrypt, server opaque relay, PreKeyBundle server | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Bot (basic)** | Bot registration + token issuance (`nxbot_v1_xxx`), `/slash` command parse + routing, bot WebSocket connection lifecycle, Redis Streams event bus | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **Gateway** | Hono HTTP server + Socket.IO WebSocket, JWT auth middleware, rate limiting (sliding window), CORS/Helmet.js/CSP, Zod validation, heartbeat (30s) | [02 - Gateway](02_Long_Connection_and_Core_Gateway_Layer.md) |
| **UI Shell** | Single-window Electron layout (sidebar + chat view + detail panel), Zustand stores (auth/workspace/channel/message/presence/signal/ui), react-virtuoso message list, dark/light theme, Tailwind CSS v4 | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Desktop Shell** | Electron window management, system tray, native notifications, auto-update (electron-updater), contextBridge IPC | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Infrastructure** | Monolith deployment (Hono + Socket.IO + Bot Engine in one process), PostgreSQL 16, Redis 7, Pino structured logging, dotenv config | [00 - System Architecture](00_System_High_Level_Architecture.md) |

### 2.3 Base Bots (MVP)

| # | Bot | Category | Key Deliverable |
|---|-----|----------|----------------|
| 1 | **Welcome Bot** | System/Onboarding | Auto-DM new members, `#welcome` channel announcement, onboarding guide |
| 2 | **Help Bot** | System | `/help` command listing, static FAQ, documentation lookup |
| 3 | **Notification Bot** | System | `/announce` to channel and workspace-wide broadcasts |
| 4 | **Reminder Bot** | Productivity | `/remind me <when> <what>`, `/reminders list`, `/reminders cancel` |
| 5 | **Poll Bot** | Productivity | `/poll "Question" "Opt1" "Opt2"...`, real-time reaction-based voting |
| 6 | **Webhook Bot** | Developer | Channel webhook URL generation, JSON → message template |
| 7 | **Kudos Bot** | Culture | `/kudos @user <reason>`, workspace leaderboard |

### 2.4 Packages to Build

| Package | Path | Purpose |
|---------|------|---------|
| `shared` | `packages/shared/` | Shared types, Zod schemas, constants |
| `signal` | `packages/signal/` | Signal Protocol wrapper (@signalapp/libsignal) |
| `bot-sdk` | `packages/bot-sdk/` | Public Bot SDK (TypeScript/Node.js) |
| `ui` | `packages/ui/` | Shared React UI components |
| `server` | `apps/server/` | Monolith backend |
| `web` | `apps/web/` | React SPA frontend |
| `desktop` | `apps/desktop/` | Electron shell |

### 2.5 Week-by-Week Breakdown

| Week | Focus | Key Output |
|------|-------|-----------|
| 1–2 | Project scaffold + Data model | pnpm workspace, Turbo config, ESLint/Prettier, Drizzle ORM schema, DB migrations |
| 3–4 | Auth + Gateway skeleton | Registration/login, JWT, Hono routes, Socket.IO setup, middleware chain |
| 5–6 | Workspace + Channel CRUD | Workspace management, channel create/join/archive, DM creation flow |
| 7–8 | Message pipeline | Send/receive via WS, message state machine, cursor pagination, edit/delete |
| 9–10 | Signal Protocol integration | PreKeyBundle server, X3DH + Double Ratchet, E2E DM flow |
| 11–12 | Bot engine + Base bots (3) | Bot registration, slash command routing, Redis Streams, Welcome/Help/Notification bots |
| 13 | Remaining base bots (4) | Reminder, Poll, Webhook, Kudos bots |
| 14 | Electron shell + Polish | Window management, tray, notifications, dark/light theme, error states |
| 15–16 | Testing + Bug fixing + Closed beta | Integration tests, performance audit, closed beta deployment |

---

## 3. Phase 2 — Rich Features & Production Hardening (+3–6 months)

### 3.1 Core Goal

Feature-complete IM platform with file sharing, search, threads, AI Assistant, and full bot ecosystem — ready for public GA launch.

### 3.2 Feature Deliverables

| Feature Area | Deliverables | Reference Design |
|-------------|-------------|------------------|
| **File & Image** | File upload (S3/R2 presigned URLs), inline image previews, attachment thumbnails, file type validation, virus scanning | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Full-Text Search** | PostgreSQL `tsvector` + GIN index, message search, channel search, user search, date range + user filters | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Threads** | Threaded replies, thread sidebar panel, thread notifications, thread parent preview in main feed | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Online Presence** | Real-time online/offline status, typing indicators, last seen timestamp, away/idle detection | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Read Receipts** | Per-channel read cursors, unread badge counts, "new messages" divider | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Message Enhancements** | Pin/unpin messages, message permalink/copy link, forward message, save for later | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Channel E2E** | Group E2E via Sender Key, key distribution for multi-member channels, member-change key rotation, pending join | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Bot Advanced** | Bot SDK interactive components (buttons, modals, Block Kit), bot permission scopes, bot analytics dashboard | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **Webhook Delivery** | HTTP webhook for low-frequency bots, HMAC-SHA256 signature, retry policy (3 attempts), delivery tracker | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **AI Assistant** | `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft`, `/ai search`, `@ai` mention, streaming message protocol (stream_start → stream_chunk → stream_end), pgvector RAG | [05 - AI Agent](05_AI_Agent_Orchestration_and_Streaming.md) |
| **Base Bots (Phase 2)** | Todo Bot, GitHub/GitLab Bot, CI/CD Bot, Standup Bot, Celebration Bot, Feedback Bot | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **Electron Packaging** | Cross-platform packaging (macOS .dmg, Windows .exe/.msi, Linux .AppImage/.deb), code signing, auto-update via GitHub Releases | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Offline Support** | Offline message queue with exponential retry, IndexedDB message cache, offline indicator, reconnect UI | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Performance** | Web Vitals monitoring, React Profiler in CI, memory window control (200 messages in-memory), image lazy loading, code splitting | [01 - Client Shell](01_Client_Shell_and_UI_Rendering_Layer.md) |
| **Infrastructure** | Multi-instance deployment, Redis Sentinel/Cluster, database read replicas, load testing | [00 - System Architecture](00_System_High_Level_Architecture.md) |

### 3.3 AI Agent Milestones (Phase 2)

| Milestone | Week | Deliverables |
|-----------|------|-------------|
| **M1: Provider Layer** | 1–2 | `LLMProvider` interface, `OpenAIProvider`, `AnthropicProvider`, `ProviderRegistry`, `CostTracker` |
| **M2: Streaming Protocol** | 3–4 | `message.stream_start/chunk/end/cancel` events, `ChunkBatcher` (100ms), `StreamManager`, `StreamingMarkdownRenderer` |
| **M3: Basic Commands** | 5–6 | `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft` — single agent with system prompt |
| **M4: Tool Integration** | 7–8 | `ToolRegistry`, SDK API tools (searchChannelHistory, getChannelInfo, listChannelMembers, sendMessage, fetchWebPage), safety classification (GREEN/YELLOW/RED), confirmation UI |
| **M5: Memory Management** | 9–10 | `ConversationWindow` (sliding, 50 msg / 24K tokens), `ConversationSummarizer`, `ContextCache` (Redis) |
| **M6: RAG (pgvector)** | 11–12 | pgvector extension, message embedding pipeline, `BatchEmbeddingGenerator`, semantic search, hybrid search |
| **M7: UI Polish + Privacy** | 13–14 | Typewriter animation, progressive markdown, cancel button, tool call indicators, workspace AI settings, GDPR compliance |

### 3.4 Week-by-Week Breakdown

| Weeks | Focus Area | Key Deliverables |
|-------|-----------|-----------------|
| 1–2 | File upload infrastructure | S3 presigned URLs, upload service, image processing pipeline |
| 3–4 | Full-text search | PostgreSQL tsvector, search UI, filters |
| 5–6 | Threads | Thread model, thread UI (sidebar panel), thread notifications |
| 7–8 | Online presence + Read receipts | Presence system, typing indicators, read cursors, unread badges |
| 9–12 | AI Agent Engine (M1–M4) | Provider layer, streaming protocol, basic commands, tool integration |
| 13–14 | Channel E2E + AI memory | Sender Key, pgvector RAG, memory management |
| 15–16 | AI UI (M6–M7) | Progressive rendering, workspace settings, privacy compliance |
| 17–18 | Bot advanced features | Interactive components, webhook delivery, Phase 2 base bots |
| 19–20 | Electron packaging | Cross-platform build, code signing, auto-update |
| 21–22 | Offline + Performance | Offline queue, IndexedDB cache, Web Vitals, profiler |
| 23–24 | Testing + QA | End-to-end tests, load testing, security audit, documentation |
| 25–26 | Public GA launch | Production deployment, monitoring, launch announcement |

---

## 4. Phase 3 — Advanced & Enterprise (+6–12 months)

### 4.1 Core Goal

Enterprise-grade platform with voice/video, multi-agent AI, SSO, and a public bot marketplace.

### 4.2 Feature Deliverables

| Feature Area | Deliverables | Reference Design |
|-------------|-------------|------------------|
| **Voice & Video** | 1:1 and group voice/video calls (WebRTC), screen sharing, call history, raise hand, push-to-talk | — |
| **SSO & OAuth** | SAML/OIDC integration, Google/Microsoft/GitHub OAuth login, directory sync (SCIM), enterprise identity provider | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Advanced E2E** | Verified safety numbers (QR code compare), device management (list/revoke), disappearing messages, sealed sender, E2E audit log | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Multi-Device Sync** | Per-device PreKeyBundle management, multi-device session relay, device enrollment/revocation | [03 - Business Logic](03_Business_Logic_and_Persistence_Backend.md) |
| **Enterprise Admin** | Admin dashboard, workspace analytics, audit logs, data retention policies, compliance exports (GDPR/CCPA), custom data residency regions | — |
| **Enterprise Bots** | AutoMod (content filtering, spam detection, rate limiting), Status Bot (service health monitoring), Scheduler Bot (meeting scheduling), Meeting Notes Bot | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **Multi-Agent AI** | LangGraph supervisor-worker + debate patterns, task decomposition, agent handoff, `/ai research`, `/ai code` | [05 - AI Agent](05_AI_Agent_Orchestration_and_Streaming.md) |
| **AI Self-Hosted** | Ollama + vLLM integration, enterprise on-premise LLM deployment guide | [05 - AI Agent](05_AI_Agent_Orchestration_and_Streaming.md) |
| **Bot Marketplace** | Public marketplace listing, OAuth2 install flow, bot versioning, review/rating system, paid bots with billing, sandbox testing environment | [04 - Bot Engine](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md) |
| **Custom Agents** | Agent builder UI for workspace admins, community-contributed agent marketplace, user-defined prompts and tools | [05 - AI Agent](05_AI_Agent_Orchestration_and_Streaming.md) |
| **Microservices Split** | Gateway / Message / Bot Engine / File services separated, NATS JetStream event bus, gRPC for sync calls, database-per-service | [00 - System Architecture](00_System_High_Level_Architecture.md) |
| **Observability** | Distributed tracing (OpenTelemetry + Jaeger), centralized metrics (Prometheus + Grafana), alerting, SLO dashboards | — |

### 4.3 AI Agent Milestones (Phase 3)

| Milestone | Deliverables | Technology |
|-----------|-------------|------------|
| **M8: Multi-Agent Orchestration** | LangGraph supervisor-worker, debate pattern, task decomposition, agent handoff | LangGraph (Python microservice via TypeScript API) |
| **M9: Advanced Tools** | Code sandbox (E2B/gVisor), web fetch with domain allowlisting, MCP server for tool exposure | E2B, MCP protocol |
| **M10: Self-Hosted LLM** | Ollama provider, vLLM integration, enterprise on-premise guide | Ollama, vLLM |
| **M11: AI Analytics** | Usage dashboards, cost allocation per workspace/user, prompt effectiveness metrics, A/B testing | Prometheus + Grafana |
| **M12: Meeting AI** | Voice/video meeting transcription (Whisper), meeting summarization, action item extraction | Whisper API + LLM |
| **M13: Custom Agents** | Agent builder UI, community agent marketplace, user-defined tools and prompts | Plugin protocol |

---

## 5. Infrastructure Evolution

```
Phase 1: Monolith                    Phase 2: Multi-Instance              Phase 3: Microservices

┌────────────────────┐              ┌────────────────────┐              ┌────────────────────┐
│  Single Process:    │              │  App Node × N:      │              │  Gateway Service   │
│  Hono + Socket.IO   │              │  ├─ Hono REST       │              │  (stateless, N×)   │
│  + Bot Engine       │              │  ├─ Socket.IO       │              ├────────────────────┤
│  + AI Agent Engine  │              │  ├─ Bot Engine      │              │  Message Service   │
└────────┬───────────┘              │  └─ AI Engine       │              │  (stateful, N×)    │
         │                           └────────┬───────────┘              ├────────────────────┤
    ┌────┴────┐                           ┌───┴────┐                    │  Bot Engine        │
    │   PG    │                           │  Redis │                    │  (NATS consumer)   │
    │  Redis  │                           │Cluster │                    ├────────────────────┤
    └─────────┘                           └───┬────┘                    │  AI Agent Engine   │
    Event bus:                               │                         │  (NATS consumer)   │
    Redis Streams                     ┌──────┴──────┐                   ├────────────────────┤
                                      │    PG       │                   │  File Service      │
                                      │  Primary +  │                   │  (stateless, N×)   │
                                      │  Read Repl. │                   └────────┬───────────┘
                                      └─────────────┘                            │
                                      Event bus:                            ┌────┴──────┐
                                      Redis Streams → NATS                  │   NATS    │
                                                                            │ JetStream │
                                                                            └────┬──────┘
                                                                                 │
                                                                          ┌──────┴──────┐
                                                                          │  PG per svc │
                                                                          │  Redis Cluster│
                                                                          └─────────────┘
```

### Key Infrastructure Milestones

| Component | Phase 1 | Phase 2 | Phase 3 |
|-----------|---------|---------|---------|
| **HTTP Server** | Single Hono instance | Multiple Hono instances behind LB | Dedicated Gateway service (stateless, N×) |
| **WebSocket** | Single Socket.IO node | Socket.IO + Redis Adapter (multi-node) | Dedicated Message Service |
| **Database** | Single PostgreSQL | Primary + read replicas | Database-per-service |
| **Cache** | Single Redis | Redis Sentinel / Cluster | Redis Cluster per service domain |
| **Event Bus** | Redis Streams | Redis Streams → NATS migration start | NATS JetStream |
| **Service Mesh** | N/A | N/A | gRPC for sync, NATS for async |
| **Observability** | Pino logs | Pino + Prometheus metrics | OpenTelemetry + Jaeger + Grafana |
| **CI/CD** | GitHub Actions | GitHub Actions + Docker | K8s + ArgoCD / Flux |

---

## 6. Bot Catalog Rollout

### Phase 1 Bots (MVP — 7 bots)

| # | Bot | `@handle` | Storage Tier | i18n Priority |
|---|-----|-----------|-------------|---------------|
| 1 | Welcome Bot | `@WelcomeBot` | DB (templates, channel mappings) | High |
| 2 | Help Bot | `@HelpBot` | DB (FAQ, doc index) | High |
| 3 | Notification Bot | `@NotifyBot` | DB (announcement history) | High |
| 4 | Reminder Bot | `@RemindBot` | DB (active reminders) | High |
| 5 | Poll Bot | `@PollBot` | DB (polls, votes) | Medium |
| 6 | Webhook Bot | `@WebhookBot` | DB (URLs, templates, logs) | Low |
| 7 | Kudos Bot | `@KudosBot` | DB (records, leaderboard) | Medium |

### Phase 2 Bots (Engagement — 7 bots)

| # | Bot | `@handle` | Storage Tier | i18n Priority |
|---|-----|-----------|-------------|---------------|
| 8 | Todo Bot | `@TodoBot` | DB (tasks, due dates) | Medium |
| 9 | GitHub Bot | `@GitBot` | DB (repo subscriptions) | Low |
| 10 | GitLab Bot | `@GitLabBot` | DB (repo subscriptions) | Low |
| 11 | CI/CD Bot | `@CIBot` | DB (deploy history) | Low |
| 12 | Standup Bot | `@StandupBot` | DB (templates, responses) | Medium |
| 13 | Celebration Bot | `@CelebrateBot` | DB (birthdays, anniversaries) | Medium |
| 14 | Feedback Bot | `@FeedbackBot` | DB (surveys, responses) | Medium |
| — | **AI Assistant Bot** | `@AI` | Stateless per request | N/A (language-agnostic via LLM) |

### Phase 3 Bots (Advanced — 5 bots)

| # | Bot | `@handle` | Storage Tier | i18n Priority |
|---|-----|-----------|-------------|---------------|
| 15 | Status Bot | `@StatusBot` | DB (service subscriptions) | Low |
| 16 | Scheduler Bot | `@SchedulerBot` | DB (meeting proposals, availability) | Medium |
| 17 | Meeting Notes Bot | `@MeetingBot` | DB (transcripts, summaries) | Medium |
| 18 | AutoMod Bot | `@AutoMod` | DB (rules, violation log) | High |
| — | Bot Marketplace | — | — | — |

### Bot Implementation Strategy

| Classification | Count | Owner | Development Model |
|---------------|-------|-------|-------------------|
| **First-party** (bundled) | 11 | Nexus Chat core team | Developed in monorepo `packages/bots/`, shipped with platform |
| **Official seeded** (third-party) | 6 | Nexus Chat team using public SDK | Separate repos, demonstrate SDK capabilities, community templates |

---

## 7. AI Agent Implementation Sequence

```
Phase 2 AI (12 weeks)                         Phase 3 AI (on-going)

Week 1-2:   M1 Provider Layer                 M8: Multi-Agent (LangGraph)
  └─ packages/ai-bot/ with Vercel AI SDK        └─ Supervisor-worker pattern
  └─ OpenAIProvider + AnthropicProvider          └─ Debate/collaboration pattern
  └─ ProviderRegistry + CostTracker              └─ Task decomposition

Week 3-4:   M2 Streaming Protocol              M9: Advanced Tools
  └─ StreamingEvents in packages/shared/         └─ Code sandbox (E2B/gVisor)
  └─ ChunkBatcher (100ms flush)                  └─ Web fetch domain allowlisting
  └─ StreamManager + Socket.IO bridge            └─ MCP server for tool exposure
  └─ Client StreamingMarkdownRenderer

Week 5-6:   M3 Basic Commands                 M10: Self-Hosted LLM
  └─ AgentDefinition for ask/summarize/...       └─ Ollama provider
  └─ AiCommandRouter (slash + @ai mention)       └─ vLLM integration
  └─ System prompt template substitution         └─ Enterprise on-prem guide
  └─ Simple generation loop (no tools)

Week 7-8:   M4 Tool Integration               M11: AI Analytics
  └─ ToolRegistry + NEXUS_CHAT_TOOLS             └─ Usage dashboards per workspace
  └─ Bot SDK API client for tools                └─ Cost allocation
  └─ Safety classification (GREEN/YELLOW/RED)   └─ Prompt effectiveness metrics
  └─ Interactive confirmation (Block Kit)

Week 9-10:  M5 Memory Management              M12: Meeting AI
  └─ ConversationWindow (sliding 50 msg)         └─ Whisper transcription
  └─ ConversationSummarizer (cascading)          └─ Meeting summarization
  └─ ContextCache (Redis TTLs)                   └─ Action item extraction

Week 11-12: M6 RAG + M7 Polish                M13: Custom Agents
  └─ pgvector extension + embedding pipeline     └─ Agent builder UI
  └─ BatchEmbeddingGenerator                     └─ Community agent marketplace
  └─ Semantic search + hybrid                    └─ User-defined prompts/tools
  └─ Typewriter animation, scroll lock
  └─ Workspace AI settings, GDPR compliance
```

### Technology Stack by AI Phase

| Component | Phase 2 | Phase 3 (Consideration) |
|-----------|---------|------------------------|
| **Agent Framework** | Vercel AI SDK (streaming-first, TypeScript) | LangGraph (multi-agent) |
| **Tool Standard** | OpenAI function calling format | MCP (Model Context Protocol) |
| **Vector Store** | pgvector (in PostgreSQL) | Pinecone / Qdrant (>10M vectors) |
| **Primary Models** | GPT-4o, Claude 4 Sonnet | Self-hosted Ollama/vLLM |
| **Model Gateway** | Direct provider API | OpenRouter (unified + fallback) |
| **Embedding Model** | OpenAI text-embedding-3-small | Self-hosted BGE-M3 |
| **Stream Transport** | WebSocket (Socket.IO) | WebSocket + Durable Sessions |
| **Observability** | Pino + Prometheus | OpenTelemetry (LangSmith/Signoz) |
| **Code Sandbox** | N/A | E2B (gVisor-isolated) |
| **Memory** | Sliding window + Redis summaries | LangGraph long-term memory store |

---

## 8. Package Delivery Matrix

| Package | Phase 1 | Phase 2 | Phase 3 |
|---------|---------|---------|---------|
| `packages/shared` | Types, Zod schemas, constants | + Streaming events, AI types, MCP schemas | + Enterprise types |
| `packages/signal` | X3DH + Double Ratchet | + Sender Key, group E2E | + Sealed sender, device mgmt |
| `packages/bot-sdk` | Core SDK (WS + events + messages) | + Interactive components, webhook, KV store, DB access, localization | + AI tool access, marketplace hooks |
| `packages/ui` | Button, Input, Modal, Avatar, Layout | + StreamRenderer, ToolCallCard, ConfirmationDialog | + AgentBuilder, AdminDashboard |
| `packages/ai-bot` | — | ProviderLayer, StreamManager, AgentRouter, Tools, Memory | + MultiAgent, CodeSandbox, SelfHosted |
| `apps/server` | Auth, Workspace, Channel, Message, Signal, Bot, Presence | + File, Search, Thread, ReadReceipt, Webhook | + SSO, Enterprise, Analytics |
| `apps/web` | AuthPage, ChatPage, SettingsPage | + FilePreview, SearchPage, ThreadPanel, PresenceIndicator, StreamRenderer | + VoiceCall, AdminConsole |
| `apps/desktop` | Window, Tray, Notifications, Updater | + Offline cache, protocol links | + Screen share, native call controls |

---

> **Related Documents**:
> - [00 — System High-Level Architecture](00_System_High_Level_Architecture.md)
> - [01 — Client Shell & UI Rendering](01_Client_Shell_and_UI_Rendering_Layer.md)
> - [02 — Long Connection & Core Gateway](02_Long_Connection_and_Core_Gateway_Layer.md)
> - [03 — Business Logic & Persistence](03_Business_Logic_and_Persistence_Backend.md)
> - [04 — Async Bot Engine & Event Dispatch](04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)
> - [05 — AI Agent Orchestration & Streaming](05_AI_Agent_Orchestration_and_Streaming.md)
> - [Base Bot Catalog Research](../research/base-bot-catalog.md)
> - [AI Agent Orchestration Research](../research/ai-agent-orchestration.md)
