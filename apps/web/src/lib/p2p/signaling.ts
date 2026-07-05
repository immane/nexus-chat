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
