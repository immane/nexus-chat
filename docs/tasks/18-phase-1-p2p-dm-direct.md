---
lang: en
phase: 1
status: done
---

# 18 — Phase 1 — P2P Direct Connection for 1:1 E2EE DM

## Goal

Add opportunistic WebRTC Data Channel direct connection for 1:1 E2EE DMs. When the P2P path succeeds, messages bypass the server entirely. When it fails (NAT/firewall), the system transparently falls back to the existing server-relayed WebSocket path.

## Scope

- WebRTC Data Channel for 1:1 E2EE DM message transport.
- Server-based signaling relay for SDP offer/answer and ICE candidate exchange.
- `P2pConnectionPool` for managing WebRTC peer connections.
- `HybridTransport` send/receive abstraction: try P2P first, fall back to relay.
- P2P message framing (JSON over data channel) with `clientMsgId` for dedup.
- P2P ack over data channel, with lightweight server ack for multi-device sync.
- Connection teardown + cleanup (hangup signaling, pool removal).
- Cooldown timer (30s) after failed P2P attempt to avoid repeated failures.
- Per-peer connection caching (reuse established connections).
- ICE candidate trickling.
- New shared schemas for all P2P signaling events.
- Server-side P2P event relay in the WebSocket gateway.
- Unit tests, integration tests, and a `p2p-smoke` TUI command.
- ICE server configuration via env variables (STUN/TURN).

## Non-Goals

- No group channel P2P (Signal Sender Key / MLS is a separate concern).
- No TURN server provisioning in this task (document config only).
- No P2P for normal-mode (non-E2EE) channels — server relay is appropriate there.
- No TUI or CLI P2P support (Node.js lacks native WebRTC; `wrtc` package has maintenance issues).
- No UI for P2P status indicators (green/yellow/gray lock icon) — deferred to a UI polish task.
- No multi-device P2P coordination beyond `deviceId` awareness.
- No file transfer over P2P (attachments still go through server).

## Subtasks

### 18.1 Shared Schemas

**File**: `packages/shared/src/index.ts`

- [ ] 18.1.1 Add `p2pTargetSchema` (`targetUserId`, `targetDeviceId?`).
- [ ] 18.1.2 Add `p2pOfferSchema` (`targetUserId`, `targetDeviceId?`, `sdp`).
- [ ] 18.1.3 Add `p2pAnswerSchema` (same shape as offer).
- [ ] 18.1.4 Add `p2pIceCandidateSchema` (`targetUserId`, `candidate` object with `candidate`, `sdpMid`, `sdpMLineIndex`).
- [ ] 18.1.5 Add `p2pHangupSchema` (just `p2pTargetSchema`).
- [ ] 18.1.6 Add `p2pStatusSchema` (`targetUserId`, `status`: "connected"|"disconnected"|"failed", `reason?`).
- [ ] 18.1.7 Add `WsP2pOfferEnvelopeSchema` etc. (wsEnvelope + type literal + payload schema).
- [ ] 18.1.8 Add P2P types to `WsClientEvent` and `WsServerEvent` discriminated unions.
- [ ] 18.1.9 Add zod unit tests for all new schemas.
- [ ] 18.1.10 Run `pnpm --filter @nexus-chat/shared typecheck && pnpm --filter @nexus-chat/shared test`.

### 18.2 Server Signaling Relay

**File**: `apps/server/src/ws/gateway.ts`

- [ ] 18.2.1 Define `P2P_FORWARD_EVENTS` set (`p2p.offer`, `p2p.answer`, `p2p.ice-candidate`, `p2p.hangup`).
- [ ] 18.2.2 Implement `relayP2pEvent(io, socket, envelope)`: find target socket by `payload.targetUserId`, emit forwarded envelope with `_senderUserId`.
- [ ] 18.2.3 Wire `relayP2pEvent` into `handleClientEnvelope` before the rate limiter applies to normal events.
- [ ] 18.2.4 Handle `p2p.status` events: log for observability, no relay.
- [ ] 18.2.5 Add gateway unit tests: verify `p2p.offer` is relayed to target socket; verify `p2p.hangup` is relayed; verify `p2p.status` is NOT relayed; verify non-existent target is silently dropped.
- [ ] 18.2.6 Run `pnpm --filter @nexus-chat/server typecheck && pnpm --filter @nexus-chat/server test`.

### 18.3 ICE Server Configuration

- [ ] 18.3.1 Add `NEXUS_STUN_SERVERS`, `NEXUS_TURN_SERVERS`, `NEXUS_TURN_USERNAME`, `NEXUS_TURN_CREDENTIAL` to `.env.example`.
- [ ] 18.3.2 Add `NEXUS_P2P_CONNECTION_TIMEOUT_MS` (default 5000) and `NEXUS_P2P_RELAY_COOLDOWN_MS` (default 30000) to `.env.example`.
- [ ] 18.3.3 Create `apps/web/src/lib/p2p/config.ts`: parse ICE server config from env or use defaults.

### 18.4 P2P Connection Pool

**New files**: `apps/web/src/lib/p2p/pool.ts`, `apps/web/src/lib/p2p/types.ts`

- [ ] 18.4.1 Define `P2pConnectionState` type and `PeerTransportState` (mode, p2pFailedAt, cooldownUntil).
- [ ] 18.4.2 Implement `P2pConnectionPool` class:
  - `Map<userId, RTCPeerConnection>` for connection storage.
  - `Map<userId, RTCDataChannel>` for data channel references.
  - `Set<userId>` for in-progress connections (`connecting`).
  - `has(userId)`, `getChannel(userId)`.
  - `createOffer(peerUserId): Promise<RTCSessionDescription>`.
  - `handleAnswer(peerUserId, sdp)`.
  - `handleIceCandidate(peerUserId, candidate)`.
  - `close(userId)`, `closeAll()`.
  - Cooldown tracking: `isInCooldown(userId)`, `markFailed(userId)`.
  - ICE candidate trickling: `onicecandidate` → signaling send.
- [ ] 18.4.3 Implement `setupDataChannelHandlers(dc, peerUserId)` for onopen, onclose, onmessage, onerror.
- [ ] 18.4.4 Write unit tests: pool lifecycle, offer/answer flow, ICE candidate handling, cooldown logic, closeAll cleanup.
- [ ] 18.4.5 Run `pnpm --filter @nexus-chat/web typecheck && pnpm --filter @nexus-chat/web test`.

### 18.5 Signaling Handler

**New file**: `apps/web/src/lib/p2p/signaling.ts`

- [ ] 18.5.1 Implement `P2pSignalingHandler`:
  - Listens on existing WebSocket for `p2p.offer`, `p2p.answer`, `p2p.ice-candidate`, `p2p.hangup` events.
  - Routes to appropriate `P2pConnectionPool` methods.
  - Validates `_senderUserId` matches expected peer.
- [ ] 18.5.2 Implement `sendSignaling(wsSend, eventType, payload)` helper: wraps in `wsEnvelope` and emits via WebSocket.
- [ ] 18.5.3 Write unit tests: mock WebSocket, verify offer triggers `createOffer` flow, verify answer triggers `handleAnswer`, verify ICE candidate routes correctly, verify hangup triggers `close`.
- [ ] 18.5.4 Run `pnpm --filter @nexus-chat/web typecheck && pnpm --filter @nexus-chat/web test`.

### 18.6 Hybrid Transport

**New file**: `apps/web/src/lib/p2p/transport.ts`

- [ ] 18.6.1 Implement `HybridTransport` class:
  - `constructor(session: SignalSession, pool: P2pConnectionPool, wsSend, signalingSend)`.
  - `async sendMessage(input: SendMessageInput): Promise<SendResult>`:
    1. Call `encryptForSession(session, plaintext)`.
    2. Check `pool.has(targetUserId)` → P2P send via data channel.
    3. If no connection and not in cooldown → initiate WebRTC with 5s timeout.
    4. If connection succeeds → P2P send.
    5. If timeout/failure → server WebSocket relay fallback.
  - `onMessage(handler)`: listen on both data channel and WebSocket; dedup by `clientMsgId`; decrypt and deliver.
  - `destroy()`: close pool and remove listeners.
- [ ] 18.6.2 Implement `sendP2pFrame(dataChannel, frame)` and `sendP2pAck(dataChannel, clientMsgId)`.
- [ ] 18.6.3 Implement client-side `clientMsgId` dedup (LRU Set of last 1000).
- [ ] 18.6.4 Implement fallback: `sendViaRelay(wsSend, input)` → existing socket.emit flow.
- [ ] 18.6.5 Write unit tests:
  - P2P available: message goes via data channel, returns `{ path: "p2p" }`.
  - P2P unavailable: falls back to relay, returns `{ path: "relay" }`.
  - Cooldown active: skips P2P attempt, goes directly to relay.
  - Dedup: same `clientMsgId` on both paths, only first is processed.
  - Multiple messages: all go through same cached data channel.
  - Data channel close: next message falls back to relay.
- [ ] 18.6.6 Run `pnpm --filter @nexus-chat/web typecheck && pnpm --filter @nexus-chat/web test`.

### 18.7 Integration with WebSocket Client

**File**: `apps/web/src/lib/ws-client.ts`

- [ ] 18.7.1 Add P2P signaling event listener in `createSocket` or a separate `setupP2pSignaling` function.
- [ ] 18.7.2 Ensure the `p2p.*` event subscription is active for authenticated sessions.
- [ ] 18.7.3 Run existing web tests to ensure no regression.

### 18.8 Smoke Test

**File**: `apps/tui/src/commands/smoke.ts`

- [ ] 18.8.1 Add `runP2pSmoke` function:
  - Verify all P2P shared schemas are importable and parse valid data.
  - Connect WebSocket, send `p2p.status` event to server, verify `ok` response.
  - Verify the server accepts `p2p.offer` payload (even without a target — server drops silently).
  - Verify `P2pConnectionPool` is importable and instantiates (browser env only).
- [ ] 18.8.2 Register `p2p-smoke` command in `apps/tui/src/cli.ts`.
- [ ] 18.8.3 Export `runP2pSmoke` from `apps/tui/src/index.ts`.
- [ ] 18.8.4 Update `apps/tui/src/index.test.ts` to assert `p2p-smoke` command exists.
- [ ] 18.8.5 Add `p2p-smoke` to the TUI smoke chain in `apps/tui/package.json`.
- [ ] 18.8.6 Run `pnpm --filter @nexus-chat/tui typecheck && pnpm --filter @nexus-chat/tui test`.

### 18.9 Integration Test (Browser)

**New file**: `apps/web/src/lib/p2p/transport.integration.test.ts` (or within existing test setup)

- [ ] 18.9.1 Two client instances (Alice and Bob) with mock WebSocket + real RTCPeerConnection.
- [ ] 18.9.2 Full WebRTC handshake: Alice sends offer via mocked signaling, Bob answers, ICE exchange, data channel opens.
- [ ] 18.9.3 Alice sends P2P ciphertext message; Bob receives and decrypts.
- [ ] 18.9.4 Verify `clientMsgId` dedup when same message arrives via both paths (simulated).
- [ ] 18.9.5 Verify fallback: simulate WebRTC failure (don't call `pc.setLocalDescription`), message arrives via relay.
- [ ] 18.9.6 Verify cooldown: after a failed attempt, next message skips WebRTC and goes relay.

### 18.10 Documentation & Config

- [ ] 18.10.1 Update `README.md` Phase 1 feature table: add "P2P Direct Connection for 1:1 E2EE DM".
- [ ] 18.10.2 Update `docs/ai/context.md` with P2P implementation status.
- [ ] 18.10.3 Update `mkdocs.yml` nav: add P2P design doc and task doc.
- [ ] 18.10.4 Verify `pnpm build` succeeds with all new code.
- [ ] 18.10.5 Verify `pnpm lint` passes.
- [ ] 18.10.6 Verify `pnpm typecheck` passes.
- [ ] 18.10.7 Verify `pnpm coverage` maintains 90%+ branch coverage.

## Acceptance Criteria

- [ ] Two web clients can establish a WebRTC Data Channel and send E2EE ciphertext messages directly, with no server data path involvement.
- [ ] SDP offer/answer and ICE candidates are successfully relayed via the server WebSocket signaling path.
- [ ] If WebRTC fails (simulated: blocked STUN), the message is delivered via the existing server WebSocket relay path without user-visible error.
- [ ] `clientMsgId` deduplication works: a message arriving on both P2P and relay paths is only processed once.
- [ ] All P2P schemas are validated by Zod at both client and server boundaries.
- [ ] Server gateway relays P2P events only to the authenticated target user; unknown targets are silently dropped.
- [ ] Connection pool correctly manages lifecycle: create, reuse, teardown per peer.
- [ ] Cooldown timer prevents repeated failed WebRTC attempts within 30 seconds.
- [ ] `p2p-smoke` command in TUI verifies schemas and server signaling acceptance.
- [ ] All existing tests (72 tests) continue to pass without modification.
- [ ] No new npm runtime dependencies added (WebRTC is browser-native).
- [ ] ESLint, TypeScript strict mode, Vitest unit tests, and Vitest coverage all pass.

## Dependencies

- [09 — Signal DM E2EE](09-phase-1-signal-dm-e2ee.md) — Signal session establishment and encrypt/decrypt are prerequisites.
- [05 — Core Gateway](05-phase-1-core-gateway.md) — WebSocket relay infrastructure is reused for signaling.
- [07 — Message Service](07-phase-1-message-service.md) — Server relay fallback for ciphertext messages.
- [13 — Web Client Shell](13-phase-1-web-client-shell.md) — P2P code lives in the web client.
- [16 — Local Dev, CI & Release](16-phase-1-local-dev-ci-release.md) — ICE server env config.

## Estimated Effort

| Subtask | Hours | Risk |
|---|---|---|
| 18.1 Shared Schemas | 2h | Low |
| 18.2 Server Signaling Relay | 3h | Low |
| 18.3 ICE Server Config | 0.5h | Low |
| 18.4 P2P Connection Pool | 6h | Medium |
| 18.5 Signaling Handler | 3h | Low |
| 18.6 Hybrid Transport | 6h | Medium |
| 18.7 WS Client Integration | 2h | Low |
| 18.8 Smoke Test | 2h | Low |
| 18.9 Integration Test | 4h | Medium |
| 18.10 Documentation & Config | 1.5h | Low |
| **Total** | **~30h** | |

Key risk: WebRTC API behavior differences across browsers. Mitigated by using standard APIs and limiting initially to Chrome/Electron (Chromium-based).

## Validation Commands

```bash
# Unit tests
pnpm --filter @nexus-chat/shared test
pnpm --filter @nexus-chat/server test
pnpm --filter @nexus-chat/web test
pnpm --filter @nexus-chat/tui test

# TypeScript
pnpm typecheck

# Lint
pnpm lint

# Full build
pnpm build

# Smoke (requires running server)
pnpm smoke:tui:ci

# Coverage
pnpm coverage
```
