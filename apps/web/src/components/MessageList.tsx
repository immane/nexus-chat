import { useCallback, useEffect, useRef, useState, forwardRef } from "react";
import type { HTMLAttributes } from "react";
import type { Message } from "@nexus-chat/shared";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { TransportLabel } from "./signal-helpers.js";
import { MessageRow } from "./MessageRow.js";
import { formatDateSeparator } from "../lib/markdown.js";

const Scroller = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ style, ...props }, ref) => (
    <div ref={ref} style={{ ...style, background: "transparent" }} {...props} />
  )
);
Scroller.displayName = "Scroller";

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
  const atBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollToBottom = useCallback(() => {
    atBottomRef.current = true;
    if (messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" });
    }
    setShowScrollBtn(false);
  }, [messages.length]);

  // Debounced visible-message ack batching: collect visible IDs as the
  // user scrolls, then flush them every 500ms to avoid flooding the server
  // with one ack per MessageRow render.
  const flushAcks = useCallback(() => {
    if (pendingRef.current.length > 0 && onMessagesVisible) {
      onMessagesVisible(pendingRef.current);
      pendingRef.current = [];
    }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined; }
  }, [onMessagesVisible]);

  useEffect(() => {
    if (messages.length > 0 && atBottomRef.current) {
      setTimeout(() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" }), 50);
    }
  }, [messages.length]);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  return (
    <>
      <Virtuoso
      ref={virtuosoRef}
      className="flex-1"
      data={messages}
      computeItemKey={(_, message) => message.id}
      followOutput={false}
      atBottomStateChange={(ab) => { atBottomRef.current = ab; setShowScrollBtn(!ab); }}
      components={{ Scroller }}
      overscan={{ main: 200, reverse: 200 }}
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
    {showScrollBtn ? (
      <button
        className="fixed bottom-20 right-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-sky-500/80 text-white shadow-lg transition hover:bg-sky-500"
        type="button"
        onClick={scrollToBottom}
        title="Back to bottom"
      >↓</button>
    ) : null}
    </>
  );
};