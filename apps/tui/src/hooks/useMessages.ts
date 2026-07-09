/**
 * Message State Hook — CRUD, WebSocket Events, and Action Overlays
 *
 * Responsibilities:
 * - Fetches messages from the REST API with cursor-based pagination
 * - Sends text messages and slash commands via WebSocket (relay or bot invocation)
 * - Handles real-time WebSocket events: message.created, updated, deleted, reaction, read, typing
 * - Manages edit/reply modes, action overlays (forward/delete/react), typing user state, read receipts
 *
 * State owned:
 * - messages[], typingUsers, readReceipts, editMode, replyMode, overlay, overlayData
 *
 * Dependencies:
 * - `../lib/api.js` — REST fetch for messages
 * - `../lib/ws-client.js` — sendMessage, sendBotCommand, WsEventHandlers type
 *
 * The `wsHandlers` object returned from this hook must be merged with connection-level
 * handlers (onConnect, onDisconnect) by the caller in app.tsx.
 */
import { useState, useCallback } from "react";
import type { Channel, Message } from "@nexus-chat/shared";
import { request, apiBase } from "../lib/api.js";
import { type Socket } from "socket.io-client";
import { sendMessage, sendBotCommand, type WsEventHandlers } from "../lib/ws-client.js";

export type EditMode = { messageId: string; text: string } | null;
export type ReplyMode = { messageId: string; snippet: string; senderId: string } | null;
export type OverlayKind = "forward" | "delete" | "react" | null;

export const useMessages = (accessToken: string | undefined, socket: Socket | undefined) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});
  const [editMode, setEditMode] = useState<EditMode>(null);
  const [replyMode, setReplyMode] = useState<ReplyMode>(null);
  const [overlay, setOverlay] = useState<OverlayKind>(null);
  const [overlayData, setOverlayData] = useState<unknown>(null);

  const fetchMessages = useCallback(async (channelId: string, cursor?: string) => {
    try {
      const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const data = await request<{ messages: Message[] }>(`/api/v1/channels/${channelId}/messages?limit=50${cursorParam}`);
      return data.messages ?? [];
    } catch {
      return [];
    }
  }, []);

  const loadMoreMessages = useCallback(async (channelId: string) => {
    const oldest = messages[0];
    if (!oldest) return;
    const older = await fetchMessages(channelId, oldest.id);
    if (older.length > 0) {
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMessages = older.filter((m) => !existingIds.has(m.id));
        return [...newMessages, ...prev];
      });
    }
  }, [messages, fetchMessages]);

  const handleSend = useCallback(async (text: string, channel: Channel) => {
    if (!socket?.connected || !channel) return;
    const cmdName = text.startsWith("/") ? text.split(/\s+/)[0]! : "";

    if (cmdName && channel.mode !== "e2e") {
      const args = text.split(/\s+/).slice(1);
      await sendBotCommand(socket, channel.workspaceId, channel.id, cmdName, args);
      return;
    }

    const input = {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      clientMsgId: `tui-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      content: { type: "text" as const, text, attachments: [] },
      ...(replyMode ? { replyToMessageId: replyMode.messageId } : {})
    };
    const result = await sendMessage(socket, input);
    if (!result.ok) throw new Error(result.error?.message ?? "Send failed");
    setReplyMode(null);
  }, [socket, replyMode]);

  const handleEditMessage = useCallback(async (messageId: string, newText: string) => {
    if (!accessToken) return;
    try {
      const resp = await fetch(`${apiBase}/api/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ text: newText })
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? json.data! : m)));
      }
    } catch {
      // ignore
    }
    setEditMode(null);
  }, [accessToken]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    if (!accessToken) return;
    try {
      const resp = await fetch(`${apiBase}/api/v1/messages/${messageId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) {
        setMessages((prev) => prev.map((m) => (m.id === messageId ? json.data! : m)));
      }
    } catch {
      // ignore
    }
    setOverlay(null);
    setOverlayData(null);
  }, [accessToken]);

  const handleReactMessage = useCallback(async (messageId: string, emoji: string) => {
    if (!accessToken) return;
    try {
      await fetch(`${apiBase}/api/v1/messages/${messageId}/reactions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ emoji })
      });
    } catch {
      // ignore
    }
  }, [accessToken]);

  const handleForwardMessage = useCallback(async (messageId: string, targetChannelId: string) => {
    if (!accessToken) return;
    try {
      await fetch(`${apiBase}/api/v1/messages/${messageId}/forward`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetChannelId, clientMsgId: `fwd-tui-${Date.now()}` })
      });
    } catch {
      // ignore
    }
    setOverlay(null);
    setOverlayData(null);
  }, [accessToken]);

  const wsHandlers: WsEventHandlers = {
    onMessageCreated: (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id || m.clientMsgId === msg.clientMsgId)) return prev;
        return [...prev, msg];
      });
    },
    onMessageUpdated: (msg) => {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    },
    onMessageDeleted: (msg) => {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    },
    onReaction: () => {
      // reactions handled by re-fetching
    },
    onRead: (payload) => {
      if (payload.messageId) {
        setReadReceipts((prev) => ({ ...prev, [payload.messageId]: payload.readCount }));
      }
    },
    onTyping: (payload) => {
      setTypingUsers((prev) => {
        const next = { ...prev };
        if (payload.typing) next[payload.userId] = payload.channelId;
        else delete next[payload.userId];
        return next;
      });
    }
  };

  return {
    editMode,
    fetchMessages,
    handleDeleteMessage,
    handleEditMessage,
    handleForwardMessage,
    handleReactMessage,
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
  };
};
