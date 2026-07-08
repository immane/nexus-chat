import { Box, Text } from "ink";

export const BottomBar = ({
  channelName,
  status,
  shortcuts
}: {
  channelName?: string;
  status?: string;
  shortcuts: string;
}) => (
  <Box paddingX={1} justifyContent="space-between">
    <Text dimColor>{channelName ?? ""}</Text>
    <Text dimColor>{status ?? ""}</Text>
    <Text dimColor>{shortcuts}</Text>
  </Box>
);
