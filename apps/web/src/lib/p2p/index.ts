/**
 * P2P Module Index
 *
 * Exports the public P2P API:
 * - P2pConnectionPool: manages RTCPeerConnection lifecycle per peer
 * - HybridTransport: P2P-first with relay fallback transport for E2EE messages
 * - subscribeSignaling/sendP2pEvent: Socket.IO signaling helpers
 * - Config, types, and constants
 *
 * Architecture:
 * P2P is used ONLY for 1:1 E2E DMs. Normal channels and relay-mode DMs
 * go through the server WebSocket. The HybridTransport tries P2P first,
 * then falls back to server relay if P2P fails or is in cooldown.
 */
export { P2pConnectionPool } from "./pool.js";
export { subscribeSignaling, sendP2pEvent } from "./signaling.js";
export { HybridTransport } from "./transport.js";
export type { IceServerConfig, PeerTransportState, P2pMessageFrame, P2pAckFrame } from "./types.js";
export { P2P_RELAY_COOLDOWN_MS, P2P_CONNECTION_TIMEOUT_MS } from "./types.js";
export { getIceServerConfig, buildRtcConfiguration } from "./config.js";
