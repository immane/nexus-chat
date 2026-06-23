---
lang: en
phase: 1
status: draft
---

# 09 — Phase 1 — Signal Protocol 1:1 DM E2EE

## Goal

Implement 1:1 DM end-to-end encryption using Signal Protocol primitives while keeping the server as an opaque relay.

## Scope

- `packages/signal` wrapper.
- Client identity key generation.
- Signed prekey generation.
- One-time prekey generation.
- PreKeyBundle upload/fetch.
- X3DH session establishment.
- Double Ratchet message encryption/decryption.
- E2E message send/receive in 1:1 DM.
- Local session storage strategy.

## Non-Goals

- No group E2E in Phase 1.
- No multi-device E2E.
- No safety numbers UI.
- No disappearing messages.
- No sealed sender.

## Server Responsibilities

- Store public PreKeyBundles.
- Consume one-time prekeys transactionally.
- Store and relay ciphertext messages.
- Never store private keys.
- Never decrypt message content.

## Client Responsibilities

- Generate and protect private keys.
- Establish sessions.
- Encrypt before send.
- Decrypt after receive.
- Handle ratchet state.

## Acceptance Criteria

- User A can create encrypted DM session with User B.
- Server stores ciphertext only.
- Recipient can decrypt message locally.
- Bot events are not emitted for E2E DM.
- Server-side search is disabled for E2E DM.

## Test Plan

- Unit tests for key bundle serialization.
- Integration test for session establishment.
- Send/decrypt E2E message test.
- Verify plaintext does not appear in DB/logs.
- One-time prekey consumption test.

## Dependencies

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [03 — Database Schema](03-phase-1-database-schema.md)
- [06 — Workspace & Channel Service](06-phase-1-workspace-channel-service.md)
- [07 — Message Service](07-phase-1-message-service.md)
