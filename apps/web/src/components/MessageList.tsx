import { useEffect, useRef } from "react";
import type { Message } from "@nexus-chat/shared";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { TransportLabel } from "./signal-helpers.js";
import { MessageRow } from "./MessageRow.js";

export const MessageList = ({
  messages,
  statuses = {},
  decryptedMessages = {},
  transportLabels = {}
}: {
  messages: Message[];
  statuses?: Record<string, string>;
  decryptedMessages?: Record<string, string>;
  transportLabels?: Record<string, TransportLabel>;
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: "smooth" }), 50);
    }
  }, [messages.length]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="flex-1"
      data={messages}
      followOutput="smooth"
      itemContent={(_, message) => {
        const decryptedText = decryptedMessages[message.id];
        const devStatus = import.meta.env.DEV && transportLabels[message.clientMsgId] ? `${statuses[message.clientMsgId] ?? "sent"} · ${transportLabels[message.clientMsgId]}` : statuses[message.clientMsgId];
        return decryptedText === undefined ? <MessageRow message={message} status={devStatus} /> : <MessageRow message={message} status={devStatus} decryptedText={decryptedText} />;
      }}
    />
  );
};
