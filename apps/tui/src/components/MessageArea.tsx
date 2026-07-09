/**
 * Message List Components — Renders the scrollable message area with date separators.
 *
 * MessageRow: Renders a single message with sender, timestamp, edited/encrypted labels,
 * reply-to indicator, reactions, and non-image attachments.
 *
 * MessageArea: Iterates over all messages, inserting date separator banners when the
 * date changes between consecutive messages. Delegates rendering to MessageRow.
 */
import { Box, Text } from "ink";
import type { Message } from "@nexus-chat/shared";
import { formatRelativeTime, formatDateSeparator, formatFileSize } from "../lib/format.js";

export const MessageRow = ({
  currentUserId,
  focused,
  message,
  readCount,
  senderName,
  reactions
}: {
  currentUserId?: string;
  focused: boolean;
  message: Message;
  readCount?: number;
  senderName: string;
  reactions?: Array<{ emoji: string; count: number; reacted: boolean }> | undefined;
}) => {
  const isSelf = currentUserId !== undefined && message.senderId === currentUserId;
  const isEdited = Boolean(message.editedAt);
  const isDeleted = message.content.type === "tombstone";
  const tombstone = message.content.type === "tombstone" ? message.content : null;
  const cursorColor = focused ? "cyan" : "white";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text color={cursorColor}>{focused ? ">" : " "}</Text>
        {isDeleted && tombstone ? (
          <Text color="gray" dimColor>
            ~ {tombstone.reason === "expired" ? "Message expired" : tombstone.reason === "read_once_consumed" ? "Read-once consumed" : "Message deleted"} ~
          </Text>
        ) : (
          <Box flexDirection="column" flexGrow={1}>
            <Box gap={1}>
              <Text color={isSelf ? "yellow" : "blue"} bold>{senderName}</Text>
              <Text dimColor>{formatRelativeTime(message.createdAt)}</Text>
              {isEdited ? <Text dimColor>(edited)</Text> : null}
              {message.content.type === "ciphertext" && message.content.readOnce ? <Text color="yellow">[read-once]</Text> : null}
              {message.content.type === "ciphertext" && message.content.expiresAt ? <Text color="yellow">[ttl]</Text> : null}
              {readCount !== undefined && readCount > 0 ? <Text dimColor>· read by {readCount}</Text> : null}
            </Box>
            <Text>
              {message.content.type === "text"
                ? message.content.text
                : message.content.type === "ciphertext"
                  ? "[encrypted]"
                  : "[unknown]"}
            </Text>
            {message.content.type === "text" && message.content.attachments && message.content.attachments.length > 0 ? (
              <Box flexDirection="column">
                {message.content.attachments.map((att) => (
                  <Text key={att.fileId} dimColor>📎 {att.name} ({formatFileSize(att.size)})</Text>
                ))}
              </Box>
            ) : null}
            {message.replyToMessageId ? (
              <Text dimColor color="blue">↩ Replying to a message</Text>
            ) : null}
            {reactions && reactions.length > 0 ? (
              <Box gap={1}>
                {reactions.map((r) => (
                  <Text key={r.emoji} color={r.reacted ? "cyan" : "white"}>
                    {r.emoji}{r.count > 1 ? ` ${r.count}` : ""}
                  </Text>
                ))}
              </Box>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
};

export const MessageArea = ({
  focusedIndex,
  messages,
  readReceipts,
  reactions,
  senderNames
}: {
  currentUserId?: string;
  focusedIndex: number;
  messages: Message[];
  readReceipts: Record<string, number>;
  reactions: Record<string, Array<{ emoji: string; count: number; reacted: boolean }>>;
  senderNames: Record<string, string>;
}) => {
  let lastDate = "";

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {messages.length === 0 ? (
        <Box padding={1}>
          <Text dimColor>No messages yet. Type a message to start.</Text>
        </Box>
      ) : null}
      {messages.map((msg, i) => {
        const msgDate = new Date(msg.createdAt).toDateString();
        const showDate = lastDate !== msgDate;
        if (showDate) lastDate = msgDate;
        const sn = senderNames[msg.senderId] ?? msg.senderId.slice(0, 10);
        return (
          <Box key={msg.id} flexDirection="column">
            {showDate ? (
              <Box paddingX={1}>
                <Text dimColor>{formatDateSeparator(msg.createdAt)}</Text>
              </Box>
            ) : null}
            <MessageRow
              focused={i === focusedIndex}
              message={msg}
              readCount={readReceipts[msg.id] ?? 0}
              reactions={reactions[msg.id] ?? []}
              senderName={sn}
            />
          </Box>
        );
      })}
    </Box>
  );
};
