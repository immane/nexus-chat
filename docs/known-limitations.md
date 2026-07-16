# Known Limitations

> Applies to v0.1.0. Items marked with a phase reference are planned for resolution in later phases.

## Encryption

- **Single-device E2EE only.** Phase 1 supports one device per user for end-to-end encrypted DMs. Multi-device E2EE session relay is planned for Phase 3.
- **No group E2EE.** Only 1:1 DM encryption is implemented. Group E2E via Sender Key is planned for Phase 2.
- **No safety numbers UI.** Key verification UI is not surfaced yet (Phase 3, Signal Protocol distribution branch).
- **Signal Protocol deferred to Phase 3.** The `main` branch uses ECDH + AES-256-GCM (MIT-compatible) via `@noble/*`. Full X3DH + Double Ratchet forward secrecy via `@signalapp/libsignal-client` (AGPL-3.0) will ship on a separate distribution branch to avoid copyleft license contamination of the MIT codebase.

## Data Stores

- **In-memory default for development.** The `SESSION_STORE=memory` default uses in-memory maps for session data. Production uses PostgreSQL (`PERSISTENCE=postgres`) with full async domain adapters. Switch to `SESSION_STORE=redis` for Redis-backed sessions.
- **Partial WebSocket horizontal scaling.** Set `SOCKET_IO_ADAPTER=redis` to distribute Socket.IO room broadcasts across instances. Presence counters, WebSocket rate limits, and bot event queues are still process-local, so they must be moved to shared infrastructure before independently scaling those concerns.

## Search & Attachments

- **No full-text search.** PostgreSQL `tsvector` full-text search is planned for Phase 2. Currently, message content is only searchable by exact ID or range queries.
- **Dev file upload is memory-only.** File bytes uploaded via `/dev-upload` are stored in the server process memory and are lost on restart. File metadata survives in PostgreSQL when `PERSISTENCE=postgres`. Production object storage (S3-compatible) is planned for Phase 2.

## Electron Desktop

- **No production notarization.** The Electron app is not code-signed or notarized for macOS/Windows. This will fail Gatekeeper checks and SmartScreen filters.
- **Auto-update is a placeholder.** The Electron auto-update mechanism is stubbed out. No update server or signed update artifacts are configured.
- **Linux sandbox may not work.** Electron's `sandbox` option may not function correctly on all Linux distributions, particularly those using alternative security modules.

## TUI Client

- **No interactive chat UI.** The TUI supports CLI commands (login, list workspaces/channels, send message, verify E2E) but does not provide an interactive real-time chat interface. It is intended for smoke testing and developer operations.

## Observability

- **No OpenTelemetry tracing.** Only Pino structured logs and Prometheus metrics are available. Distributed tracing with OpenTelemetry is planned for Phase 3.
- **In-memory audit log.** Audit events are stored in an in-memory array during development. With `PERSISTENCE=postgres`, audit events are persisted to the `audit_logs` table. A dedicated persistent audit pipeline is planned for Phase 2.
