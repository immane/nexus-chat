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
