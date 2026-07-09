/**
 * Interactive TUI Chat Application — Ink (React-for-terminal)
 *
 * Responsibilities:
 * - Renders the full two-pane chat layout: TopBar, Sidebar, ChatHeader, MessageArea, Composer, BottomBar
 * - Manages WebSocket connection lifecycle, channel switching, and global keyboard shortcuts
 * - Delegates data fetching to hooks (useChannelData, useMessages) and rendering to components
 *
 * Focus/Panel Model:
 * - Three focusable panels: "sidebar" | "messages" | "composer"
 * - Tab cycles between panels, each panel has its own keyboard shortcuts
 * - Message actions (reply/edit/delete/forward/react) are triggered from the "messages" panel
 * - Overlays (delete confirm, forward picker, react prompt) stack on top of the message area
 *
 * Keyboard Shortcuts by Panel:
 *   sidebar:  ↑↓ Nav, Enter Select, n New Channel, Tab Cycle, Ctrl+1/2/3 Tabs
 *   messages: ↑↓ Nav, PgUp/PgDn/Home/End Scroll, r Reply, e Edit, d Delete, c Copy, f Forward, + React
 *   composer: Enter Send, Esc Cancel, Tab Switch, Ctrl+l Sidebar, Ctrl+m Messages
 *   global:   Ctrl+q Quit
 *
 * Dependencies:
 * - `./lib/api.js` — token retrieval
 * - `./lib/ws-client.js` — Socket.IO connection + event listeners
 * - `./hooks/useChannelData.js` — workspace/channel/member fetching
 * - `./hooks/useMessages.js` — message CRUD + WS event handling
 * - `./hooks/useTerminalSize.js` — terminal dimensions
 * - `./components/*` — UI components (TopBar, Sidebar, ChatHeader, MessageArea, Composer, BottomBar, Overlay)
 *
 * Forbidden Dependencies:
 * - Must NOT access the filesystem or server-side modules
 * - Must NOT import from `apps/server/`
 *
 * Invariants:
 * - Backgound color is set to dark semi-transparent (#0a0a14) via OSC sequence on mount, reset on unmount
 * - The SIGINT signal is trapped to unmount the Ink app cleanly
 * - Token validation happens BEFORE the Ink app mounts (fail-fast in `startInteractiveChat`)
 */
import { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import type { Channel } from "@nexus-chat/shared";
import { getAccessToken } from "./lib/api.js";
import { createSocket, listenForAllEvents, sendTypingEvent, sendPresenceUpdate } from "./lib/ws-client.js";
import type { Socket } from "socket.io-client";
import { useTerminalSize } from "./hooks/useTerminalSize.js";
import { useChannelData } from "./hooks/useChannelData.js";
import { useMessages } from "./hooks/useMessages.js";
import { TopBar } from "./components/TopBar.js";
import { BottomBar } from "./components/BottomBar.js";
import { Sidebar } from "./components/Sidebar.js";
import { ChatHeader } from "./components/ChatHeader.js";
import { MessageArea } from "./components/MessageArea.js";
import { Composer } from "./components/Composer.js";
import { Overlay } from "./components/Overlay.js";

type Tab = "chat" | "members" | "settings";
type FocusPanel = "sidebar" | "messages" | "composer";

const ChatShell = () => {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const sidebarWidth = Math.min(30, Math.floor(columns * 0.25));
  const accessToken = getAccessToken();
  const { stdout } = useStdout();

  useEffect(() => {
    stdout.write("\x1b]Ph0a0a14\x1b\\");
    stdout.write("\x1b[2J");
    return () => { stdout.write("\x1b]Ph\x1b\\"); };
  }, []);

  const {
    channels,
    createChannel,
    error: dataError,
    loading,
    members,
    onlineUserIds,
    senderNames,
    setOnline,
    addChannel
  } = useChannelData();

  const [socket, setSocket] = useState<Socket | undefined>();
  const [wsConnected, setWsConnected] = useState(false);

  const {
    editMode,
    fetchMessages,
    handleDeleteMessage,
    handleEditMessage,
    handleForwardMessage,
    handleSend,
    loadMoreMessages,
    messages,
    overlay,
    overlayData,
    readReceipts,
    replyMode,
    setEditMode,
    setMessages,
    setOverlay,
    setOverlayData,
    setReplyMode,
    typingUsers,
    wsHandlers
  } = useMessages(accessToken, socket);

  const [activeChannel, setActiveChannel] = useState<Channel | undefined>();
  const [activePanel, setActivePanel] = useState<FocusPanel>("sidebar");
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);
  const [selectedTab, setSelectedTab] = useState<Tab>("chat");
  const [unreadCounts] = useState<Record<string, number>>({});

  // Connect WebSocket
  useEffect(() => {
    const sock = createSocket();
    setSocket(sock);

    listenForAllEvents(sock, {
      ...wsHandlers,
      onConnect: () => {
        setWsConnected(true);
        sendPresenceUpdate(sock, "online");
      },
      onDisconnect: () => setWsConnected(false),
      onConnectError: () => {},
      onPresence: (payload) => {
        if (payload.userId) setOnline(payload.userId, payload.status === "online");
      },
      onChannelCreated: (ch) => { addChannel(ch); },
      onDmCreated: (dm) => { addChannel(dm); }
    });

    sock.connect();

    return () => { sock.disconnect(); };
  }, []);

  // Enter a channel
  const enterChannel = useCallback(async (ch: Channel) => {
    setActiveChannel(ch);
    setActivePanel("messages");
    setMessageIndex(0);
    try {
      const msgs = await fetchMessages(ch.id);
      setMessages(msgs);
    } catch {
      // keep existing
    }
  }, [fetchMessages, setMessages]);

  // Global keyboard shortcuts
  useInput((input, key) => {
    // Global: panel switching
    if (key.tab) {
      const panels: FocusPanel[] = ["sidebar", "messages", "composer"];
      const idx = panels.indexOf(activePanel);
      setActivePanel(panels[(idx + 1) % 3]!);
      return;
    }

    if (input === "q" && key.ctrl) {
      socket?.disconnect();
      exit();
      return;
    }

    // Escape: back to sidebar from messages, or close overlay
    if (key.escape) {
      if (overlay) {
        setOverlay(null);
        setOverlayData(null);
        return;
      }
      if (activePanel === "messages") {
        setActivePanel("sidebar");
        return;
      }
      if (editMode) {
        setEditMode(null);
        return;
      }
      if (replyMode) {
        setReplyMode(null);
        return;
      }
      return;
    }

    // Sidebar navigation
    if (activePanel === "sidebar") {
      if (key.downArrow) {
        setSidebarIndex((prev) => Math.min(prev + 1, channels.length - 1));
        return;
      }
      if (key.upArrow) {
        setSidebarIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.return && channels[sidebarIndex]) {
        void enterChannel(channels[sidebarIndex]!);
        return;
      }
      if (input === "n") {
        void (async () => {
          const name = `channel-${Date.now().toString(36)}`;
          const ch = await createChannel(name);
          if (ch) void enterChannel(ch);
        })();
        return;
      }
      if (input === "1" && key.ctrl) { setSelectedTab("chat"); return; }
      if (input === "2" && key.ctrl) { setSelectedTab("members"); return; }
      if (input === "3" && key.ctrl) { setSelectedTab("settings"); return; }
    }

    // Message area: focus movement + actions
    if (activePanel === "messages" && activeChannel) {
      if (key.upArrow) {
        setMessageIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (key.downArrow) {
        setMessageIndex((prev) => Math.min(prev + 1, messages.length - 1));
        return;
      }
      if (key.pageDown) {
        setMessageIndex((prev) => Math.min(prev + 10, messages.length - 1));
        return;
      }
      if (key.pageUp) {
        setMessageIndex((prev) => Math.max(prev - 10, 0));
        return;
      }
      if (key.home) {
        setMessageIndex(0);
        void loadMoreMessages(activeChannel.id);
        return;
      }
      if (key.end) {
        setMessageIndex(messages.length - 1);
        return;
      }

      // Message actions (only when overlay is not open)
      if (!overlay && !editMode) {
        const focusedMsg = messages[messageIndex];
        if (!focusedMsg) return;

        if (input === "r") {
          const snippet = focusedMsg.content.type === "text" ? focusedMsg.content.text.slice(0, 60) : "message";
          setReplyMode({ messageId: focusedMsg.id, snippet, senderId: focusedMsg.senderId });
          setActivePanel("composer");
          return;
        }
        if (input === "c") {
          const text = focusedMsg.content.type === "text" ? focusedMsg.content.text : "[encrypted]";
          process.stdout.write(`\n${text}\n`);
          return;
        }
        if (input === "f") {
          setOverlay("forward");
          setOverlayData(null);
          return;
        }
        if (input === "d") {
          setOverlay("delete");
          setOverlayData(focusedMsg.id);
          return;
        }
        if (input === "+") {
          setOverlay("react");
          setOverlayData(focusedMsg.id);
          return;
        }
        if (input === "e" && focusedMsg.content.type === "text") {
          setEditMode({ messageId: focusedMsg.id, text: focusedMsg.content.text });
          setActivePanel("composer");
          return;
        }
      }

      // Overlay actions
      if (overlay === "delete" && key.return) {
        void handleDeleteMessage(overlayData as string);
        return;
      }
      if (overlay === "forward") {
        const num = Number(input);
        if (num >= 1 && num <= channels.length) {
          const ch = channels[num - 1];
          if (ch && typeof overlayData === "string") {
            void handleForwardMessage(overlayData, ch.id);
          }
        }
        return;
      }
    }

    // Composer actions
    if (activePanel === "composer") {
      if (input === "l" && key.ctrl) {
        setActivePanel("sidebar");
        return;
      }
      if (input === "m" && key.ctrl) {
        setActivePanel("messages");
        return;
      }
    }
  });

  // Typing indicator emission
  const emitTyping = useCallback((typing: boolean) => {
    if (!socket?.connected || !activeChannel) return;
    sendTypingEvent(socket, activeChannel.workspaceId, activeChannel.id, typing);
  }, [socket, activeChannel]);

  const handleComposerSubmit = useCallback((text: string) => {
    if (editMode) {
      void handleEditMessage(editMode.messageId, text);
      setActivePanel("messages");
      return;
    }
    if (activeChannel) {
      void handleSend(text, activeChannel);
      emitTyping(false);
    }
  }, [editMode, activeChannel, handleEditMessage, handleSend, emitTyping]);

  const shortcutHints = activePanel === "sidebar"
    ? "↑↓=Nav Enter=Sel n=New Tab=Cycle"
    : activePanel === "messages"
      ? "↑↓=Msg r=Reply e=Edit d=Del c=Copy f=Fwd +=React"
      : "Enter=Send Esc=Cancel Tab=Switch";

  if (loading) return <Box padding={1}><Text>Loading...</Text></Box>;
  if (dataError && channels.length === 0) return <Box padding={1}><Text color="red">{dataError}</Text></Box>;

  return (
    <Box flexDirection="column" height={rows}>
      <TopBar connected={wsConnected} />

      <Box flexDirection="row" flexGrow={1} borderStyle="single" borderColor="gray">
        <Box width={sidebarWidth} flexDirection="column" borderStyle="single" borderColor="gray" borderTop={false} borderBottom={false} borderLeft={false}>
          <Sidebar
            activeIndex={sidebarIndex}
            channels={channels}
            members={members}
            onlineUserIds={onlineUserIds}
            senderNames={senderNames}
            selectedTab={selectedTab}
            unreadCounts={unreadCounts}
          />
          <Box borderStyle="single" borderColor="gray" borderBottom={false} borderLeft={false} borderRight={false} paddingX={1} gap={1}>
            <Text color={selectedTab === "chat" ? "cyan" : "white"}>[Chat]</Text>
            <Text color={selectedTab === "members" ? "cyan" : "white"}>[Members]</Text>
            <Text color={selectedTab === "settings" ? "cyan" : "white"}>[Settings]</Text>
          </Box>
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          {activeChannel ? (
            <>
              <ChatHeader
                activeChannel={activeChannel}
                onlineCount={onlineUserIds.size}
                senderNames={senderNames}
                typingUsers={typingUsers}
              />
              <MessageArea
                focusedIndex={messageIndex}
                messages={messages}
                readReceipts={readReceipts}
                reactions={{}}
                senderNames={senderNames}
              />
              <Composer
                channel={activeChannel}
                editMode={editMode}
                onCancelEdit={() => { setEditMode(null); setActivePanel("messages"); }}
                onCancelReply={() => { setReplyMode(null); }}
                onSubmit={handleComposerSubmit}
                replyMode={replyMode}
                senderNames={senderNames}
              />
              {overlay ? (
                <Box>
                  <Overlay
                    channels={channels}
                    kind={overlay}
                  />
                </Box>
              ) : null}
            </>
          ) : (
            <Box padding={2} flexDirection="column">
              <Text bold color="cyan">Welcome to Nexus Chat TUI</Text>
              <Text dimColor>Select a channel from the sidebar (↑↓ to navigate, Enter to select).</Text>
              <Text dimColor>Or press n to create a new channel.</Text>
            </Box>
          )}
        </Box>
      </Box>

      <BottomBar
        channelName={activeChannel ? `${activeChannel.kind === "dm" ? "@" : "#"}${activeChannel.name}` : ""}
        status={Object.keys(typingUsers).length > 0 ? "Someone is typing..." : ""}
        shortcuts={shortcutHints}
      />
    </Box>
  );
};

/**
 * Renders the Ink-based interactive chat UI.
 *
 * Performs token validation BEFORE mounting — exits with code 1 if not authenticated.
 * Traps SIGINT to unmount the Ink app cleanly rather than leaving the terminal in a broken state.
 */
export const startInteractiveChat = async () => {
  const token = getAccessToken();
  if (!token) {
    console.error("Not authenticated. Run 'nexus login' first.");
    process.exit(1);
  }

  const { render } = await import("ink");

  const { unmount } = render(<ChatShell />);

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      unmount();
      resolve();
      process.off("SIGINT", cleanup);
    };
    process.on("SIGINT", cleanup);
  });
};
