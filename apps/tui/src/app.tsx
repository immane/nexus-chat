import { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import type { Channel, Message, Workspace } from "@nexus-chat/shared";
import { getAccessToken, request } from "./lib/api.js";
import { createSocket, sendMessage, listenForMessages } from "./lib/ws-client.js";
import type { Socket } from "socket.io-client";

type ChatView = "loading" | "workspaces" | "channels" | "chat";

const ChannelList = ({
  channels,
  onSelect,
  onBack
}: {
  channels: Channel[];
  onSelect: (channel: Channel) => void;
  onBack: () => void;
}) => {
  useInput((input, key) => {
    if (key.escape) onBack();
    const num = Number(input);
    if (num >= 1 && num <= channels.length) onSelect(channels[num - 1]!);
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Channels (press ESC to go back)</Text>
      {channels.map((ch, i) => (
        <Box key={ch.id}>
          <Text dimColor>{i + 1}. </Text>
          <Text color={ch.mode === "e2e" ? "yellow" : "green"}>
            {ch.kind === "dm" ? "@" : "#"}{ch.name}
          </Text>
          {ch.mode === "e2e" ? <Text color="yellow" dimColor> [E2E]</Text> : null}
        </Box>
      ))}
    </Box>
  );
};

const MessageList = ({ messages }: { messages: Message[] }) => (
  <Box flexDirection="column" flexGrow={1} overflow="hidden">
    {messages.slice(-20).map((msg) => (
      <Box key={msg.id} flexDirection="column" marginBottom={1}>
        {msg.content.type === "tombstone" ? (
          <Text color="gray" dimColor>
            ~ {msg.content.reason === "expired" ? "Message expired" : msg.content.reason === "read_once_consumed" ? "Read-once consumed" : "Message deleted"} ~
          </Text>
        ) : (
          <>
            <Text>
              <Text color="blue" bold>{msg.senderId}</Text>
              <Text dimColor> {new Date(msg.createdAt).toLocaleTimeString()}</Text>
              {msg.content.type === "ciphertext" && msg.content.readOnce ? <Text color="yellow"> [read-once]</Text> : null}
              {msg.content.type === "ciphertext" && msg.content.expiresAt ? <Text color="yellow"> [ttl]</Text> : null}
            </Text>
            <Text>{msg.content.type === "text" ? msg.content.text : msg.content.type === "ciphertext" ? "[encrypted]" : "[unknown]"}</Text>
          </>
        )}
      </Box>
    ))}
  </Box>
);

const InputBar = ({ onSubmit, channel }: { onSubmit: (text: string) => void; channel: Channel | undefined }) => {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value.trim());
        setValue("");
      }
    } else if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
    } else if (input && input.length === 1 && !key.ctrl) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box borderStyle="single" borderColor="gray" padding={1}>
      <Text color="gray">{channel?.mode === "e2e" ? "[E2E] " : ""}{">"} </Text>
      <Text>{value}</Text>
      <Text color="gray" dimColor>{value.length === 0 ? " (type a message, Enter to send)" : ""}</Text>
    </Box>
  );
};

const ChatApp = ({ workspaceId, channelId }: { workspaceId: string; channelId: string }) => {
  const { exit } = useApp();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [view, setView] = useState<ChatView>("loading");
  const [socket, setSocket] = useState<Socket | undefined>();
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const wsList = await request<Workspace[]>("/api/v1/workspaces");
        if (wsList.length === 0) {
          setError("No workspaces found. Create one first with: nexus workspace-create");
          return;
        }
        const wid = workspaceId || wsList[0]!.id;
        const chList = await request<Channel[]>(`/api/v1/workspaces/${wid}/channels`);
        setChannels(chList);

        if (channelId) {
          const ch = chList.find((c: Channel) => c.id === channelId);
          if (ch) {
            setActiveChannel(ch);
            setView("chat");
            const msgs = await request<{ messages: Message[] }>(`/api/v1/channels/${ch.id}/messages`);
            setMessages(msgs.messages ?? []);
          }
        } else {
          setView("channels");
        }

        const sock = createSocket();
        listenForMessages(sock, (msg: Message) => setMessages((prev) => [...prev, msg]));
        sock.on("connect_error", () => setError("WebSocket connection failed"));
        sock.connect();
        setSocket(sock);
      } catch (err) {
        setError(String(err));
      }
    })();
    return () => { socket?.disconnect(); };
  }, []);

  useInput((_, key) => {
    if (key.escape && view === "chat") {
      setView("channels");
    }
  });

  const handleChannelSelect = async (ch: Channel) => {
    setActiveChannel(ch);
    setView("chat");
    try {
      const result = await request<{ messages: Message[] }>(`/api/v1/channels/${ch.id}/messages`);
      setMessages(result.messages ?? []);
    } catch {
      // keep existing messages
    }
  };

  const handleSend = async (text: string) => {
    if (!socket?.connected || !activeChannel) return;
    const input = {
      workspaceId: activeChannel.workspaceId,
      channelId: activeChannel.id,
      clientMsgId: `tui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: { type: "text" as const, text, attachments: [] }
    };
    const result = await sendMessage(socket, input);
    if (!result.ok) setError(`Send failed: ${result.error?.message ?? "unknown"}`);
  };

  if (error) return <Box padding={1}><Text color="red">{error}</Text></Box>;

  if (view === "loading") return <Box padding={1}><Text>Loading...</Text></Box>;

  if (view === "channels") {
    return <ChannelList channels={channels} onSelect={handleChannelSelect} onBack={() => exit()} />;
  }

  return (
    <Box flexDirection="column" height="100%" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {activeChannel?.kind === "dm" ? "@" : "#"}{activeChannel?.name}
        </Text>
        {activeChannel?.mode === "e2e" ? <Text color="yellow"> [E2E - no bots/search]</Text> : null}
        <Text dimColor> (ESC for channel list)</Text>
      </Box>
      <MessageList messages={messages} />
      <InputBar onSubmit={handleSend} channel={activeChannel} />
    </Box>
  );
};

export const startInteractiveChat = async (workspaceId?: string, channelId?: string) => {
  const token = getAccessToken();
  if (!token) {
    console.error("Not authenticated. Run 'nexus login' first.");
    process.exit(1);
  }

  let wid = workspaceId ?? "";
  let cid = channelId ?? "";

  if (!wid) {
    try {
      const wsList = await request<Workspace[]>("/api/v1/workspaces");
      if (wsList.length === 0) {
        console.error("No workspaces found. Create one first with: workspace-create -n <name>");
        process.exit(1);
      }
      if (wsList.length > 1 && !workspaceId) {
        console.log("Available workspaces:");
        wsList.forEach((w) => console.log(`  ${w.id}  ${w.name}`));
        console.log(`Using first workspace: ${wsList[0]!.name} (${wsList[0]!.id})`);
        console.log("(Use -w <id> to select a different one)\n");
      }
      wid = wsList[0]!.id;
    } catch (err) {
      console.error("Failed to list workspaces:", String(err));
      process.exit(1);
    }
  }

  const { unmount } = render(<ChatApp workspaceId={wid} channelId={cid} />);

  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      unmount();
      resolve();
    });
  });
};
