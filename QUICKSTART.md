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
WEB_ORIGIN=http://localhost
DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_chat
REDIS_URL=redis://localhost:6379
SESSION_STORE=memory
VITE_API_BASE=http://localhost:4000
```

Use `SESSION_STORE=redis` if you want refresh sessions stored in Redis during local testing.

## 4. Start The Local Server Container

```bash
docker compose build server
docker compose up -d
```

Confirm the server is running:

```bash
docker compose ps
curl http://localhost:4000/healthz
```

Phase 1 runtime services use in-memory domain stores. PostgreSQL and Redis are intentionally commented out in `docker-compose.yml` until persistence is wired.

## 5. Seed In-Memory Dev Data

```bash
bash scripts/dev-bootstrap.sh
```

Dev credentials:

| Email | Password |
| --- | --- |
| `alice@dev.local` | `test1234abcd` |
| `bob@dev.local` | `test1234abcd` |

The bootstrap creates `Dev Workspace`, a default `#general` channel, and workspace/channel membership for Bob. Re-run it after restarting or rebuilding the server container because the store is in memory.

## 6. Start Development Servers

For the Docker server plus web UI flow, keep the server container running and start Vite separately:

```bash
pnpm --filter @nexus-chat/web dev
```

For the native all-app development flow, stop Docker first if it owns port `4000`, then run:

```bash
docker compose down
pnpm dev
```

Open:

- Web client: the Vite URL printed by the web dev server, usually `http://localhost:5173` or `http://localhost:5174`
- API health check: `http://localhost:4000/healthz`
- Metrics: `http://localhost:4000/metrics`

The web app supports demo mode and real-server mode. In real-server mode, use the dev credentials above or register another user through the API/UI.

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
pnpm --filter @nexus-chat/tui dev --help
```

Login against the local server:

```bash
pnpm --filter @nexus-chat/tui dev login -e alice@dev.local -p test1234abcd
```

List workspaces:

```bash
pnpm --filter @nexus-chat/tui dev workspaces
```

Run smoke tests:

```bash
pnpm --filter @nexus-chat/tui dev api-smoke
pnpm --filter @nexus-chat/tui dev p2p-smoke
pnpm --filter @nexus-chat/tui dev bot-smoke
pnpm --filter @nexus-chat/tui dev e2e-smoke
```

Run the full native CI smoke flow:

```bash
docker compose down
pnpm smoke:tui:ci
```

`smoke:tui:ci` starts its own native server on port `4000`, so Docker must not already be bound to that port.

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
pnpm --filter @nexus-chat/tui dev --help
```

## 10. Useful Reset Commands

Stop infrastructure:

```bash
docker compose down
```

Recreate the in-memory Docker server and seed data:

```bash
docker compose down
docker compose build server
docker compose up -d
bash scripts/dev-bootstrap.sh
```

Clear TUI auth token:

```bash
pnpm --filter @nexus-chat/tui dev logout
```

## Troubleshooting

If `pnpm dev` or `smoke:tui:ci` cannot bind to a port, check for existing processes using ports `4000`, `5173`, or `5174`. Stop Docker with `docker compose down` before running native CI smoke.

If login fails in the TUI, confirm the server is running and the runtime has the expected user. Because Phase 1 runtime services use in-memory stores by default, you need to run `scripts/dev-bootstrap.sh` after each fresh server start or register users manually.

If `pnpm db:migrate` fails, remember that the default Docker flow does not start PostgreSQL. Uncomment PostgreSQL in `docker-compose.yml` first if you are validating migrations.

If WebSocket commands fail, confirm the server is reachable at `VITE_API_BASE`. The default `WEB_ORIGIN=http://localhost` allows any localhost port for browser clients.

## Next Steps

- Read the full [README.md](README.md).
- Review [docs/known-limitations.md](docs/known-limitations.md).
- Explore the architecture docs under [docs/design/](docs/design/).
- Inspect the Bot SDK docs at [docs/sdk/nodejs.md](docs/sdk/nodejs.md).
