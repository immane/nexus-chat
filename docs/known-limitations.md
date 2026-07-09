# Known Limitations

> Applies to Phase 1 (v0.1.0). Items marked with a phase reference are planned for resolution in later phases.

## Encryption

- **Single-device E2EE only.** Phase 1 supports one device per user for end-to-end encrypted DMs. Multi-device E2EE session relay is planned for Phase 3.
- **No group E2EE.** Only 1:1 DM encryption is implemented. Group E2E via Sender Key is planned for Phase 2.
- **No safety numbers UI.** Key verification UI is not surfaced yet (Phase 3, Signal Protocol distribution branch).
- **Signal Protocol deferred to Phase 3.** The `main` branch uses ECDH + AES-256-GCM (MIT-compatible) via `@noble/*`. Full X3DH + Double Ratchet forward secrecy via `@signalapp/libsignal-client` (AGPL-3.0) will ship on a separate distribution branch to avoid copyleft license contamination of the MIT codebase.

## Data Stores

- **In-memory stores for development.** The `SESSION_STORE=memory` default uses in-memory maps for session data. PostgreSQL schema (`sessions` table) is ready but not wired at runtime in dev mode. Switch to `SESSION_STORE=redis` or `postgres` for production.
- **No Redis WebSocket adapter in dev.** Socket.IO runs as a single process without the Redis adapter, which means horizontal scaling is not supported in development mode. The Redis adapter is available for production deployment.

## Search & Attachments

- **No full-text search.** PostgreSQL `tsvector` full-text search is planned for Phase 2. Currently, message content is only searchable by exact ID or range queries.
- **No file upload in web/desktop UI.** The attachment service backend (presigned URLs, S3 integration) is implemented, but the upload UI in the web and desktop clients is not yet built. File upload is available via the API only.

## Electron Desktop

- **No production notarization.** The Electron app is not code-signed or notarized for macOS/Windows. This will fail Gatekeeper checks and SmartScreen filters.
- **Auto-update is a placeholder.** The Electron auto-update mechanism is stubbed out. No update server or signed update artifacts are configured.
- **Linux sandbox may not work.** Electron's `sandbox` option may not function correctly on all Linux distributions, particularly those using alternative security modules.

## TUI Client

- **No interactive chat UI.** The TUI supports CLI commands (login, list workspaces/channels, send message, verify E2E) but does not provide an interactive real-time chat interface. It is intended for smoke testing and developer operations.

## Observability

- **No OpenTelemetry tracing.** Only Pino structured logs and Prometheus metrics are available. Distributed tracing with OpenTelemetry is planned for Phase 3.
- **In-memory audit log.** Audit events are stored in an in-memory array during development. A persistent audit log with PostgreSQL storage is planned for Phase 2.
