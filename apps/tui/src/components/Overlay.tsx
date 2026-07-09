/**
 * Polymorphic Action Overlay — Renders modals for delete confirm, react prompt, and forward picker.
 * `kind` determines which UI variant is shown. Returns null when no overlay is active.
 */
import { Box, Text } from "ink";
import type { Channel } from "@nexus-chat/shared";

export const Overlay = ({
  channels,
  kind
}: {
  channels?: Channel[];
  kind: "forward" | "delete" | "react" | null;
}) => {
  if (!kind) return null;

  if (kind === "delete") {
    return (
      <Box flexDirection="column" borderStyle="double" borderColor="red" paddingX={2} paddingY={1}>
        <Text bold color="red">Delete this message?</Text>
        <Text dimColor>Enter to confirm, Esc to cancel</Text>
      </Box>
    );
  }

  if (kind === "react") {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Add Reaction</Text>
        <Text dimColor>Type an emoji and press Enter</Text>
      </Box>
    );
  }

  if (kind === "forward" && channels) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Forward Message</Text>
        <Text dimColor>Select a channel (number key, Esc to cancel)</Text>
        <Box flexDirection="column" marginTop={1}>
          {channels.map((ch, i) => (
            <Box key={ch.id} paddingX={1}>
              <Text dimColor>{i + 1}. </Text>
              <Text color={ch.kind === "dm" ? "magenta" : "green"}>
                {ch.kind === "dm" ? "@" : "#"}{ch.name}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  return null;
};
