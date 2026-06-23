---
lang: en
phase: 1
status: draft
---

# 02 — Phase 1 — Shared Contracts, Event Schemas & Runtime Validation

## Goal

Define authoritative shared contracts for REST APIs, WebSocket events, message content, bot interactions, E2E metadata, and attachment references.

## Architectural Principle

`packages/shared` is the contract authority. Server, web, desktop, Bot SDK, and future services must consume these schemas rather than redefining payload shapes locally.

## Scope

- Create `packages/shared`.
- Add Zod schemas for core domain IDs and API envelopes.
- Add WebSocket event schemas.
- Add message content schemas.
- Add command invocation schemas.
- Add bot event schemas.
- Add attachment reference schemas.
- Add Signal/E2E metadata schemas.
- Export TypeScript types derived from Zod.

## Non-Goals

- No database models.
- No server handlers.
- No UI components.
- No generated OpenAPI yet.

## Proposed Package Layout

```text
packages/shared/src/
├── index.ts
├── ids.ts
├── api/
│   ├── envelope.ts
│   ├── errors.ts
│   └── pagination.ts
├── auth/
│   └── session.ts
├── workspace/
│   └── schemas.ts
├── channel/
│   └── schemas.ts
├── message/
│   ├── content.ts
│   ├── events.ts
│   └── state.ts
├── attachment/
│   └── schemas.ts
├── bot/
│   ├── commands.ts
│   ├── events.ts
│   ├── manifest.ts
│   └── scopes.ts
├── signal/
│   └── schemas.ts
└── ws/
    ├── client-events.ts
    ├── server-events.ts
    └── envelope.ts
```

## Core Schemas

### API Envelope

```ts
export const ApiSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  requestId: z.string(),
});

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string(),
});
```

### Message Content

```ts
export const AttachmentRefSchema = z.object({
  fileId: z.string().uuid(),
  name: z.string().max(500),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  scanStatus: z.enum(['pending', 'clean', 'blocked']),
  thumbnailFileId: z.string().uuid().optional(),
});

export const MessageContentSchema = z.object({
  type: z.enum(['text', 'image', 'file', 'system']),
  text: z.string().max(40_000).optional(),
  ciphertext: z.string().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
  mentions: z.array(z.string().uuid()).max(50).optional(),
});
```

### Bot Command Invocation

```ts
export const BotCommandInvokeSchema = z.object({
  type: z.literal('bot.command.invoke'),
  workspaceId: z.string().uuid(),
  channelId: z.string().uuid(),
  botName: z.string().min(1).max(50),
  command: z.string().min(0).max(50),
  args: z.array(z.string()).max(100),
  triggerId: z.string().optional(),
});
```

## Decoupling Requirements

- No feature-specific bot schemas in core shared contracts.
- Poll/reminder/kudos/todo payloads are bot-owned and must live in bot packages.
- Shared contracts define generic bot command/event envelopes only.
- Attachments are core references, not FileBot-owned payloads.

## Acceptance Criteria

- `packages/shared` builds to ESM and type declarations.
- Server can import schemas without circular dependencies.
- Web can import inferred types without Node-only code.
- Bot SDK can import command/event types.
- All schemas have unit tests for valid/invalid payloads.

## Test Plan

- `pnpm --filter @nexus-chat/shared test`
- Validate sample REST envelopes.
- Validate sample `message.send` event.
- Validate sample `bot.command.invoke` event.
- Validate sample attachment references with no URL field.

## Dependencies

- [01 — Project Scaffold](01-phase-1-project-scaffold.md)

## Follow-Up Tasks

- [03 — Database Schema](03-phase-1-database-schema.md)
- [05 — Core Gateway](05-phase-1-core-gateway.md)
