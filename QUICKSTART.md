# Nexus Chat Quick Start

[中文快速开始](QUICKSTART.zh-CN.md) | [Full README](README.md)

This guide gets a local Phase 1 Nexus Chat workspace running for development and smoke testing.

## 1. Prerequisites

Install these first:

- Node.js 22 or newer.
- pnpm 9.15.x.
- Docker Desktop or Docker Engine.

Check versions:

```bash
node --version
pnpm --version
docker --version
```

## 2. Install Dependencies

```bash
pnpm install
```

## 3. Create Local Environment File

```bash
cp .env.example .env
```

The defaults are suitable for local development:

```env
PORT=4000
WEB_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_chat
REDIS_URL=redis://localhost:6379
SESSION_STORE=memory
VITE_API_BASE=http://localhost:4000
```

Use `SESSION_STORE=redis` if you want refresh sessions stored in Redis during local testing.

## 4. Start PostgreSQL And Redis

```bash
docker compose up -d
```

Confirm containers are running:

```bash
docker compose ps
```

## 5. Apply Migrations And Seed Data

```bash
pnpm db:migrate
pnpm db:seed
```

Seed credentials:

| Email | Password |
| --- | --- |
| `ada@example.com` | `Password12345!` |
| `grace@example.com` | `Password12345!` |

Note: Phase 1 runtime services default to in-memory domain stores. The PostgreSQL schema, migration, and seed path are still useful for local infrastructure validation and future persistence integration.

## 6. Start Development Servers

```bash
pnpm dev
```

Open:

- Web client: `http://localhost:5173`
- API health check: `http://localhost:4000/healthz`
- Metrics: `http://localhost:4000/metrics`

The web app supports demo mode and real-server mode. If you use real-server mode and no in-memory users exist yet, register a user from the UI or through the API.

## 7. Run A Fast Validation Pass

In a separate shell:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm coverage
```

Expected result: all commands pass. Current coverage is above 99% statement coverage and above 90% branch coverage.

## 8. Try The TUI/CLI

Show help:

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

Login against the local server:

```bash
pnpm --filter @nexus-chat/tui dev -- login -e ada@example.com -p 'Password12345!'
```

List workspaces:

```bash
pnpm --filter @nexus-chat/tui dev -- workspaces
```

Run smoke tests:

```bash
pnpm --filter @nexus-chat/tui dev -- api-smoke
pnpm --filter @nexus-chat/tui dev -- p2p-smoke
pnpm --filter @nexus-chat/tui dev -- bot-smoke
pnpm --filter @nexus-chat/tui dev -- e2e-smoke
```

The CLI stores its local token in `.env.tui`, which is ignored by Git.

## 9. Run Individual Apps

Server only:

```bash
pnpm --filter @nexus-chat/server dev
```

Web only:

```bash
pnpm --filter @nexus-chat/web dev
```

Desktop shell:

```bash
pnpm --filter @nexus-chat/desktop dev
```

TUI/CLI:

```bash
pnpm --filter @nexus-chat/tui dev -- --help
```

## 10. Useful Reset Commands

Stop infrastructure:

```bash
docker compose down
```

Delete PostgreSQL data and recreate it:

```bash
docker compose down -v
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

Clear TUI auth token:

```bash
pnpm --filter @nexus-chat/tui dev -- logout
```

## Troubleshooting

If `pnpm dev` cannot bind to a port, check for existing processes using ports `4000` or `5173`.

If login fails in the TUI, confirm the server is running and the runtime has the expected user. Because Phase 1 runtime services use in-memory stores by default, seeded PostgreSQL users are not automatically loaded into the in-memory auth store.

If `pnpm db:migrate` fails, confirm Docker is running and `DATABASE_URL` points to the local PostgreSQL container.

If WebSocket commands fail, confirm the web origin matches `WEB_ORIGIN` and the server is reachable at `VITE_API_BASE`.

## Next Steps

- Read the full [README.md](README.md).
- Review [docs/known-limitations.md](docs/known-limitations.md).
- Explore the architecture docs under [docs/design/](docs/design/).
- Inspect the Bot SDK docs at [docs/sdk/nodejs.md](docs/sdk/nodejs.md).
