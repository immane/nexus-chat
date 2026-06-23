---
lang: en
phase: 1
status: draft
---

# 15 — Phase 1 — Observability, Audit Logs & Security Hardening

## Goal

Add the operational and security baseline required for closed beta: structured logs, audit trail, metrics hooks, rate limits, error handling, and security checks.

## Scope

- Pino structured logging.
- Request IDs.
- WebSocket connection logs.
- Audit logs for critical operations.
- Basic Prometheus metrics endpoint.
- Centralized error codes.
- Rate-limit metrics.
- Security header verification.
- Secret redaction.
- Dependency vulnerability scan workflow.

## Non-Goals

- No full OpenTelemetry tracing.
- No Grafana dashboards unless quick to add.
- No SIEM integration.

## Audit Events

| Event | Reason |
|-------|--------|
| `auth.login` | Account access |
| `auth.refresh_reuse_detected` | Session attack signal |
| `workspace.member_added` | Access change |
| `channel.member_added` | Access change |
| `channel.mode_created_e2e` | Encryption boundary |
| `bot.installed` | Bot access boundary |
| `bot.token_rotated` | Credential lifecycle |
| `attachment.download_url_issued` | File access |

## Metrics

- HTTP request count/latency.
- WebSocket active connections.
- Message send count/latency.
- Bot event queue depth.
- Redis operation errors.
- Auth failure count.

## Acceptance Criteria

- Logs include `requestId` and never include secrets.
- Audit logs are written for critical events.
- Metrics endpoint is available internally.
- Security headers are present in HTTP responses.
- Rate limits return typed errors.

## Test Plan

- Log redaction test.
- Audit event integration test.
- Metrics endpoint smoke test.
- Security header test.
- Rate-limit test.

## Dependencies

- [04 — Auth & Security](04-phase-1-auth-session-security.md)
- [05 — Core Gateway](05-phase-1-core-gateway.md)
