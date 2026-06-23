---
lang: en
phase: 1
status: draft
---

# 01 — Phase 1 — Project Scaffold & Developer Workflow

## Goal

Create the monorepo foundation that all Phase 1 work depends on: package layout, TypeScript configuration, formatting, linting, testing, local development scripts, and CI conventions.

## Ownership

| Area | Owner |
|------|-------|
| Monorepo tooling | Platform team |
| TypeScript / lint / test baseline | Platform team |
| CI workflow | Platform team |

## Scope

- Initialize `pnpm` workspace.
- Configure Turborepo task pipeline.
- Create the initial package/app directories.
- Add shared TypeScript config.
- Add ESLint and Prettier.
- Add Vitest baseline.
- Add `dotenv` conventions and `.env.example`.
- Add root scripts for build/test/lint/typecheck/dev.

## Non-Goals

- No application features.
- No database schema beyond empty migration folder.
- No production deployment pipeline.
- No Electron packaging yet.

## Target Structure

```text
nexus-chat/
├── apps/
│   ├── server/
│   ├── web/
│   └── desktop/
├── packages/
│   ├── shared/
│   ├── ui/
│   ├── signal/
│   └── bot-sdk/
├── docs/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── eslint.config.js
├── prettier.config.js
└── vitest.config.ts
```

## Deliverables

| Deliverable | Description |
|-------------|-------------|
| `package.json` | Root scripts and workspace metadata |
| `pnpm-workspace.yaml` | Workspace package globs |
| `turbo.json` | `build`, `dev`, `lint`, `typecheck`, `test` pipeline |
| `tsconfig.base.json` | Strict shared TypeScript settings |
| `apps/*/package.json` | Empty app packages with placeholder scripts |
| `packages/*/package.json` | Empty shared packages with build/typecheck scripts |
| `.env.example` | Documented local env vars |

## Required Root Scripts

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "test": "turbo test",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

## TypeScript Rules

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitOverride: true`
- `moduleResolution: "Bundler"` for frontend/shared packages.
- `moduleResolution: "NodeNext"` for server/desktop packages if needed.

## Acceptance Criteria

- `pnpm install` succeeds.
- `pnpm typecheck` succeeds with placeholder packages.
- `pnpm lint` succeeds.
- `pnpm test` succeeds.
- `pnpm build` succeeds or no-ops cleanly for placeholder packages.
- New packages can import from `@nexus-chat/shared` using workspace protocol.

## Test Plan

- Run `pnpm install`.
- Run `pnpm lint`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run `pnpm build`.

## Dependencies

None. This is the root prerequisite for all other Phase 1 tasks.

## Follow-Up Tasks

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [03 — Database Schema](03-phase-1-database-schema.md)
