import type { Socket } from "socket.io-client";
import { describe, expect, it, vi } from "vitest";
import type { P2pConnectionPool } from "./pool.js";
import { HybridTransport } from "./transport.js";

type EventHandler = (event: unknown) => void;

class FakeSocket {
  handlers = new Map<string, EventHandler>();
  emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, handler: EventHandler) {
    this.handlers.set(event, handler);
    return this;
  }

  off(event: string) {
    this.handlers.delete(event);
    return this;
  }

  emit(event: string, payload: unknown) {
    this.emitted.push({ event, payload });
    return this;
  }
}

class FakeDataChannel {
  readyState = "open";
  sent: string[] = [];
  shouldThrow = false;

  send(data: string) {
    if (this.shouldThrow) throw new Error("send failed");
    this.sent.push(data);
  }
}

class FakePool {
  onDataChannelMessage?: (peerUserId: string, data: string) => void;
  channel: RTCDataChannel | undefined;
  cooldown = false;
  createOfferCalls = 0;
  markFailedCalls = 0;
  closeAllCalls = 0;

  getChannel() {
    return this.channel;
  }

  isInCooldown() {
    return this.cooldown;
  }

  async createOffer() {
    this.createOfferCalls += 1;
    return null;
  }

  markFailed() {
    this.markFailedCalls += 1;
  }

  async handleOffer() {
    return null;
  }

  async handleAnswer() {}

  async handleIceCandidate() {}

  close() {}

  closeAll() {
    this.closeAllCalls += 1;
  }
}

const createTransport = (pool: FakePool, onMessage = vi.fn()) => {
  const socket = new FakeSocket();
  const wsSend = vi.fn().mockResolvedValue({ ok: true, data: { id: "relay-message-1" } });
  const transport = new HybridTransport(pool as unknown as P2pConnectionPool, socket as unknown as Socket, wsSend, onMessage);
  return { transport, socket, wsSend, onMessage };
};

const ciphertextInput = {
  workspaceId: "workspace-1",
  channelId: "channel-1",
  clientMsgId: "client-1",
  targetUserId: "peer-user-1",
  content: { type: "ciphertext" as const, ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", attachments: [] }
};

describe("HybridTransport", () => {
  it("sends through an open P2P data channel", async () => {
    const pool = new FakePool();
    const dc = new FakeDataChannel();
    pool.channel = dc as unknown as RTCDataChannel;
    const { transport, wsSend } = createTransport(pool);

    const result = await transport.sendMessage(ciphertextInput);

    expect(result).toMatchObject({ ok: true, path: "p2p" });
    expect(dc.sent).toHaveLength(1);
    expect(JSON.parse(dc.sent[0] ?? "{}")).toMatchObject({ type: "e2ee.message", clientMsgId: "client-1" });
    expect(wsSend).not.toHaveBeenCalled();
  });

  it("falls back to server relay if P2P send throws", async () => {
    const pool = new FakePool();
    const dc = new FakeDataChannel();
    dc.shouldThrow = true;
    pool.channel = dc as unknown as RTCDataChannel;
    const { transport, wsSend } = createTransport(pool);

    const result = await transport.sendMessage(ciphertextInput);

    expect(result).toMatchObject({ ok: true, path: "relay" });
    expect(pool.markFailedCalls).toBe(1);
    expect(wsSend).toHaveBeenCalledTimes(1);
  });

  it("skips P2P setup during relay cooldown", async () => {
    const pool = new FakePool();
    pool.cooldown = true;
    const { transport, wsSend } = createTransport(pool);

    const result = await transport.sendMessage(ciphertextInput);

    expect(result).toMatchObject({ ok: true, path: "relay" });
    expect(pool.createOfferCalls).toBe(0);
    expect(wsSend).toHaveBeenCalledTimes(1);
  });

  it("wires incoming data channel messages and deduplicates clientMsgId", () => {
    const pool = new FakePool();
    const onMessage = vi.fn();
    createTransport(pool, onMessage);
    const frame = JSON.stringify({
      type: "e2ee.message",
      clientMsgId: "p2p-client-1",
      channelId: "channel-1",
      content: { type: "ciphertext", ciphertext: "abc", algorithm: "signal-v1", senderDeviceId: "device-1", attachments: [] },
      timestamp: new Date().toISOString()
    });

    pool.onDataChannelMessage?.("peer-user-1", frame);
    pool.onDataChannelMessage?.("peer-user-1", frame);

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ senderId: "peer-user-1", clientMsgId: "p2p-client-1" }));
  });

  it("cleans up subscriptions and connection pool", () => {
    const pool = new FakePool();
    const { transport, socket } = createTransport(pool);

    transport.destroy();

    expect(socket.handlers.has("event")).toBe(false);
    expect(pool.closeAllCalls).toBe(1);
  });
});
