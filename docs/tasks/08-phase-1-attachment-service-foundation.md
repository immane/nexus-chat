---
lang: en
phase: 1
status: draft
---

# 08 — Phase 1 — Attachment Service Foundation & E2E-Safe File Boundary

## Goal

Build the core attachment lifecycle foundation so Phase 2 file features and E2E attachments can be implemented without redesign.

## Key Decision

File storage is **not** owned by `@FileBot`. Core Attachment Service owns upload sessions, object keys, scan status, signed URL issuance, authorization, retention, and E2E opaque blobs. `@FileBot` is only a UX/workflow bot over this service.

## Scope

- Implement attachment DB tables.
- Implement upload session creation.
- Implement signed upload URL generation.
- Implement file record finalization after upload.
- Implement signed download URL generation.
- Implement scan status placeholder.
- Implement message attachment references.
- Define E2E attachment metadata boundary.

## Non-Goals

- No full file UI in Phase 1 unless required for testing.
- No production virus scanner integration.
- No thumbnail worker unless trivial.
- No FileBot implementation beyond interface assumptions.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/attachments/upload-sessions` | Create upload session and presigned URL |
| `POST` | `/api/v1/attachments/upload-sessions/:id/complete` | Finalize uploaded object into `files` record |
| `GET` | `/api/v1/attachments/:fileId` | Get authorized file metadata |
| `POST` | `/api/v1/attachments/:fileId/download-url` | Issue short-lived signed download URL |

## E2E Attachment Flow

```text
Client encrypts file locally
  → upload encrypted blob through Attachment Service
  → server stores opaque blob and metadata
  → E2E message ciphertext includes fileId + encrypted file key metadata
  → recipient downloads opaque blob
  → recipient decrypts locally
```

## Security Requirements

- No client-provided public URLs in message payload.
- Download URLs are short-lived and issued after authz.
- E2E files are never decrypted by server.
- Normal-mode files can be scanned server-side.
- E2E files can only be scanned as opaque blobs unless client-side scanning is added.

## Acceptance Criteria

- Upload session can be created by an authorized channel member.
- Upload finalization creates a `files` record.
- Message can reference `fileId` via `message_attachments`.
- Unauthorized users cannot get signed download URL.
- E2E file upload path stores `encryption = 'e2e'` and never exposes plaintext.

## Test Plan

- Upload session creation test.
- Upload completion test.
- Download URL authorization test.
- E2E opaque file metadata test.
- Message attachment association test.

## Dependencies

- [03 — Database Schema](03-phase-1-database-schema.md)
- [06 — Workspace & Channel Service](06-phase-1-workspace-channel-service.md)
