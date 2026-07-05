<p align="center">
  <img src="https://img.shields.io/badge/phase-1%20complete-blue" alt="Phase">
  <img src="https://img.shields.io/badge/coverage-99.8%25-brightgreen" alt="Coverage">
  <img src="https://img.shields.io/badge/tests-72%20passed-green" alt="Tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9.15-orange" alt="pnpm">
</p>

# Nexus Chat

A Slack-like workspace chat system with hybrid encryption: normal channels with bots and server-side workflows, or end-to-end encrypted DMs via the Signal Protocol. Built with TypeScript, React, Electron, Hono, and Socket.IO.

Phase 1 delivers a complete monorepo with a web client, Electron desktop shell, TUI/CLI, backend gateway, message state machine, bot engine, first-party bots, and E2EE service boundaries — all backed by a test suite exceeding 99% statement coverage.

---

## Architecture

```
Clients (Electron / Web / TUI)
        |  REST + Socket.IO
        v
Hono API + WebSocket Gateway
        |
        +-- Auth, Workspace, Channel, DM
        +-- Message Service & State Machine
        +-- Attachment Service Boundary
        +-- Signal/E2EE Service Boundary
        +-- Bot Engine & Event Dispatch
        |
        v
In-memory stores (Phase 1)  /  PostgreSQL + Redis (schema ready)
```

| Mode | Behavior |
| --- | --- |
| Normal | Plaintext messages, bot participation, reactions, edits, deletes, read receipts, future server-side search. |
| E2EE | Ciphertext-only messages, no bot access, read-once/TTL tombstones, no server-side plaintext processing. |

---

## Quick Start

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Open the web client at `http://localhost:5173`. See [QUICKSTART.md](QUICKSTART.md) for a step-by-step guide.

**Seed credentials** (for the PostgreSQL seed script; runtime also supports direct registration):

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

---

## Repository Structure

```
nexus-chat/
├── apps/
│   ├── server/        Hono REST API, Socket.IO gateway, domain services
│   ├── web/           React 19 + Vite chat client
│   ├── desktop/       Electron shell with secure preload boundary
│   └── tui/           Commander + Ink CLI/TUI client
├── packages/
│   ├── shared/        Zod schemas, API envelopes, protocol contracts
│   ├── signal/        Local Signal-style facade
│   ├── bot-sdk/       TypeScript/Node.js bot SDK
│   ├── ui/            Shared React UI primitives
│   └── bots/           First-party bots (help, notification, welcome)
├── docs/              Architecture, research, task plans, beta docs
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (strict) |
| Monorepo | pnpm workspaces + Turborepo |
| Backend | Hono, Socket.IO, Zod, Drizzle ORM schema tooling |
| Auth | Argon2id, JWT RS256, refresh-token rotation |
| Frontend | React 19, Vite, Zustand, React Virtuoso, Tailwind CSS |
| Desktop | Electron |
| TUI | Commander, Ink |
| Bots | Dedicated `/bots` WS namespace, Node.js SDK, event subscriptions |
| E2EE | Signal-style pre-key/session services, ciphertext-only channels |
| Data | PostgreSQL 16 schema/migrations, Redis 7-ready |
| Observability | Pino, Prometheus metrics, audit events |
| Testing | Vitest with V8 coverage |

---

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start all dev tasks through Turborepo |
| `pnpm build` | Build all apps and packages |
| `pnpm test` | Run all test suites |
| `pnpm coverage` | Vitest with V8 coverage |
| `pnpm lint` | ESLint across workspace |
| `pnpm typecheck` | TypeScript type-checking |
| `pnpm format` | Prettier formatting |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:seed` | Seed local database |
| `pnpm smoke:tui` | TUI smoke tests |

## Validation Suite

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm coverage && pnpm build
```

**Coverage**: &gt;99% statements, &gt;90% branches, &gt;99% functions, &gt;99% lines across 17 test files and 72 tests.

---

## Slash Commands & Bots

Messages starting with `/` are routed as bot commands over WebSocket. `/help` is handled inline by the server without requiring a connected bot client.

**First-party bots:**

| Bot | Command | Behavior |
| --- | --- | --- |
| HelpBot | `/help` | Lists available commands |
| NotificationBot | `/announce <text>` | Posts workspace announcements |
| WelcomeBot | *(member_added event)* | Sends onboarding message |

**Bot SDK example:**

```ts
const bot = new NexusBotClient({ baseUrl, token, manifest });
bot.onCommand("/help", async (event) => {
  await bot.sendMessage({
    workspaceId: event.workspaceId,
    channelId: event.channelId!,
    clientMsgId: `bot-${Date.now()}`,
    content: { type: "text", text: "Available commands: /help", attachments: [] }
  });
});
bot.connect();
```

Bots join normal channels only. E2EE channels reject bots by design.

---

## TUI/CLI

```bash
pnpm --filter @nexus-chat/tui dev -- login -e ada@example.com -p 'Password12345!'
pnpm --filter @nexus-chat/tui dev -- whoami
pnpm --filter @nexus-chat/tui dev -- workspaces
pnpm --filter @nexus-chat/tui dev -- channels -w <workspace-id>
pnpm --filter @nexus-chat/tui dev -- send -w <workspace-id> -c <channel-id> -m '/help'
pnpm --filter @nexus-chat/tui dev -- bot-smoke
pnpm --filter @nexus-chat/tui dev -- e2e-smoke
```

---

## API Overview

Base path: `/api/v1`. Authenticated routes require `Authorization: Bearer <token>`.

| Area | Key Routes |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Workspaces | `POST /workspaces`, `GET /workspaces`, `GET/PATCH /workspaces/:id`, members, ownership transfer |
| Channels | Workspace channel CRUD, channel members, archive, delete, `POST /dms` |
| Messages | Send, list, edit, delete, react, forward, save |
| Attachments | Upload sessions, completion, file lookup, download URLs |
| Signal/E2EE | Pre-key bundles, one-time pre-key consumption, session storage |
| Bots | Install, channel memberships, subscriptions, bot messages, command invocation |
| Ops | `GET /healthz`, `GET /metrics` |

WebSocket events: `message.send`, `message.ack`, `typing.start`, `typing.stop`, `presence.update`, `bot.command.invoke` (client); `message.created`, `message.updated`, `message.deleted`, `message.reaction`, `message.read`, `presence.updated`, `typing.updated` (server).

---

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/WS server port |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS origin |
| `DATABASE_URL` | `postgres://nexus:nexus@localhost:5432/nexus_chat` | PostgreSQL |
| `REDIS_URL` | `redis://localhost:6379` | Redis |
| `SESSION_STORE` | `memory` | `memory` or `redis` |
| `VITE_API_BASE` | `http://localhost:4000` | Web client API base |

---

## Known Limitations

Read the full list at [docs/known-limitations.md](docs/known-limitations.md).

- Runtime domain services use in-memory stores by default (PostgreSQL schema and migrations are present).
- E2EE is single-device; group E2EE and safety numbers are planned for later phases.
- Bots cannot participate in E2EE channels.
- Attachment upload UX and Electron production signing are deferred.

---

## Documentation

- [QUICKSTART.md](QUICKSTART.md) &mdash; step-by-step local setup
- [docs/design/](docs/design/) &mdash; architecture and design documents
- [docs/research/](docs/research/) &mdash; technical research and surveys
- [docs/tasks/](docs/tasks/) &mdash; Phase 1 implementation task breakdowns
- [docs/sdk/](docs/sdk/) &mdash; Bot SDK documentation
- [docs/beta-checklist.md](docs/beta-checklist.md) &mdash; closed beta readiness
- [docs/backup-restore.md](docs/backup-restore.md) &mdash; backup and recovery
- [docs/ai/context.md](docs/ai/context.md) &mdash; AI session context document

## Contributing

See `AGENTS.md` for conventions. Before submitting a PR, run: `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## License

MIT &mdash; see [LICENSE](LICENSE).
