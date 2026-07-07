import type { Message } from "@nexus-chat/shared";
import { Virtuoso } from "react-virtuoso";
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
}) => (
  <Virtuoso
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
