/**
 * Chat Header — Channel name with #/@ prefix, E2EE indicator, online count, typing users.
 * Typing users are filtered to only those in the active channel.
 */
import { Box, Text } from "ink";
import type { Channel } from "@nexus-chat/shared";

export const ChatHeader = ({
  activeChannel,
  onlineCount,
  typingUsers,
  senderNames
}: {
  activeChannel: Channel | undefined;
  onlineCount: number;
  typingUsers: Record<string, string>;
  senderNames: Record<string, string>;
}) => {
  const typingNames = Object.keys(typingUsers)
    .filter((uid) => typingUsers[uid] === activeChannel?.id)
    .map((uid) => senderNames[uid] ?? uid.slice(0, 10));

  return (
    <Box paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        {activeChannel?.kind === "dm" ? "@" : "#"}{activeChannel?.name ?? ""}
      </Text>
      <Box gap={2}>
        {activeChannel?.mode === "e2e" ? <Text color="yellow" dimColor>[E2E]</Text> : null}
        {typingNames.length > 0 ? (
          <Text dimColor>{typingNames.join(", ")} typing...</Text>
        ) : (
          <Text dimColor>[{onlineCount} online]</Text>
        )}
      </Box>
    </Box>
  );
};
