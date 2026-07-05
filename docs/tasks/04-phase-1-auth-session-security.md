---
lang: en
phase: 1
status: done
---

# 04 — Phase 1 — Authentication, Sessions & Security Baseline

## Goal

Implement secure user authentication and the minimum security baseline required before any IM or Bot feature is exposed.

## Scope

- Email/password registration.
- Login/logout.
- Argon2id password hashing.
- JWT access token and refresh token rotation.
- Session tracking in Redis.
- Request ID and structured logging.
- Helmet.js, CORS, CSP baseline.
- API rate limiting.
- Audit logs for auth-sensitive operations.

## Non-Goals

- No SSO/OIDC.
- No MFA.
- No passwordless login.
- No enterprise directory sync.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/register` | Create user account |
| `POST` | `/api/v1/auth/login` | Issue token pair |
| `POST` | `/api/v1/auth/refresh` | Rotate refresh token |
| `POST` | `/api/v1/auth/logout` | Revoke current session |
| `GET` | `/api/v1/auth/me` | Return current user |

## Token Policy

| Token | TTL | Storage |
|-------|-----|---------|
| Access token | 15 minutes | Client memory; optional secure persistence in Electron main process |
| Refresh token | 7 days | Redis hash/session store, rotation on every refresh |

## Security Requirements

- Password hashing: Argon2id, memory 64 MB, iterations 3, parallelism 4.
- JWT signing: RS256 with `kid` header.
- Refresh token rotation detects replay.
- Rate limit login attempts per IP and per email.
- Never log passwords, tokens, authorization headers, or cookies.
- All auth routes return generic error messages for invalid credentials.

## Acceptance Criteria

- User can register, login, refresh, logout, and fetch `me`.
- Refresh token rotation invalidates old refresh token.
- Reused refresh token triggers session revocation.
- Invalid credentials do not reveal whether email exists.
- Auth middleware can guard REST routes and WebSocket handshake.

## Test Plan

- Unit tests for password hashing/verification.
- Unit tests for token signing/verification.
- Integration tests for register/login/refresh/logout.
- Rate-limit test for repeated login failures.
- Log redaction test.

## Dependencies

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [03 — Database Schema](03-phase-1-database-schema.md)
