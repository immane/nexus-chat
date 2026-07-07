import { useRef, useState, type RefObject } from "react";
import type { Channel } from "@nexus-chat/shared";
import type { Socket } from "socket.io-client";

export const useTyping = ({
  activeChannel,
  setDraft,
  socketRef,
  userId
}: {
  activeChannel: Channel | undefined;
  setDraft: (draft: string) => void;
  socketRef: RefObject<Socket | undefined>;
  userId: string | undefined;
}) => {
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isTypingRef = useRef(false);

  const emitTyping = (typing: boolean) => {
    if (!socketRef.current?.connected || !activeChannel || !userId) return;
    socketRef.current.emit("event", {
      type: typing ? "typing.start" : "typing.stop",
      workspaceId: activeChannel.workspaceId,
      channelId: activeChannel.id,
      payload: { workspaceId: activeChannel.workspaceId, channelId: activeChannel.id },
      timestamp: new Date().toISOString()
    });
  };

  const stopTyping = () => {
    if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = undefined; }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      emitTyping(false);
    }
  };

  const handleTypingChange = (value: string) => {
    setDraft(value);
    if (!isTypingRef.current && value.length > 0) {
      isTypingRef.current = true;
      emitTyping(true);
    }
    if (value.length === 0) {
      stopTyping();
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, 3000);
  };

  return { handleTypingChange, setTypingUsers, stopTyping, typingUsers };
};
