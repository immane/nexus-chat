# Project Conventions

## Language

- All documentation, code comments, commit messages, and README files MUST be written in English.
- This project defaults to English as the base language.

## Tech Stack

- Frontend: Electron + React + Vite + Zustand + Tailwind CSS
- Backend: Node.js (Hono / Fastify)
- Database: PostgreSQL + Drizzle ORM + Redis
- Encryption: Signal Protocol (@signalapp/libsignal)
- Monorepo: pnpm workspace + Turborepo

## Code Style

- TypeScript strict mode
- ESLint + Prettier
- No `any` without explicit justification
- Zod for runtime validation at boundaries

## Git

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
- Branch naming: `feat/xxx`, `fix/xxx`, `docs/xxx`
- No secrets committed
