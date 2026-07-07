import { useEffect, useRef } from "react";
import type { Message } from "@nexus-chat/shared";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { TransportLabel } from "./signal-helpers.js";
import { MessageRow } from "./MessageRow.js";

export const MessageList = ({
  messages,
  statuses = {},
  decryptedMessages = {},
  transportLabels = {},
  readReceipts = {},
  senderNames = {},
  onMessagesVisible
}: {
  messages: Message[];
  statuses?: Record<string, string>;
  decryptedMessages?: Record<string, string>;
  transportLabels?: Record<string, TransportLabel>;
  readReceipts?: Record<string, number>;
  senderNames?: Record<string, string>;
  onMessagesVisible?: (messageIds: string[]) => void;
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pendingRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" }), 50);
    }
  }, [messages.length]);

  const flushAcks = () => {
    if (pendingRef.current.length > 0 && onMessagesVisible) {
      onMessagesVisible(pendingRef.current);
      pendingRef.current = [];
    }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
  };

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="flex-1"
      data={messages}
      followOutput="smooth"
      rangeChanged={(range) => {
        const visible = messages.slice(range.startIndex, range.endIndex + 1).map((m) => m.id);
        pendingRef.current = [...new Set([...pendingRef.current, ...visible])];
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(flushAcks, 500);
      }}
      itemContent={(_, message) => {
        const decryptedText = decryptedMessages[message.id];
        const devStatus = import.meta.env.DEV && transportLabels[message.clientMsgId] ? `${statuses[message.clientMsgId] ?? "sent"} · ${transportLabels[message.clientMsgId]}` : statuses[message.clientMsgId];
        const rc = readReceipts[message.id];
        const sn = senderNames[message.senderId];
        const rowProps = { message, status: devStatus, senderName: sn } as { message: typeof message; status: string | undefined; readCount?: number; decryptedText?: string; senderName?: string };
        if (rc !== undefined) rowProps.readCount = rc;
        if (decryptedText !== undefined) rowProps.decryptedText = decryptedText as string;
        return <MessageRow {...rowProps} />;
      }}
    />
  );
};
