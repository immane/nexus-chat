/**
 * useTyping — Typing Indicator Management
 *
 * Manages typing indicator emission and display:
 * - Emits "typing.start" when the user begins typing
 * - Emits "typing.stop" after 3 seconds of inactivity or when the draft is cleared
 * - Tracks typingUsers by receiving "typing.updated" events via WebSocket
 *
 * Key Design:
 * - isTypingRef prevents redundant "typing.start" emissions
 * - 3-second inactivity timeout auto-stops after the user pauses
 * - typingUsers is a Record<userId, channelId> — each entry maps a user to
 *   the channel where they are typing (supports multi-channel visibility)
 *
 * Does NOT:
 * - Render any typing indicator UI (returns typingUsers for ChatHeader consumption)
 * - Persist typing state (ephemeral, lives only in component memory)
 */
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
