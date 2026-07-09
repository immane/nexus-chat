/**
 * Hybrid P2P/Relay Transport for E2EE Messages
 *
 * Implements a P2P-first, relay-fallback delivery strategy for 1:1 E2E DMs.
 *
 * Flow:
 * 1. Check if an open P2P DataChannel exists → send directly (P2P path)
 * 2. If no channel exists and not in cooldown → initiate WebRTC handshake,
 *    wait up to P2P_CONNECTION_TIMEOUT_MS, then send via P2P
 * 3. If P2P fails, in cooldown, or timed out → send via server relay (WS)
 *
 * Incoming messages are received via either:
 * - P2P DataChannel (handleIncomingP2pMessage) — > decrypted client-side
 * - Server WebSocket event (message.created) — > already decrypted by ChatRoute
 *
 * Deduplication:
 * Recently processed clientMsgIds are tracked (up to 1000) to avoid
 * processing the same message twice when both P2P and relay deliver it.
 *
 * Related Modules:
 * - pool.ts: P2pConnectionPool (RTCPeerConnection lifecycle)
 * - signaling.ts: Socket.IO signaling relay
 * - types.ts: P2pMessageFrame, P2pAckFrame
 * - ChatRoute.tsx: owns the HybridTransport instance
 */
import type { Socket } from "socket.io-client";
import type { P2pConnectionPool } from "./pool.js";
import { sendP2pEvent, subscribeSignaling } from "./signaling.js";
import type { P2pMessageFrame, P2pAckFrame } from "./types.js";
import { P2P_CONNECTION_TIMEOUT_MS } from "./types.js";

type WsSend = (event: string, payload: unknown) => Promise<unknown>;
type E2eTransportContent = { type: "ciphertext"; ciphertext: string; algorithm: string; senderDeviceId: string; readOnce?: boolean; expiresAt?: string; attachments: Array<{ fileId: string; name: string; mimeType: string; size: number; scanStatus: string }> };
type MessageHandler = (message: { content: E2eTransportContent; senderId: string; workspaceId: string; channelId: string; clientMsgId: string; id: string; timestamp: string }) => void;

export class HybridTransport {
  private unsubscribe: (() => void) | null = null;
  // Dedup incoming P2P messages by clientMsgId. Capped at 1000 entries to
  // bound memory usage in long-lived sessions. Oldest entry is evicted on
  // overflow (FIFO via Set iteration order).
  private recentlyProcessed = new Set<string>();

  constructor(
    private pool: P2pConnectionPool,
    private socket: Socket,
    private wsSend: WsSend,
    private onMessage: MessageHandler
  ) {
    this.pool.onDataChannelMessage = this.handleIncomingP2pMessage;
    this.unsubscribe = subscribeSignaling(socket, this.handleSignaling);
  }

  async sendMessage(input: {
    workspaceId: string;
    channelId: string;
    clientMsgId: string;
    content: E2eTransportContent;
    targetUserId: string;
  }): Promise<{ ok: boolean; path: "p2p" | "relay"; data?: unknown; error?: { code: string; message: string } }> {
    const dc = this.pool.getChannel(input.targetUserId);

    if (dc && dc.readyState === "open") {
      const result = this.sendViaP2p(dc, input);
      if (result.ok) return result;
      this.pool.markFailed(input.targetUserId);
      return this.sendViaRelay(input);
    }

    if (!this.pool.isInCooldown(input.targetUserId)) {
      try {
        const offer = await this.pool.createOffer(input.targetUserId);
        if (offer?.sdp) {
          sendP2pEvent(this.socket, "p2p.offer", { targetUserId: input.targetUserId, sdp: offer.sdp });
        }
        await this.waitForConnection(input.targetUserId, P2P_CONNECTION_TIMEOUT_MS);
        const newDc = this.pool.getChannel(input.targetUserId);
        if (newDc && newDc.readyState === "open") {
          const result = this.sendViaP2p(newDc, input);
          if (result.ok) return result;
          this.pool.markFailed(input.targetUserId);
        }
      } catch {
        this.pool.markFailed(input.targetUserId);
      }
    }

    return this.sendViaRelay(input);
  }

  private sendViaP2p(dc: RTCDataChannel, input: {
    workspaceId: string;
    channelId: string;
    clientMsgId: string;
    content: E2eTransportContent;
  }): { ok: boolean; path: "p2p"; data?: unknown } {
    const frame: P2pMessageFrame = {
      type: "e2ee.message",
      clientMsgId: input.clientMsgId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      content: input.content,
      timestamp: new Date().toISOString()
    };
    try {
      dc.send(JSON.stringify(frame));
      return { ok: true, path: "p2p", data: { clientMsgId: input.clientMsgId } };
    } catch {
      return { ok: false, path: "p2p", data: undefined };
    }
  }

  private async sendViaRelay(input: {
    workspaceId: string;
    channelId: string;
    clientMsgId: string;
    content: E2eTransportContent;
  }): Promise<{ ok: boolean; path: "relay"; data?: unknown }> {
    const response = await this.wsSend("event", {
      type: "message.send",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      payload: input,
      timestamp: new Date().toISOString(),
      encrypted: false
    });
    const r = response as { ok: boolean; data?: unknown };
    return { ok: r.ok, path: "relay", data: r.data };
  }

  private handleSignaling = (type: string, fromUserId: string, payload: Record<string, unknown>): void => {
    switch (type) {
      case "p2p.offer": {
        const sdp = typeof payload.sdp === "string" ? payload.sdp : "";
        if (!sdp) return;
        this.pool.handleOffer(fromUserId, sdp).then((answer) => {
          if (answer?.sdp) {
            sendP2pEvent(this.socket, "p2p.answer", { targetUserId: fromUserId, sdp: answer.sdp });
          }
        });
        break;
      }
      case "p2p.answer": {
        const sdp = typeof payload.sdp === "string" ? payload.sdp : "";
        if (sdp) this.pool.handleAnswer(fromUserId, sdp);
        break;
      }
      case "p2p.ice-candidate":
        if (payload.candidate && typeof payload.candidate === "object") {
          this.pool.handleIceCandidate(fromUserId, payload.candidate as RTCIceCandidateInit);
        }
        break;
      case "p2p.hangup":
        this.pool.close(fromUserId);
        break;
    }
  };

  private waitForConnection(peerUserId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = (): void => {
        const dc = this.pool.getChannel(peerUserId);
        if (dc && dc.readyState === "open") return resolve();
        if (Date.now() - start >= timeoutMs) return reject(new Error("P2P connection timeout"));
        setTimeout(check, 100);
      };
      check();
    });
  }

  handleIncomingP2pMessage = (peerUserId: string, data: string): void => {
    try {
      const frame = JSON.parse(data) as P2pMessageFrame | P2pAckFrame;

      if (frame.type === "e2ee.ack") {
        return;
      }

      if (frame.type === "e2ee.message") {
        if (this.recentlyProcessed.has(frame.clientMsgId)) return;
        this.recentlyProcessed.add(frame.clientMsgId);
        if (this.recentlyProcessed.size > 1000) {
          const first = this.recentlyProcessed.values().next().value;
          if (first !== undefined) this.recentlyProcessed.delete(first);
        }

        this.onMessage({
          content: frame.content,
          senderId: peerUserId,
          workspaceId: frame.workspaceId,
          channelId: frame.channelId,
          clientMsgId: frame.clientMsgId,
          id: frame.clientMsgId,
          timestamp: frame.timestamp
        });

        const dc = this.pool.getChannel(peerUserId);
        if (dc && dc.readyState === "open") {
          const ack: P2pAckFrame = { type: "e2ee.ack", clientMsgId: frame.clientMsgId, messageId: frame.clientMsgId };
          try { dc.send(JSON.stringify(ack)); } catch { /* best-effort */ }
        }
      }
    } catch {
      // Ignore malformed P2P messages
    }
  };

  destroy(): void {
    this.unsubscribe?.();
    if (this.pool.onDataChannelMessage === this.handleIncomingP2pMessage) delete this.pool.onDataChannelMessage;
    this.pool.closeAll();
    this.recentlyProcessed.clear();
  }
}
