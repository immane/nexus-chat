/**
 * useReadReceipts — Visible Message Acknowledgment
 *
 * Tracks which message IDs have been acknowledged and sends
 * "message.ack" events for newly visible messages.
 *
 * Key Design:
 * - ackedMessagesRef prevents duplicate acks for the same message
 * - handleMessagesVisible is called by MessageList via onMessagesVisible
 *   with a batched list of visible message IDs (debounced 500ms)
 * - The actual ack goes through the WebSocket (message.ack envelope),
 *   not the REST API, because read receipts are ephemeral and high-frequency.
 *
 * Does NOT:
 * - Track read receipts from other users (handled by ChatRoute WS event listener)
 * - Persist ack state across page reloads
 */
import { useRef, useState, type RefObject } from "react";
import type { Socket } from "socket.io-client";

export const useReadReceipts = (socketRef: RefObject<Socket | undefined>) => {
  const ackedMessagesRef = useRef(new Set<string>());
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});

  const handleMessagesVisible = (messageIds: string[]) => {
    if (!socketRef.current?.connected) return;
    for (const id of messageIds) {
      if (ackedMessagesRef.current.has(id)) continue;
      ackedMessagesRef.current.add(id);
      socketRef.current.emit("event", {
        type: "message.ack",
        payload: { messageId: id },
        timestamp: new Date().toISOString()
      });
    }
  };

  return { handleMessagesVisible, readReceipts, setReadReceipts };
};
