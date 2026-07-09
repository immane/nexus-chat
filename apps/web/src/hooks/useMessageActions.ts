/**
 * useMessageActions — Message CRUD & Interaction Actions
 *
 * Provides callbacks for:
 * - Copy message text to clipboard (handleCopy)
 * - Edit message text via REST PATCH (handleEdit)
 * - Delete message with confirmation modal state (handleDelete, confirmDelete)
 * - React to messages with add/remove toggle (handleReact)
 * - Forward messages to another channel (handleForwardToChannel)
 *
 * State Ownership:
 * - forwardSource: the Message being forwarded (null when modal is closed)
 * - confirmDeleteId: the message ID pending deletion confirmation
 * - Reactions are synced to useMessageStore after each API call
 *
 * Does NOT:
 * - Show any UI (returns state + handlers for modal components)
 * - Handle P2P-specific actions (owned by ChatRoute)
 * - Decrypt messages (decryptedMessages is passed in as a prop)
 */
import { useState } from "react";
import type { Message } from "@nexus-chat/shared";
import { API_BASE } from "../lib/api.js";
import { useMessageStore } from "../stores/domain.js";

export const useMessageActions = ({
  accessToken,
  decryptedMessages,
  selectChannel
}: {
  accessToken: string | undefined;
  decryptedMessages: Record<string, string>;
  selectChannel: (channelId: string) => void;
}) => {
  const [forwardSource, setForwardSource] = useState<Message | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const reactions = useMessageStore((state) => state.reactions);
  const setReaction = useMessageStore((state) => state.setReaction);
  const upsertMessage = useMessageStore((state) => state.upsert);

  const handleCopy = (message: Message) => {
    const text = message.content.type === "text" ? message.content.text : decryptedMessages[message.id] ?? "";
    void window.navigator.clipboard.writeText(text);
  };

  const handleEdit = async (messageId: string, newText: string) => {
    if (!accessToken) return;
    try {
      const resp = await fetch(`${API_BASE}/api/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ text: newText })
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) upsertMessage(json.data);
    } catch { /* */ }
  };

  const handleDelete = async (messageId: string) => {
    setConfirmDeleteId(messageId);
  };

  const confirmDelete = async () => {
    if (!accessToken || !confirmDeleteId) { setConfirmDeleteId(null); return; }
    try {
      const resp = await fetch(`${API_BASE}/api/v1/messages/${confirmDeleteId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) upsertMessage(json.data);
    } catch { /* */ }
    setConfirmDeleteId(null);
  };

  const handleReact = async (messageId: string, emoji: string) => {
    if (!accessToken) return;
    const msgReactions = reactions[messageId] ?? {};
    const existing = msgReactions[emoji];
    const isRemove = existing?.reacted === true;
    try {
      const method = isRemove ? "DELETE" : "POST";
      const resp = await fetch(`${API_BASE}/api/v1/messages/${messageId}/reactions`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ emoji })
      });
      const json = (await resp.json()) as { ok: boolean; data?: { messageId: string; emoji: string; count: number; reacted: boolean } };
      if (json.ok && json.data) {
        setReaction(json.data.messageId, json.data.emoji, json.data.count, json.data.reacted);
      }
    } catch { /* */ }
  };

  const cancelForward = () => {
    setForwardSource(null);
    setForwardSearch("");
  };

  const handleForwardToChannel = async (targetChannelId: string) => {
    if (!accessToken || !forwardSource) return;
    try {
      const resp = await fetch(`${API_BASE}/api/v1/messages/${forwardSource.id}/forward`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ targetChannelId, clientMsgId: `fwd-${Date.now()}` })
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) {
        upsertMessage(json.data);
        selectChannel(targetChannelId);
      }
    } catch { /* */ }
    cancelForward();
  };

  return {
    cancelForward,
    confirmDelete,
    confirmDeleteId,
    forwardSearch,
    forwardSource,
    handleCopy,
    handleDelete,
    handleEdit,
    handleForwardToChannel,
    handleReact,
    setConfirmDeleteId,
    setForwardSearch,
    setForwardSource
  };
};
