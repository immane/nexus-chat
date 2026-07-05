---
lang: en
---

# Nexus Chat — P2P Direct Connection for 1:1 E2EE DM Design

> Version: v1.0 | Last Updated: 2026-07-06 | Status: Draft
> References: [Signal DM E2EE Task](../tasks/09-phase-1-signal-dm-e2ee.md), [Core Gateway Layer](02_Long_Connection_and_Core_Gateway_Layer.md), [Security & E2EE Roadmap](../research/security-defense-e2ee-roadmap.md)

---

## Table of Contents

1. [Motivation & Rationale](#1-motivation--rationale)
2. [Architecture Overview](#2-architecture-overview)
3. [WebRTC Data Channel Protocol](#3-webrtc-data-channel-protocol)
4. [Signaling Protocol (Server-Relayed)](#4-signaling-protocol-server-relayed)
5. [Hybrid Send/Receive Flow](#5-hybrid-sendreceive-flow)
6. [Connection Lifecycle Management](#6-connection-lifecycle-management)
7. [Fallback Strategy](#7-fallback-strategy)
8. [Schema & Event Changes](#8-schema--event-changes)
9. [Client Architecture](#9-client-architecture)
10. [Server Architecture](#10-server-architecture)
11. [Security Considerations](#11-security-considerations)
12. [Testing Strategy](#12-testing-strategy)
13. [Dependencies & Tools](#13-dependencies--tools)

---

## 1. Motivation & Rationale

### 1.1 Current State (Server-Relayed E2EE)

In Phase 1 milestone 09, E2EE DM messages flow through the server:

```
Alice ──[encrypt]──► ciphertext ──[WebSocket]──► Server ──[WebSocket]──► Bob ──[decrypt]──► plaintext
```

The server never sees plaintext (encryption is client-side), but the server **observes metadata**: who is talking to whom, when, message size, and ciphertext bytes.

### 1.2 Goal

Add an **opportunistic WebRTC Data Channel** path for 1:1 E2EE DMs:

```
Alice ──[WebRTC Data Channel]──► Bob     (preferred, direct)
         │                              │
         └──[WebSocket signaling]──► Server ◄──[signaling reply]──┘
```

When WebRTC succeeds, the server is removed from the message data path entirely. When it fails (NAT, firewall), the system transparently falls back to the existing server-relayed path.

### 1.3 Why 1:1 DM Only

- **Connection model is simple**: one WebRTC `RTCPeerConnection` per DM peer pair.
- **Privacy benefit is maximized**: DMs are the most sensitive communication channel.
- **Avoids O(N²) complexity** of full-mesh group P2P in this phase.
- **Group E2EE** already has a different topology (Signal Sender Key / MLS) and is orthogonal to transport.

### 1.4 Design Principles

| Principle | Description |
|---|---|
| **Opportunistic** | Try P2P; if it fails within a short timeout, use server relay. Never block the user. |
| **Transport-agnostic encryption** | `packages/signal` encrypt/decrypt functions are unchanged. The ciphertext is identical whether sent via WebRTC or WebSocket. |
| **Server as signaling relay only** | The server relays SDP/ICE without parsing or storing them. No cryptographic material touches the server. |
| **Zero config for users** | P2P is automatic. Users don't opt in or configure anything. |
| **Per-peer connection cache** | Once a WebRTC connection is established, reuse it for the session lifetime. |

---

## 2. Architecture Overview

### 2.1 High-Level Data Flow

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│         Alice's Client           │     │          Bob's Client            │
│                                  │     │                                  │
│  ┌────────────────────────────┐  │     │  ┌────────────────────────────┐  │
│  │  packages/signal           │  │     │  │  packages/signal           │  │
│  │  encryptForSession()       │  │     │  │  decryptFromSession()      │  │
│  │  (unchanged)               │  │     │  │  (unchanged)               │  │
│  └──────────┬─────────────────┘  │     │  └──────────▲─────────────────┘  │
│             │ ciphertext         │     │             │ ciphertext         │
│  ┌──────────▼─────────────────┐  │     │  ┌──────────┴─────────────────┐  │
│  │  P2P Transport Manager      │  │     │  │  P2P Transport Manager      │  │
│  │  ┌───────────────────────┐  │  │     │  │  ┌───────────────────────┐  │  │
│  │  │ WebRTC Data Channel    │──┼──┼─────┼──│ WebRTC Data Channel    │  │  │
│  │  │ (preferred path)       │  │  │     │  │ (preferred path)       │  │  │
│  │  └───────────────────────┘  │  │     │  │  └───────────────────────┘  │  │
│  │  ┌───────────────────────┐  │  │     │  │  ┌───────────────────────┐  │  │
│  │  │ WebSocket (fallback)   │──┼──┼──┐  │  │  │ WebSocket (fallback)   │  │  │
│  │  └───────────────────────┘  │  │  │  │  │  └───────────────────────┘  │  │
│  │  ┌───────────────────────┐  │  │  │  │  │  ┌───────────────────────┐  │  │
│  │  │ Signaling (WebSocket)  │──┼──┼──┼──┼──│  │ Signaling (WebSocket)  │  │  │
│  │  └───────────────────────┘  │  │  │  │  │  └───────────────────────┘  │  │
│  └────────────────────────────┘  │  │  │  └────────────────────────────┘  │
└──────────────────────────────────┘  │  │  └──────────────────────────────────┘
                                      │  │
                          ┌───────────▼──┴───────────┐
                          │        Server              │
                          │  ┌──────────────────────┐  │
                          │  │ Signaling Relay       │  │
                          │  │ (WebSocket events)    │  │
                          │  └──────────────────────┘  │
                          │  ┌──────────────────────┐  │
                          │  │ Message Relay         │  │
                          │  │ (fallback only,       │  │
                          │  │  unchanged)            │  │
                          │  └──────────────────────┘  │
                          └───────────────────────────┘
```

### 2.2 Component Matrix

| Component | Location | Change Level | Description |
|---|---|---|---|
| `signal` package | `packages/signal/src/index.ts` | **None** | encrypt/decrypt unchanged |
| `shared` schemas | `packages/shared/src/index.ts` | **Add** | New P2P signaling event schemas |
| P2P Transport Manager | `apps/web/src/lib/p2p/` (new) | **New** | WebRTC connection pool, signaling handler, hybrid send |
| Server Signaling Relay | `apps/server/src/ws/gateway.ts` | **Add** | Relay P2P events between peers |
| WebSocket Client | `apps/web/src/lib/ws-client.ts` | **Modify** | Subscribe to P2P signaling events |
| TUI WS Client | `apps/tui/src/lib/ws-client.ts` | **Modify** | Subscribe to P2P signaling events (TUI stays relay-only) |

---

## 3. WebRTC Data Channel Protocol

### 3.1 STUN/TURN Configuration

```
ICE servers (configurable via env):
  STUN: stun:stun.l.google.com:19302  (default, free)
  TURN: turn:turn.nexus-chat.dev:3478 (optional, self-hosted coturn)
```

STUN works for ~85% of consumer NAT configurations. TURN is a relay fallback for the remaining 15% and can be provisioned as a self-hosted coturn instance.

### 3.2 Data Channel Configuration

```typescript
const dataChannel = peerConnection.createDataChannel("nexus-e2ee", {
  ordered: true,         // Messages must arrive in order (Signal Double Ratchet requires this)
  maxRetransmits: 3,     // Reliable delivery with bounded retransmits
  negotiated: false,     // One side creates, the other receives via "ondatachannel"
  id: 0                  // Fixed channel ID
});
```

### 3.3 Message Framing

Each P2P message is a JSON frame:

```typescript
interface P2pMessageFrame {
  type: "e2ee.message";
  clientMsgId: string;
  channelId: string;
  content: CiphertextMessageContent;  // same type as server-relayed
  timestamp: string;
}

interface P2pAckFrame {
  type: "e2ee.ack";
  clientMsgId: string;
  messageId: string;
}
```

The `clientMsgId` field allows the recipient to detect duplicates across P2P and fallback paths.

### 3.4 NAT Traversal Strategy

```
Attempt 1: Direct STUN (UDP hole-punching)
  ├── Alice gathers ICE candidates (host, srflx via STUN)
  ├── Bob gathers ICE candidates (host, srflx via STUN)
  ├── Candidates exchanged via server signaling
  └── ICE completes → P2P connection established (~85% success rate)

Attempt 2: TURN relay (optional, if configured)
  ├── Both peers fall back to TURN relay candidates
  ├── Server relays media packets via TURN
  └── Less ideal (server sees data), but ensures connectivity

Timeout: 5 seconds
  └── After 5s without ICE connection state "connected" or "completed",
      abandon P2P attempt, use server WebSocket fallback.
```

### 3.5 ICE Candidate Trickling

ICE candidates are sent incrementally ("trickled") rather than waiting for all candidates:

```typescript
peerConnection.onicecandidate = (event) => {
  if (event.candidate) {
    signalingSend("p2p.ice-candidate", {
      targetUserId: peerUserId,
      candidate: event.candidate.toJSON()
    });
  }
};
```

The remote peer calls `peerConnection.addIceCandidate()` for each received candidate.

---

## 4. Signaling Protocol (Server-Relayed)

### 4.1 Design

Signaling uses the **existing WebSocket** connection. The server acts as a **dumb relay**: it receives a signaling event from Alice, looks up Bob's active socket, and forwards the event to Bob. The server does **not parse SDP or ICE content**.

### 4.2 New WebSocket Event Types

```typescript
// Client → Server → Peer
"p2p.offer"           // Alice → Server → Bob: SDP offer
"p2p.answer"          // Bob → Server → Alice: SDP answer
"p2p.ice-candidate"   // Either → Server → Other: ICE candidate
"p2p.hangup"          // Either → Server → Other: terminate P2P

// Client → Server (informational, not forwarded)
"p2p.status"          // Client → Server: "P2P connected to <userId>" or "P2P failed, using relay"
```

### 4.3 Signaling Envelope Schema

```typescript
// Shared schemas (packages/shared/src/index.ts)
const p2pSignalingEnvelopeSchema = z.object({
  targetUserId: idSchema,
  targetDeviceId: idSchema.optional()  // for future multi-device
});

const p2pOfferSchema = p2pSignalingEnvelopeSchema.extend({
  sdp: z.string().min(1)               // SDP offer string
});

const p2pAnswerSchema = p2pSignalingEnvelopeSchema.extend({
  sdp: z.string().min(1)               // SDP answer string
});

const p2pIceCandidateSchema = p2pSignalingEnvelopeSchema.extend({
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable()
  })
});

const p2pHangupSchema = p2pSignalingEnvelopeSchema;

// Wrapped in WsEnvelope
const WsP2pOfferEnvelope = wsEnvelopeSchema.extend({
  type: z.literal("p2p.offer"),
  payload: p2pOfferSchema
});
// ... similarly for answer, ice-candidate, hangup
```

### 4.4 Server Relay Logic

```typescript
// apps/server/src/ws/gateway.ts
const P2P_EVENTS = new Set([
  "p2p.offer", "p2p.answer", "p2p.ice-candidate", "p2p.hangup"
]);

// In handleClientEnvelope:
if (P2P_EVENTS.has(envelope.type)) {
  const { targetUserId } = envelope.payload as { targetUserId: string };
  const targetSocket = [...io.sockets.sockets.values()]
    .find((s) => s.data.userId === targetUserId);
  if (targetSocket) {
    targetSocket.emit("event", {
      ...envelope,
      // Optionally add sender metadata
      _senderUserId: socket.data.userId
    });
  }
  // No ack — P2P signaling is fire-and-forget
  return { ok: true };
}
```

### 4.5 Rate Limiting for Signaling

Signaling events are subject to the same rate limiter as other WS events (50 events / 10s window per user). This prevents abuse but is unlikely to impact normal usage (a WebRTC handshake generates ~5-10 signaling events total).

---

## 5. Hybrid Send/Receive Flow

### 5.1 Send Flow (Alice → Bob)

```
sendE2eMessage(recipientUserId, plaintext):
  │
  ├── 1. Encrypt (unchanged)
  │      ciphertext = encryptForSession(session, plaintext)
  │
  ├── 2. Check P2P availability
  │      connection = connectionPool.get(recipientUserId)
  │
  ├── 3a. P2P available → direct send
  │      dataChannel.send(JSON.stringify({
  │        type: "e2ee.message",
  │        clientMsgId, channelId, content: ciphertext, timestamp
  │      }))
  │      return { path: "p2p", status: "sent" }
  │
  ├── 3b. No P2P connection → try to establish one
  │      offer = await createOffer(recipientUserId)
  │      signalingSend("p2p.offer", { targetUserId, sdp: offer })
  │      await waitForConnection(timeout: 5000ms)
  │      │
  │      ├── Connected → go to 3a
  │      │
  │      └── Timeout/NAT failure → fallback (3c)
  │
  └── 3c. Fallback to server relay (unchanged)
         socket.emit("event", {
           type: "message.send",
           payload: { workspaceId, channelId, clientMsgId, content: ciphertext }
         })
         return { path: "relay", status: "sent" }
```

### 5.2 Receive Flow (Bob receives from Alice)

```
onMessage(frame):
  │
  ├── Check if this is a P2P message or WebSocket message
  │   │
  │   ├── P2P data channel message:
  │   │   ├── 1. Parse frame
  │   │   ├── 2. Check clientMsgId dedup (against received set)
  │   │   ├── 3. decryptFromSession(session, frame.content.ciphertext)
  │   │   ├── 4. Deliver plaintext to UI
  │   │   └── 5. Send P2P ack back to sender
  │   │         dataChannel.send(JSON.stringify({
  │   │           type: "e2ee.ack", clientMsgId, messageId
  │   │         }))
  │   │         // Also POST lightweight ack to server for multi-device sync
  │   │         serverAPI.ackMessage(messageId)
  │   │
  │   └── WebSocket message (server relay):
  │       ├── Standard flow (unchanged)
  │       └── (existing message.created handler)
```

### 5.3 Ack Flow

| Path | Ack Mechanism |
|---|---|
| P2P data channel | Direct `e2ee.ack` frame over WebRTC |
| Server relay | Existing `message.ack` WS event |
| Multi-device sync | Lightweight `POST /api/v1/messages/:id/ack` to server |

### 5.4 Deduplication

`clientMsgId` is checked against a client-side LRU set (last 1000 messages) before processing any incoming ciphertext, regardless of path.

```typescript
// client-side dedup
const recentlyProcessed = new Set<string>(); // max 1000 entries

function isDuplicate(clientMsgId: string): boolean {
  if (recentlyProcessed.has(clientMsgId)) return true;
  recentlyProcessed.add(clientMsgId);
  if (recentlyProcessed.size > 1000) {
    const first = recentlyProcessed.values().next().value;
    if (first !== undefined) recentlyProcessed.delete(first);
  }
  return false;
}
```

---

## 6. Connection Lifecycle Management

### 6.1 Connection Pool

```typescript
// apps/web/src/lib/p2p/pool.ts
class P2pConnectionPool {
  private connections = new Map<string, RTCPeerConnection>();
  private dataChannels   = new Map<string, RTCDataChannel>();
  private connecting     = new Set<string>();  // in-progress connections

  has(userId: string): boolean;
  getChannel(userId: string): RTCDataChannel | undefined;
  createOffer(peerUserId: string): Promise<RTCSessionDescription>;
  handleAnswer(peerUserId: string, sdp: string): Promise<void>;
  handleIceCandidate(peerUserId: string, candidate: RTCIceCandidate): Promise<void>;
  close(userId: string): void;
  closeAll(): void;
}
```

### 6.2 Connection Establishment (Alice initiates)

```
Alice connects to Bob:
  
  1. Alice creates RTCPeerConnection with STUN/TURN config
  2. Alice creates data channel "nexus-e2ee"
  3. Alice creates SDP offer via peerConnection.createOffer()
  4. Alice sets local description, waits for ICE gathering
  5. Alice sends offer to Bob via server signaling (p2p.offer)
  
  ... (signaling relayed by server) ...
  
  6. Bob receives offer
  7. Bob creates RTCPeerConnection
  8. Bob sets remote description (Alice's offer)
  9. Bob creates SDP answer via peerConnection.createAnswer()
  10. Bob sets local description
  11. Bob sends answer to Alice via server signaling (p2p.answer)
  
  12. Both sides exchange ICE candidates via p2p.ice-candidate
  13. ICE connection state → "connected" or "completed"
  14. Data channel opens → P2P ready
  15. Both clients emit "p2p.status" to server: "connected"
```

### 6.3 Connection Teardown

```
Disconnect:
  1. Initiating side sends "p2p.hangup" to peer via signaling
  2. Initiating side calls peerConnection.close()
  3. Peer receives "p2p.hangup" → peerConnection.close()
  4. Both sides remove connection from pool
  5. Both clients emit "p2p.status": "disconnected"
```

### 6.4 Keepalive & Reconnection

- **WebRTC keepalive**: ICE consent freshness (built-in, ~15s interval)
- **Data channel close detection**: `ondatachannel.onclose` → remove from pool, emit `p2p.status`
- **Reconnection**: if a P2P message fails to send (data channel closed or closing), the send function automatically falls back to server relay for that message. On next send attempt, a new WebRTC connection is established.

### 6.5 Browser Tab / Electron Window Lifecycle

| Event | Action |
|---|---|
| Tab close / window close | `connectionPool.closeAll()`, emit `p2p.status: disconnected` for each peer |
| Page refresh | Same as tab close |
| Network change (offline → online) | All WebRTC connections dropped; pool is cleared; new connections on next message |
| Sleep/wake | ICE consent failure → `iceConnectionState → "disconnected"` → pool entry removed |

---

## 7. Fallback Strategy

### 7.1 Decision Matrix

| Scenario | Action |
|---|---|
| P2P connection exists and `readyState === "open"` | Send via WebRTC data channel |
| P2P connection in progress (`connecting` state) | Queue message (up to 2s); if connection succeeds, send via WebRTC; if timeout, fall back |
| No P2P connection, first message | Initiate WebRTC + `createOffer`; apply 5s timeout for ICE to complete |
| WebRTC failed (timeout / NAT / TURN unavailable) | Send via server WebSocket; mark peer as "relay-preferred" for 30s |
| Data channel closed unexpectedly | Fall back to server relay for current message; mark peer for reconnect on next message |
| TUI / non-browser client | Always use server relay (no WebRTC support) |

### 7.2 Relay-Preferred Cooldown

If a WebRTC connection attempt fails, the peer is marked with a 30-second cooldown. During this period, messages go directly through server relay without attempting P2P. This prevents repeated connection attempts when the network condition hasn't changed.

```typescript
interface PeerTransportState {
  mode: "p2p" | "relay";
  p2pFailedAt?: number;        // timestamp of last failure
  cooldownUntil?: number;      // timestamp when to retry P2P
}

const RELAY_COOLDOWN_MS = 30_000;
```

### 7.3 User-Visible Indicators (Optional)

| State | UI Indicator |
|---|---|
| P2P connected | Lock icon color: green |
| P2P in progress | Lock icon color: yellow (connecting animation) |
| Server relay (fallback) | Lock icon color: gray |
| Server relay (cooldown) | Lock icon color: gray + tooltip: "Direct connection unavailable, using secure relay" |

This is optional for Phase 1; the MVP can be transparent to users.

---

## 8. Schema & Event Changes

### 8.1 Shared Schemas (`packages/shared/src/index.ts`)

Add following schemas after the existing WebSocket event schemas (~line 360):

```typescript
// ── P2P Signaling Schemas ──

export const p2pTargetSchema = z.object({
  targetUserId: idSchema,
  targetDeviceId: idSchema.optional()
});

export const p2pOfferSchema = p2pTargetSchema.extend({
  sdp: z.string().min(1)
});

export const p2pAnswerSchema = p2pTargetSchema.extend({
  sdp: z.string().min(1)
});

export const p2pIceCandidateSchema = p2pTargetSchema.extend({
  candidate: z.object({
    candidate: z.string().min(1),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable()
  })
});

export const p2pHangupSchema = p2pTargetSchema;

export const p2pStatusSchema = p2pTargetSchema.extend({
  status: z.enum(["connected", "disconnected", "failed"]),
  reason: z.string().optional()
});

// ── WsEnvelope Extensions ──

export const WsP2pOfferEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.offer"),
  payload: p2pOfferSchema
});

export const WsP2pAnswerEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.answer"),
  payload: p2pAnswerSchema
});

export const WsP2pIceCandidateEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.ice-candidate"),
  payload: p2pIceCandidateSchema
});

export const WsP2pHangupEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.hangup"),
  payload: p2pHangupSchema
});

export const WsP2pStatusEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.status"),
  payload: p2pStatusSchema
});

// ── Type exports ──
export type P2pOffer = z.infer<typeof p2pOfferSchema>;
export type P2pAnswer = z.infer<typeof p2pAnswerSchema>;
export type P2pIceCandidate = z.infer<typeof p2pIceCandidateSchema>;
export type P2pHangup = z.infer<typeof p2pHangupSchema>;
export type P2pStatus = z.infer<typeof p2pStatusSchema>;
```

### 8.2 WsClientEvent / WsServerEvent Union Extension

Add to the existing WsClientEvent and WsServerEvent discriminated unions:

```typescript
// WsClientEvent additions
"p2p.offer"
"p2p.answer"
"p2p.ice-candidate"
"p2p.hangup"
"p2p.status"
```

These events flow in both directions (client → server → client), so they are part of both unions.

### 8.3 ICE Server Configuration (env)

```bash
# .env.example additions
NEXUS_STUN_SERVERS="stun:stun.l.google.com:19302"
NEXUS_TURN_SERVERS=""  # optional, e.g. "turn:turn.example.com:3478?transport=udp"
NEXUS_TURN_USERNAME=""  # optional
NEXUS_TURN_CREDENTIAL="" # optional

# Client-side P2P config
NEXUS_P2P_CONNECTION_TIMEOUT_MS=5000
NEXUS_P2P_RELAY_COOLDOWN_MS=30000
```

---

## 9. Client Architecture

### 9.1 New Directory Structure

```
apps/web/src/lib/p2p/
  ├── pool.ts          # P2pConnectionPool class
  ├── transport.ts     # HybridTransport: send/receive with path selection
  ├── signaling.ts     # Signaling handler: listen on WS for p2p.* events
  └── types.ts         # P2P-specific types (not shared with server)

apps/tui/src/          # TUI: no p2p/ directory (relay-only)
```

### 9.2 Transport Manager API

```typescript
// apps/web/src/lib/p2p/transport.ts
class HybridTransport {
  constructor(
    private session: SignalSession,
    private connectionPool: P2pConnectionPool,
    private wsSend: (event: string, payload: unknown) => Promise<unknown>
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendResult>;
  onMessage(handler: (message: DecryptedMessage) => void): void;
  destroy(): void;
}

interface SendResult {
  ok: boolean;
  path: "p2p" | "relay";
  messageId?: string;
  error?: Error;
}
```

### 9.3 Integration with Existing E2EE Flow

The `HybridTransport` replaces the direct `socket.emit("event", ...)` call in the current E2EE send path. The Signal encryption layer (`encryptForSession`) is called **before** the transport decision — it always runs, regardless of path.

```
Current (server-relay only):
  encryptForSession → socket.emit("event", { type: "message.send", ... })

New (hybrid):
  encryptForSession → hybridTransport.sendMessage(input)
    ├── P2P available → dataChannel.send(frame)
    └── Relay fallback → socket.emit("event", { type: "message.send", ... })
```

### 9.4 Non-Browser Clients (TUI)

The TUI client (`apps/tui/`) remains **relay-only**. It does not import `p2p/` code and always uses the existing `sendMessage` via WebSocket. The TUI's `packages/signal` integration is unchanged.

The Electron client can also remain relay-only initially; P2P can be added to Electron later since it has native `RTCPeerConnection`.

---

## 10. Server Architecture

### 10.1 Changes to `apps/server/src/ws/gateway.ts`

Add a signaling relay function:

```typescript
const P2P_FORWARD_EVENTS = new Set([
  "p2p.offer", "p2p.answer", "p2p.ice-candidate", "p2p.hangup"
]);

function relayP2pEvent(
  io: Server,
  fromSocket: Socket,
  envelope: { type: string; payload: { targetUserId: string } }
): boolean {
  if (!P2P_FORWARD_EVENTS.has(envelope.type)) return false;

  const targetUserId = envelope.payload.targetUserId;
  const targetSocket = findSocketByUserId(io, targetUserId);

  if (targetSocket) {
    targetSocket.emit("event", {
      ...envelope,
      _senderUserId: fromSocket.data.userId
    });
  }
  // Silently drop if target is offline (they'll reconnect and get history)

  return true;
}
```

### 10.2 No Server Storage of Signaling Data

The server does not:
- Store SDP offers/answers
- Store ICE candidates
- Cache or retry signaling events
- Parse or validate SDP/ICE content beyond schema validation

### 10.3 Handling `p2p.status` Events

`p2p.status` events are informational only. The server may log them for observability but does not act on them.

```typescript
if (envelope.type === "p2p.status") {
  logger.info({
    userId: socket.data.userId,
    peerUserId: envelope.payload.targetUserId,
    status: envelope.payload.status,
    reason: envelope.payload.reason
  }, "p2p.status");
  return { ok: true };
}
```

---

## 11. Security Considerations

### 11.1 Threat Model Additions

| Threat | Mitigation |
|---|---|
| Malicious signaling (fake offer from impersonator) | Server enforces: `fromSocket.data.userId` is the authenticated user. Receiver validates `_senderUserId` matches expected peer. |
| Signaling eavesdropping | SDP/ICE are sent over the existing JWT-authenticated WebSocket (same as all other traffic). WebSocket is WSS (TLS). |
| WebRTC encryption | WebRTC Data Channels are DTLS-SRTP encrypted by default. All P2P data is double-encrypted: DTLS (transport) + Signal (application). |
| TURN server data exposure | If using TURN, the TURN server relays raw UDP packets. However, the application payload is already Signal-encrypted ciphertext — TURN sees only encrypted bytes. |
| Signaling amplification / DoS | Existing per-user rate limiter applies to signaling events (50 events/10s). |
| Connection exhaustion | Pool limits to one connection per peer. `maxRetransmits: 3` prevents infinite retry loops. |

### 11.2 Double Encryption

P2P messages benefit from **two layers of encryption**:

1. **DTLS (WebRTC transport)**: All data channel traffic is encrypted at the transport layer using DTLS-SRTP with per-session keys.
2. **Signal Protocol (application)**: The ciphertext carried over the data channel is encrypted with Signal Double Ratchet keys.

This means even if WebRTC encryption were somehow compromised, the application-layer ciphertext remains protected by Signal.

### 11.3 Metadata Leakage Comparison

| Metadata | Server-Relayed (current) | P2P (new) |
|---|---|---|
| Who sent the message | Server knows | Server does NOT know (no server involvement) |
| Who received the message | Server knows | Server does NOT know |
| Message timestamp | Server knows | Server does NOT know |
| Message size | Server knows (ciphertext size) | Server does NOT know |
| Ciphertext bytes | Server stores (for relay) | Server does NOT see |
| P2P connection attempt | N/A | Server sees signaling events (offer/answer) |
| That two users communicated | Server knows (every message) | Server knows only that a P2P connection was attempted |

**Key insight**: P2P eliminates the server's ability to observe message content and timing. The server still knows that two users established a P2P connection (via signaling), but not what they said, when, or how many messages were exchanged.

---

## 12. Testing Strategy

### 12.1 Unit Tests

| Test | File | Description |
|---|---|---|
| P2P schema validation | `packages/shared/src/index.test.ts` | All P2P schemas parse valid data, reject invalid |
| Connection pool lifecycle | `apps/web/src/lib/p2p/pool.test.ts` | Create, get, close connections |
| Hybrid transport path selection | `apps/web/src/lib/p2p/transport.test.ts` | Route selection based on pool state |
| Deduplication | `apps/web/src/lib/p2p/transport.test.ts` | clientMsgId dedup across P2P and relay |
| Fallback on failure | `apps/web/src/lib/p2p/transport.test.ts` | Relay fallback when P2P unavailable |
| Cooldown logic | `apps/web/src/lib/p2p/pool.test.ts` | 30s cooldown after failed attempt |

### 12.2 Integration Tests

| Test | Description |
|---|---|
| Signaling relay | Alice sends `p2p.offer`; Bob's socket receives it; verify SDP intact |
| Full WebRTC handshake (browser) | Two client instances; establish WebRTC; send ciphertext; decrypt |
| Fallback test | Simulate blocked WebRTC (no STUN reachable); verify message delivered via relay |
| Mixed mode | Alice on P2P, Bob's second device on relay; both receive message |
| Connection teardown | Verify pool cleanup on disconnect |

### 12.3 Smoke Test Addition

Add `p2p-smoke` command to the TUI:

```typescript
// apps/tui/src/commands/smoke.ts
export const runP2pSmoke = async () => {
  // Verify P2P schemas are loadable
  // Verify server accepts p2p.offer and relays to target
  // Verify p2p.status is accepted by server
  console.log("p2p smoke ok");
};
```

---

## 13. Dependencies & Tools

### 13.1 No New Runtime Dependencies

WebRTC is a **browser-native API** (`RTCPeerConnection`, `RTCDataChannel`). No npm packages are required for the core WebRTC functionality.

### 13.2 Optional / Dev Dependencies

| Package | Purpose | Required? |
|---|---|---|
| `@types/webrtc` | TypeScript types for WebRTC APIs | Dev only |
| `coturn` (system) | Self-hosted TURN server for production | Optional (STUN-only works for ~85% of users) |

### 13.3 Browser Compatibility

| Browser | RTCPeerConnection | RTCDataChannel | Notes |
|---|---|---|---|
| Chrome 130+ | ✓ | ✓ | Full support |
| Firefox 130+ | ✓ | ✓ | Full support |
| Safari 18+ | ✓ | ✓ | Requires user gesture for some operations |
| Electron 39+ | ✓ | ✓ | Equivalent to Chrome 130+ |

---

> **Next**: [Phase 1 — P2P DM Direct Connection Task Breakdown](../tasks/18-phase-1-p2p-dm-direct.md)
