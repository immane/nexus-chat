import { useEffect, useRef } from "react";
import type { Message } from "@nexus-chat/shared";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { TransportLabel } from "./signal-helpers.js";
import { useMessageStore } from "../stores/domain.js";
import { MessageRow } from "./MessageRow.js";
import { formatDateSeparator } from "../lib/markdown.js";

export const MessageList = ({
  messages,
  statuses = {},
  decryptedMessages = {},
  transportLabels = {},
  readReceipts = {},
  senderNames = {},
  onMessagesVisible,
  onReply,
  onForward,
  onEdit,
  onDelete,
  onCopy,
  onReact
}: {
  messages: Message[];
  statuses?: Record<string, string>;
  decryptedMessages?: Record<string, string>;
  transportLabels?: Record<string, TransportLabel>;
  readReceipts?: Record<string, number>;
  senderNames?: Record<string, string>;
  onMessagesVisible?: (messageIds: string[]) => void;
  onReply: (message: Message) => void;
  onForward: (message: Message) => void;
  onEdit: (messageId: string, newText: string) => Promise<void>;
  onDelete: (messageId: string) => void;
  onCopy: (message: Message) => void;
  onReact: (messageId: string, emoji: string) => void;
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const pendingRef = useRef<string[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reactionsByMessage = useMessageStore((state) => state.reactions);

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
      itemContent={(index, message) => {
        const decryptedText = decryptedMessages[message.id];
        const devStatus = import.meta.env.DEV && transportLabels[message.clientMsgId] ? `${statuses[message.clientMsgId] ?? "sent"} · ${transportLabels[message.clientMsgId]}` : statuses[message.clientMsgId];
        const sn = senderNames[message.senderId];
        const prev = index > 0 ? messages[index - 1] : undefined;
        const showDate = !prev || new Date(prev.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
        return (
          <>
            {showDate ? (
              <div className="my-2 text-center">
                <span className="inline-block rounded-full bg-slate-800 px-4 py-1 text-xs text-slate-400">{formatDateSeparator(message.createdAt)}</span>
              </div>
            ) : null}
            <MessageRow
              message={message}
              status={devStatus}
              senderName={sn}
              readCount={readReceipts[message.id] as number | undefined}
              decryptedText={decryptedText as string | undefined}
              reactions={reactionsByMessage[message.id]}
              onReply={() => onReply(message)}
              onForward={() => onForward(message)}
              onEdit={(newText) => onEdit(message.id, newText)}
              onDelete={() => onDelete(message.id)}
              onCopy={() => onCopy(message)}
              onReact={(emoji) => onReact(message.id, emoji)}
            />
          </>
        );
      }}
    />
  );
};
