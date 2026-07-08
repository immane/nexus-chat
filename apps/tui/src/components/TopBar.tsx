import { Box, Text } from "ink";

export const TopBar = ({ connected }: { connected: boolean }) => (
  <Box paddingX={1} justifyContent="space-between">
    <Text bold color="cyan">Nexus Chat</Text>
    <Text color={connected ? "green" : "red"}>
      {connected ? "● connected" : "○ disconnected"}
    </Text>
  </Box>
);
