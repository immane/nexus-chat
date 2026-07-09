/**
 * Sidebar Component — Renders the channel/member/settings list in the left pane.
 * Tab switching is controlled externally via the `selectedTab` prop ("chat" | "members" | "settings").
 * Active channel is highlighted based on `activeIndex`.
 */
import { Box, Text } from "ink";
import type { Channel } from "@nexus-chat/shared";

type Tab = "chat" | "members" | "settings";

export type ChatMember = { userId: string; role: string; displayName?: string; email?: string };

export const Sidebar = ({
  activeIndex,
  channels,
  members,
  onlineUserIds,
  senderNames,
  selectedTab,
  unreadCounts
}: {
  activeIndex: number;
  channels: Channel[];
  members: ChatMember[];
  onlineUserIds: Set<string>;
  senderNames: Record<string, string>;
  selectedTab: Tab;
  unreadCounts: Record<string, number>;
}) => {
  if (selectedTab === "members") {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color="cyan">Members ({members.length})</Text>
        <Box flexDirection="column" marginTop={1}>
          {members.map((m) => {
            const online = onlineUserIds.has(m.userId);
            const name = senderNames[m.userId] ?? m.userId.slice(0, 10);
            return (
              <Box key={m.userId} paddingX={1} gap={1}>
                <Text color={online ? "green" : "gray"}>{online ? "●" : "○"}</Text>
                <Text>{name}</Text>
                <Text dimColor>({m.role})</Text>
              </Box>
            );
          })}
          {members.length === 0 ? <Text dimColor>No members</Text> : null}
        </Box>
      </Box>
    );
  }

  if (selectedTab === "settings") {
    return (
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Text bold color="cyan">Settings</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Theme, notifications, and account info.</Text>
          <Text dimColor>Use the Web or Desktop client for full settings.</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text bold color="cyan">Channels ({channels.length})</Text>
      <Box flexDirection="column" marginTop={1}>
        {channels.map((ch, i) => {
          const isActive = i === activeIndex;
          const unread = unreadCounts[ch.id] ?? 0;
          const isDm = ch.kind === "dm";
          return (
            <Box key={ch.id} paddingX={1} gap={1}>
              <Text color={isActive ? "cyan" : "white"} bold={isActive}>
                {isActive ? ">" : " "}
              </Text>
              <Text color={isDm ? "magenta" : "green"}>
                {isDm ? "@" : "#"}{ch.name}
              </Text>
              {ch.mode === "e2e" ? <Text color="yellow" dimColor>[E2E]</Text> : null}
              {unread > 0 ? <Text color="green">({unread})</Text> : null}
            </Box>
          );
        })}
        {channels.length === 0 ? <Text dimColor>No channels</Text> : null}
      </Box>
    </Box>
  );
};
