import { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import type { Channel } from "@nexus-chat/shared";

const CURSOR_CHAR = "█";

const isPrintable = (s: string): boolean =>
  s.length > 0 && s.split("").every((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 32 || code === 0x0a || code === 0x0d;
  }) && !s.startsWith("\x1b");

export const Composer = ({
  channel,
  editMode,
  onCancelEdit,
  onCancelReply,
  onSubmit,
  replyMode,
  senderNames
}: {
  channel: Channel | undefined;
  editMode: { messageId: string; text: string } | null;
  onCancelEdit: () => void;
  onCancelReply: () => void;
  onSubmit: (text: string) => void;
  replyMode: { messageId: string; snippet: string; senderId: string } | null;
  senderNames: Record<string, string>;
}) => {
  const [value, setValue] = useState(editMode?.text ?? "");
  const [cursorOn, setCursorOn] = useState(true);

  useEffect(() => {
    const id = setInterval(() => setCursorOn((prev) => !prev), 530);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (editMode) onCancelEdit();
      else if (replyMode) onCancelReply();
      return;
    }
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue("");
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      setCursorOn(true);
      return;
    }
    if (input && isPrintable(input) && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
      setCursorOn(true);
    }
  });

  const isE2e = channel?.mode === "e2e";
  const placeholder = editMode ? "Editing..." : isE2e ? "[E2E] Type an encrypted message..." : "Type a message...";

  return (
    <Box flexDirection="column">
      {replyMode ? (
        <Box paddingX={1}>
          <Text color="blue" dimColor>
            ↩ Replying to {senderNames[replyMode.senderId] ?? replyMode.senderId.slice(0, 10)}: {replyMode.snippet}
          </Text>
          <Text dimColor> [Esc to cancel]</Text>
        </Box>
      ) : null}
      {editMode ? (
        <Box paddingX={1}>
          <Text color="yellow" dimColor>Editing message [Enter to save, Esc to cancel]</Text>
        </Box>
      ) : null}
      <Box paddingX={1} paddingY={0}>
        <Text color="gray">{isE2e ? "[E2E] " : ""}{">"} </Text>
        <Text>{value}</Text>
        <Text>{cursorOn ? CURSOR_CHAR : " "}</Text>
        <Text color="gray" dimColor>{value.length === 0 ? ` ${placeholder}` : ""}</Text>
      </Box>
    </Box>
  );
};
