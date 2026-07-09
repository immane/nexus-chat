# Contributing to Nexus Chat

## Getting Started

1. Fork the repository and clone it locally.
2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

4. Start the development server:

   ```bash
   pnpm dev
   ```

## Development Workflow

### Branch Naming

- `feat/xxx` — new features
- `fix/xxx` — bug fixes
- `docs/xxx` — documentation changes
- `chore/xxx` — tooling, CI, dependencies

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(web): add mobile sidebar overlay
fix(server): correct CORS origin parsing
docs: update README deployment section
chore: upgrade turbo to v3
```

### Before Submitting a PR

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

### PR Checklist

- [ ] Branch is up-to-date with main
- [ ] Commits follow conventional commit format
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `pnpm build` passes
- [ ] Manual smoke test performed

## Project Structure

```
apps/
├── server/      # Node.js backend (Hono + Socket.IO)
├── web/         # React SPA (Vite + Zustand + Tailwind)
├── desktop/     # Electron shell
└── tui/         # Terminal UI / CLI (Ink + Commander)
packages/
├── shared/      # Shared types and Zod schemas
├── signal/      # E2EE abstraction (IE2eeProvider + @noble/* implementation)
├── bot-sdk/     # Bot SDK (TypeScript)
├── ui/          # Shared React components
└── bots/        # First-party bots
docs/
├── design/      # Architecture documents
├── research/    # Technical surveys
├── tasks/       # Phase implementation tasks
└── sdk/         # Multi-language Bot SDK docs
```

## Code Style

- TypeScript strict mode throughout
- Zod for runtime validation at I/O boundaries
- ESLint + Prettier for formatting
- No `any` without explicit justification
- All documentation and comments in English

## Testing

```bash
# Run all tests
pnpm test

# Run tests for a specific package
pnpm --filter @nexus-chat/server test
pnpm --filter @nexus-chat/web test

# Run smoke tests (requires a running server)
PORT=4010 NEXUS_API_BASE=http://127.0.0.1:4010 pnpm smoke:tui:ci
```

## Documentation

Significant architectural or behavioral changes should include corresponding updates under `docs/` where appropriate.

## Reporting Issues

Use the [bug report form](https://github.com/immane/nexus-chat/issues/new?template=bug_report.yml) for bugs. For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
