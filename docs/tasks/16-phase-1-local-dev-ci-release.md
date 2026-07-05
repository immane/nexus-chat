---
lang: en
phase: 1
status: done
---

# 16 — Phase 1 — Local Development, CI, Preview Deploy & Closed Beta Release

## Goal

Make the project runnable and verifiable by contributors and prepare a closed beta deployment path.

## Scope

- Docker Compose for PostgreSQL and Redis.
- Local seed command.
- Local dev scripts.
- TUI smoke commands for local and CI verification.
- GitHub Actions for lint/typecheck/test/build.
- Documentation build verification.
- Preview deployment recipe.
- Closed beta checklist.

## Non-Goals

- No full Kubernetes production deployment.
- No multi-region.
- No paid CI optimization.

## Local Dev Commands

```bash
pnpm install
pnpm dev
pnpm db:migrate
pnpm db:seed
pnpm test
```

## CI Jobs

| Job | Purpose |
|-----|---------|
| `lint` | ESLint |
| `typecheck` | TypeScript project references |
| `test` | Unit/integration tests |
| `build` | Build apps/packages |
| `docs` | Documentation build |
| `security` | Dependency audit |
| `smoke:tui` | TUI login/message/E2E/bot smoke tests against the local stack |

## Closed Beta Checklist

- Auth flow works.
- Normal channels work.
- DM works.
- E2E DM works if included in beta scope.
- E2E read-once/disappearing DM policy works if included in beta scope.
- Bot command reference bot works.
- TUI client can log in, send a normal message, run E2E smoke, and invoke the reference bot.
- Logs and audit events are available.
- Backup/restore procedure documented.
- Known limitations documented.

## Acceptance Criteria

- New developer can run local stack from README.
- CI runs on pull request.
- Docs build succeeds.
- TUI smoke commands run locally and in CI.
- Closed beta environment can be deployed from documented steps.

## Dependencies

- All Phase 1 feature tasks.
