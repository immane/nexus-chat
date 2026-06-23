---
lang: en
phase: 1
status: draft
---

# 11 — Phase 1 — Node.js Bot SDK Reference Implementation

## Goal

Build the first public Bot SDK implementation in TypeScript/Node.js. Other language SDKs follow this contract later.

## Scope

- `@nexus-chat/bot-sdk` package.
- WebSocket transport.
- Bot token authentication.
- Event listener API.
- Command handler API.
- Message API client.
- Channel info API client.
- Reconnect with exponential backoff.
- Client-side rate limit handling.
- Middleware pipeline.

## Non-Goals

- No Java/Python/PHP/Go/Rust SDK implementations in Phase 1.
- No webhook adapter unless required by a first-party bot.
- No marketplace packaging.

## Public API Sketch

```ts
const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
  gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
});

bot.on('slash_command', async (event) => {
  if (event.command === 'ping') {
    await bot.sendMessage(event.channelId, 'Pong!');
  }
});

await bot.connect();
```

## Acceptance Criteria

- SDK can connect to Bot Engine.
- SDK automatically reconnects.
- SDK can receive `slash_command` event.
- SDK can send a message.
- SDK respects `429 Retry-After`.
- SDK redacts token from logs.

## Test Plan

- Unit tests for reconnect manager.
- Unit tests for rate limiter.
- Integration test with local Bot Engine.
- Example echo bot runs locally.

## Dependencies

- [02 — Shared Contracts](02-phase-1-shared-contracts.md)
- [10 — Bot Engine Core](10-phase-1-bot-engine-core.md)
