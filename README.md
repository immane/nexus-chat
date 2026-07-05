# Nexus Chat

[中文 README](README.zh-CN.md) | [Quick Start](QUICKSTART.md) | [中文快速开始](QUICKSTART.zh-CN.md)

Nexus Chat is a Phase 1 Slack-like workspace chat system built with TypeScript, React, Electron, Hono, Socket.IO, PostgreSQL schema tooling, Redis-ready infrastructure, and a first-party bot framework. It demonstrates a hybrid communication model: normal plaintext channels support bots, server-side workflows, message history, and future search; end-to-end encrypted conversations are isolated from bot access and server-side plaintext processing.

The repository is a pnpm workspace monorepo designed for local development, architecture experimentation, and closed-beta preparation. Phase 1 is complete and includes a web client, Electron shell, TUI/CLI, backend gateway, message state machine, bot engine, first-party bots, Signal-style E2EE service boundaries, observability, and a comprehensive test suite.

## Highlights

- Workspace-scoped chat with public/private channels and 1:1 DMs.
- Normal-mode messages with bot support, message history, reactions, edits, deletes, forwarding, saved messages, and read receipts.
- E2EE-mode message boundaries for ciphertext-only channels and read-once/TTL tombstones.
- Slash command flow over WebSocket, including inline `/help` handling.
- Dedicated bot engine with installation, channel membership, event subscriptions, queue polling, and bot-authenticated message sending.
- First-party bots: HelpBot, WelcomeBot, and NotificationBot.
- Node.js bot SDK with middleware, command handlers, event handlers, reconnect behavior, and REST helpers.
- React/Vite web client with demo mode, real-server mode, channel sidebar, member/settings panels, virtualized message list, slash command suggestions, and E2EE state UI.
- Electron shell with secure BrowserWindow defaults, preload IPC boundary, tray integration, notifications, clipboard/window APIs, and updater placeholder.
- TUI/CLI for login, workspace/channel operations, sending messages, bot smoke tests, and E2EE smoke tests.
- Shared contracts package with Zod schemas for API, WebSocket, bot, message, attachment, workspace, channel, auth, and Signal boundaries.
- Security baseline: Argon2id password hashing, RS256 JWTs, refresh-token rotation, CORS, security headers, rate limiting, structured logs, Prometheus metrics, and audit events.
- High test coverage: current suite is above 99% statement coverage and above 90% branch coverage.

## Current Status

Phase 1 is implemented and validated locally.

| Area | Status |
| --- | --- |
| Monorepo scaffold | Complete |
| Shared contracts and runtime schemas | Complete |
| Database schema and migration tooling | Complete |
| Auth/session/security baseline | Complete |
| REST gateway and WebSocket gateway | Complete |
| Workspace/channel/DM services | Complete |
| Message service and state machine | Complete |
| Attachment service foundation | Complete |
| Signal/E2EE service boundary | Complete |
| Bot engine and slash commands | Complete |
| Node.js bot SDK | Complete |
| First-party base bots | Complete |
| React web shell | Complete |
| Electron shell | Complete |
| Observability and audit logs | Complete |
| Local dev, CI, and smoke scripts | Complete |
| TUI/CLI | Complete |

Important Phase 1 caveat: the PostgreSQL schema, migrations, and seed script are present, but the runtime domain services currently use in-memory stores for local development. Redis is available for infrastructure parity and can be used for refresh sessions via `SESSION_STORE=redis`. See [Known Limitations](docs/known-limitations.md) before treating this as production-ready.

## Screenshots

The repository includes local development screenshots in some working trees, but image assets are ignored by default to keep the Git history lean. Add curated screenshots under a tracked docs asset directory if you want them displayed here.

## Architecture

```text
Electron / Web / TUI Clients
        |
        | REST + Socket.IO
        v
Hono HTTP API + WebSocket Gateway
        |
        +--> Auth, Workspace, Channel, DM Services
        +--> Message Service and State Machine
        +--> Attachment Service Boundary
        +--> Signal/E2EE Service Boundary
        +--> Bot Engine and Event Dispatch
        |
        v
In-memory Phase 1 runtime stores
PostgreSQL schema/migrations + Redis-ready infrastructure
```

Normal channels allow bot events and bot-authored messages. E2EE channels only accept ciphertext message content and explicitly reject bot participation.

## Monorepo Layout

```text
nexus-chat/
├── apps/
│   ├── server/       Hono REST API, Socket.IO gateway, domain services
│   ├── web/          React 19 + Vite chat client
│   ├── desktop/      Electron shell and secure preload boundary
│   └── tui/          Commander + Ink CLI/TUI client
├── packages/
│   ├── shared/       Zod schemas, API envelopes, protocol contracts
│   ├── signal/       Local Signal-style facade used by clients/tests
│   ├── bot-sdk/      TypeScript/Node.js bot SDK
│   ├── ui/           Shared React UI primitives
│   └── bots/
│       ├── help/     HelpBot for `/help`
│       ├── welcome/  WelcomeBot for member onboarding events
│       └── notification/ NotificationBot for announcement workflows
├── docs/             Architecture, research, task plans, beta docs
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

## Tech Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript strict mode |
| Monorepo | pnpm workspaces, Turborepo |
| Backend | Hono, Socket.IO, Zod, Drizzle schema tooling |
| Auth | Argon2id, JWT RS256, refresh-token rotation |
| Data infrastructure | PostgreSQL 16 schema/migrations, Redis 7-ready sessions/cache |
| Frontend | React 19, Vite, Zustand, React Virtuoso, Tailwind CSS |
| Desktop | Electron |
| TUI/CLI | Commander, Ink |
| Bot framework | Dedicated `/bots` namespace, Bot SDK, event subscriptions |
| E2EE boundary | Signal-style pre-key/session services and ciphertext-only channels |
| Observability | Pino logs, Prometheus metrics, audit events |
| Testing | Vitest with V8 coverage |

## Prerequisites

- Node.js 22 or newer.
- pnpm 9.15.x. The repository declares `packageManager: pnpm@9.15.0`.
- Docker Desktop or Docker Engine, recommended for PostgreSQL and Redis.
- macOS, Linux, or Windows with a shell capable of running pnpm scripts.

## Quick Start

For the shortest path, see [QUICKSTART.md](QUICKSTART.md).

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Default local URLs:

| Service | URL |
| --- | --- |
| Server API | `http://localhost:4000` |
| Health check | `http://localhost:4000/healthz` |
| Metrics | `http://localhost:4000/metrics` |
| Web client | `http://localhost:5173` |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

Seed credentials for the PostgreSQL seed script:

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

Because Phase 1 runtime services use in-memory stores by default, you can also register users directly in the web app or through the API during a dev session.

## Development Workflow

Install dependencies:

```bash
pnpm install
```

Start infrastructure:

```bash
docker compose up -d
```

Start all persistent dev tasks:

```bash
pnpm dev
```

Run individual apps:

```bash
pnpm --filter @nexus-chat/server dev
pnpm --filter @nexus-chat/web dev
pnpm --filter @nexus-chat/desktop dev
pnpm --filter @nexus-chat/tui dev -- --help
```

Stop infrastructure:

```bash
docker compose down
```

Reset PostgreSQL volume if you need a clean local database:

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

## Scripts

| Script | Description |
| --- | --- |
| `pnpm dev` | Start all package/app dev tasks through Turborepo. |
| `pnpm build` | Build all apps and packages. |
| `pnpm test` | Run all package/app test suites. |
| `pnpm coverage` | Run Vitest with V8 coverage across the workspace. |
| `pnpm lint` | Run ESLint across the workspace. |
| `pnpm typecheck` | Run TypeScript type-checking across the workspace. |
| `pnpm format` | Format files with Prettier. |
| `pnpm format:check` | Check formatting without writing changes. |
| `pnpm db:generate` | Generate Drizzle migrations from the server schema. |
| `pnpm db:migrate` | Apply Drizzle migrations. |
| `pnpm db:seed` | Seed PostgreSQL with local sample data. |
| `pnpm smoke:tui` | Run TUI smoke tests for login, bot command, and E2EE flow. |

## Testing And Coverage

Run the full validation suite:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
pnpm build
```

Current coverage after the Phase 1 test pass:

| Metric | Coverage |
| --- | --- |
| Statements | 99%+ |
| Lines | 99%+ |
| Functions | 99%+ |
| Branches | 90%+ |

The suite covers shared contracts, server domain services, HTTP routes, WebSocket gateway behavior, bot SDK dispatch/reconnect flows, first-party bots, Signal facade behavior, web stores/components, Electron security config, and TUI commands.

## API Overview

The HTTP API is mounted under `/api/v1`. All protected routes use `Authorization: Bearer <accessToken>`.

| Area | Routes |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| Workspaces | `POST /workspaces`, `GET /workspaces`, `GET/PATCH /workspaces/:id`, member management, ownership transfer |
| Channels and DMs | Workspace channel CRUD, channel members, archive/delete, `POST /dms` |
| Messages | Send, list, edit, delete, react, forward, save |
| Attachments | Upload sessions, completion, metadata lookup, download URL creation |
| Signal/E2EE | Pre-key bundles, one-time pre-key consumption, session storage |
| Bots | Install, add/remove from channels, subscriptions, bot messages, command invocation |
| Ops | `GET /healthz`, `GET /metrics` |

WebSocket client events include `message.send`, `message.ack`, `typing.start`, `typing.stop`, `presence.update`, and `bot.command.invoke`. Server events include `message.created`, `message.updated`, `message.deleted`, `message.reaction`, `message.read`, `presence.updated`, `typing.updated`, and bot responses.

## Bot Framework

Bots are installed with a manifest and receive an opaque token. A bot can subscribe to events, join normal channels, and send messages when it has `messages:write` scope. Bots are blocked from E2EE channels.

Example manifest:

```ts
const manifest = {
  id: "bot-help",
  name: "HelpBot",
  description: "Shows available commands.",
  commands: [{ name: "/help", description: "Show command help." }],
  scopes: ["commands:handle", "messages:write"]
};
```

The Node.js SDK exposes:

```ts
bot.onCommand("/help", async (event) => {});
bot.onEvent("message.created", async (event) => {});
bot.use(async (event, next) => { await next(); });
await bot.sendMessage({ workspaceId, channelId, clientMsgId, content });
```

See [docs/sdk/nodejs.md](docs/sdk/nodejs.md) and `packages/bot-sdk` for details.

## E2EE Model

Nexus Chat uses a hybrid model.

| Mode | Behavior |
| --- | --- |
| Normal channels | Plaintext server-side message content, bot access, future server-side search, full workflow support. |
| E2EE channels/DMs | Ciphertext-only message content, no bot access, read-once/TTL tombstones, no server-side plaintext processing. |

Phase 1 provides the service boundary and local Signal-style test flows. Group E2EE, safety numbers, multi-device support, and full production key management are planned for later phases.

## TUI/CLI

Run the CLI in development mode:

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

Common commands:

```bash
pnpm --filter @nexus-chat/tui dev -- login -e ada@example.com -p 'Password12345!'
pnpm --filter @nexus-chat/tui dev -- whoami
pnpm --filter @nexus-chat/tui dev -- workspaces
pnpm --filter @nexus-chat/tui dev -- channels -w <workspace-id>
pnpm --filter @nexus-chat/tui dev -- send -w <workspace-id> -c <channel-id> -m '/help'
pnpm --filter @nexus-chat/tui dev -- bot-smoke
pnpm --filter @nexus-chat/tui dev -- e2e-smoke
```

The CLI stores local access tokens in `.env.tui`, which is intentionally ignored by Git.

## Configuration

Copy `.env.example` to `.env` and adjust as needed.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP/WebSocket server port. |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS origin for the web client. |
| `DATABASE_URL` | local PostgreSQL URL | Drizzle migration and seed database. |
| `REDIS_URL` | `redis://localhost:6379` | Redis URL for Redis-backed sessions/future queue/cache usage. |
| `SESSION_STORE` | `memory` | Refresh session backend. Use `redis` to exercise Redis session storage. |
| `JWT_ISSUER` | `nexus-chat` | JWT issuer. |
| `JWT_AUDIENCE` | `nexus-chat-clients` | JWT audience. |
| `JWT_PRIVATE_KEY_PEM` | empty | Optional RS256 private key. Local keypair is generated when empty. |
| `JWT_PUBLIC_KEY_PEM` | empty | Optional RS256 public key. Local keypair is generated when empty. |
| `JWT_KID` | `local-dev` | JWT key ID. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `VITE_API_BASE` | `http://localhost:4000` | Web client API base URL. |

Do not commit real `.env` or `.env.tui` files.

## Documentation

- [Quick Start](QUICKSTART.md)
- [Chinese Quick Start](QUICKSTART.zh-CN.md)
- [Architecture documents](docs/design/)
- [Research notes](docs/research/)
- [Phase 1 tasks](docs/tasks/)
- [SDK docs](docs/sdk/)
- [Known limitations](docs/known-limitations.md)
- [Closed beta checklist](docs/beta-checklist.md)
- [Backup and restore](docs/backup-restore.md)

## Known Limitations

Read [docs/known-limitations.md](docs/known-limitations.md) before deploying. The most important Phase 1 limitations are:

- Runtime services use in-memory stores by default.
- PostgreSQL schema and migrations exist, but domain services are not fully wired to PostgreSQL persistence yet.
- E2EE is single-device and does not include group Sender Key support.
- Bots are intentionally unavailable in E2EE channels.
- Attachment backend primitives exist, but web/desktop upload UX is not complete.
- Electron production signing/notarization and auto-update publishing are not configured.

## Contributing

This project follows the repository conventions in `AGENTS.md`.

- Write documentation, code comments, commit messages, and README content in English for canonical files.
- Keep TypeScript strict and avoid `any` unless justified.
- Validate runtime boundaries with Zod.
- Use Conventional Commits such as `feat:`, `fix:`, `docs:`, `test:`, and `chore:`.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before opening a PR.

## License

MIT. See [LICENSE](LICENSE).
