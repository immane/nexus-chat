/**
 * P2P Signaling (Socket.IO Relay)
 *
 * Provides two functions for WebRTC signaling via the server WebSocket:
 * - subscribeSignaling: listens for p2p.* events and dispatches to a handler
 * - sendP2pEvent: emits a p2p.* event to the server for relaying
 *
 * The server acts as a signaling relay — it forwards p2p.offer, p2p.answer,
 * p2p.ice-candidate, and p2p.hangup messages between peers without inspecting
 * their content.
 *
 * Design Decision:
 * We filter to only p2p.* event types in subscribeSignaling (rather than
 * setting up a separate socket namespace) because the same Socket.IO connection
 * carries both chat events and P2P signaling. This avoids a second WebSocket
 * connection per client.
 *
 * Related Modules:
 * - pool.ts: uses sendP2pEvent to emit offers/answers/ICE candidates
 * - transport.ts: subscribes to signaling and wires it to the pool
 * - ws/socket.ts (server): relays p2p.* events between peers
 */
import type { Socket } from "socket.io-client";

type SignalingHandler = (type: string, fromUserId: string, payload: Record<string, unknown>) => void;

export const subscribeSignaling = (socket: Socket, handler: SignalingHandler): () => void => {
  const onEvent = (event: { type: string; payload: Record<string, unknown>; _senderUserId?: string }) => {
    const p2pTypes = ["p2p.offer", "p2p.answer", "p2p.ice-candidate", "p2p.hangup", "p2p.status"];
    if (!p2pTypes.includes(event.type)) return;

    const senderUserId = typeof event._senderUserId === "string" ? event._senderUserId : undefined;
    if (!senderUserId) return;

    handler(event.type, senderUserId, event.payload);
  };

  socket.on("event", onEvent as (...args: unknown[]) => void);

  return () => {
    socket.off("event", onEvent as (...args: unknown[]) => void);
  };
};

export const sendP2pEvent = (socket: Socket, type: string, payload: unknown): void => {
  socket.emit("event", { type, payload, timestamp: new Date().toISOString(), encrypted: false });
};
