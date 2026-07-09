/**
 * P2P Connection Pool
 *
 * Manages RTCPeerConnection and RTCDataChannel instances per peer user.
 * Responsible for:
 * - Creating offers and answers for WebRTC handshake
 * - Handling ICE candidate exchange
 * - Managing data channel lifecycle (open/close/error)
 * - Tracking transport state (p2p vs relay, cooldown after failure)
 *
 * Key Design Decisions:
 * - Data channel uses ordered delivery with maxRetransmits: 3.
 *   This gives some reliability without TCP-like head-of-line blocking.
 * - After a P2P failure, the peer enters a 30-second cooldown (P2P_RELAY_COOLDOWN_MS)
 *   to avoid repeated connection attempts that are likely to fail.
 * - onDataChannelMessage is a callback set by HybridTransport to process
 *   incoming E2EE messages without tight coupling.
 *
 * Does NOT:
 * - Handle signaling transport (caller passes a SignalingSender callback)
 * - Encrypt or decrypt message content (delegated to @nexus-chat/signal)
 *
 * Invariants:
 * - One RTCPeerConnection per peer userId (calling createOffer twice closes the old one)
 * - Data channel must be in "open" readyState before it can send
 */
import { buildRtcConfiguration } from "./config.js";
import type { PeerTransportState } from "./types.js";
import { P2P_RELAY_COOLDOWN_MS } from "./types.js";

type SignalingSender = (type: string, payload: unknown) => void;

export class P2pConnectionPool {
  private connections = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  private peerStates = new Map<string, PeerTransportState>();

  onDataChannelMessage?: (peerUserId: string, data: string) => void;

  constructor(private signalingSend: SignalingSender) {}

  has(peerUserId: string): boolean {
    const dc = this.dataChannels.get(peerUserId);
    return dc !== undefined && dc.readyState === "open";
  }

  getChannel(peerUserId: string): RTCDataChannel | undefined {
    const dc = this.dataChannels.get(peerUserId);
    return dc && dc.readyState === "open" ? dc : undefined;
  }

  isInCooldown(userId: string): boolean {
    const state = this.peerStates.get(userId);
    if (!state?.p2pFailedAt) return false;
    return Date.now() - state.p2pFailedAt < P2P_RELAY_COOLDOWN_MS;
  }

  markFailed(userId: string): void {
    this.peerStates.set(userId, { mode: "relay", p2pFailedAt: Date.now() });
  }

  async createOffer(peerUserId: string): Promise<RTCSessionDescriptionInit | null> {
    try {
      this.close(peerUserId);

      const pc = new RTCPeerConnection(buildRtcConfiguration());
      this.connections.set(peerUserId, pc);

      const dc = pc.createDataChannel("nexus-e2ee", {
        ordered: true,
        maxRetransmits: 3
      });
      this.dataChannels.set(peerUserId, dc);
      this.setupDataChannelHandlers(dc, peerUserId);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signalingSend("p2p.ice-candidate", {
            targetUserId: peerUserId,
            candidate: event.candidate.toJSON()
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          this.markFailed(peerUserId);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      return pc.localDescription?.toJSON() ?? null;
    } catch {
      this.markFailed(peerUserId);
      return null;
    }
  }

  async handleAnswer(peerUserId: string, sdp: string): Promise<void> {
    const pc = this.connections.get(peerUserId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
    } catch {
      this.markFailed(peerUserId);
    }
  }

  async handleOffer(peerUserId: string, sdp: string): Promise<RTCSessionDescriptionInit | null> {
    try {
      this.close(peerUserId);

      const pc = new RTCPeerConnection(buildRtcConfiguration());
      this.connections.set(peerUserId, pc);

      pc.ondatachannel = (event) => {
        this.dataChannels.set(peerUserId, event.channel);
        this.setupDataChannelHandlers(event.channel, peerUserId);
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.signalingSend("p2p.ice-candidate", {
            targetUserId: peerUserId,
            candidate: event.candidate.toJSON()
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          this.markFailed(peerUserId);
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      return pc.localDescription?.toJSON() ?? null;
    } catch {
      this.markFailed(peerUserId);
      return null;
    }
  }

  async handleIceCandidate(peerUserId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.connections.get(peerUserId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // Ignore invalid candidates
    }
  }

  close(peerUserId: string): void {
    const dc = this.dataChannels.get(peerUserId);
    if (dc) {
      try { dc.close(); } catch { /* ignore */ }
      this.dataChannels.delete(peerUserId);
    }

    const pc = this.connections.get(peerUserId);
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      this.connections.delete(peerUserId);
    }
  }

  closeAll(): void {
    for (const userId of this.connections.keys()) this.close(userId);
    this.connections.clear();
    this.dataChannels.clear();
    this.peerStates.clear();
  }

  private setupDataChannelHandlers(dc: RTCDataChannel, peerUserId: string): void {
    dc.onopen = () => {
      this.peerStates.set(peerUserId, { mode: "p2p" });
      this.signalingSend("p2p.status", { targetUserId: peerUserId, status: "connected" });
    };

    dc.onclose = () => {
      this.dataChannels.delete(peerUserId);
      this.peerStates.set(peerUserId, { mode: "relay" });
      this.signalingSend("p2p.status", { targetUserId: peerUserId, status: "disconnected" });
    };

    dc.onerror = () => {
      this.markFailed(peerUserId);
    };

    dc.onmessage = (event) => {
      if (this.onDataChannelMessage) {
        this.onDataChannelMessage(peerUserId, event.data as string);
      }
    };
  }
}
