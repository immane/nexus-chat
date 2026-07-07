import { useState, useCallback } from "react";
import type { Message } from "@nexus-chat/shared";
import { Badge } from "@nexus-chat/ui";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { useMessageStore, useUiStore } from "../stores/domain.js";

export const MessageRow = ({
  message,
  status,
  decryptedText,
  readCount,
  senderName,
  reactions,
  onReply,
  onForward,
  onEdit,
  onDelete,
  onCopy,
  onReact
}: {
  message: Message;
  status: string | undefined;
  decryptedText: string | undefined;
  readCount: number | undefined;
  senderName: string | undefined;
  reactions: Record<string, { count: number; reacted: boolean }> | undefined;
  onReply: () => void;
  onForward: () => void;
  onEdit: (newText: string) => Promise<void>;
  onDelete: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
}) => {
  const settings = useUiStore((state) => state.settings);
  const messagesMap = useMessageStore((state) => state.messages);
  const currentUserId = useMessageStore((state) => state.currentUserId);
  const isSelf = currentUserId ? message.senderId === currentUserId : false;
  const isLight = settings.theme === "light";
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  const compactMsg = settings.compactMode ? "mx-2 my-1 px-2 py-1 text-xs" : "mx-4 my-1 px-4 py-1 text-sm";
  const [sendStatus, transportLabel] = status?.split(" · ") ?? [];
  const transportName = transportLabel?.startsWith("p2p") ? "p2p" : transportLabel?.startsWith("relay") ? "relay" : undefined;

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenuPos(null), []);

  const startEdit = useCallback(() => {
    const text = message.content.type === "text" ? message.content.text : decryptedText ?? "";
    setEditText(text);
    setEditing(true);
  }, [message.content, decryptedText]);

  const submitEdit = useCallback(async () => {
    if (editText.trim()) {
      await onEdit(editText.trim());
    }
    setEditing(false);
  }, [editText, onEdit]);

  if (message.content.type === "tombstone") {
    const reason = message.content.reason === "read_once_consumed" ? "Read-once message consumed" : "Message expired";
    const tombstoneStyle = isLight
      ? "border-dashed border-slate-300 bg-slate-100 text-slate-500"
      : "border-dashed border-slate-700 bg-slate-900/50 text-slate-400";
    const tombstoneMeta = isLight ? "text-slate-400" : "text-slate-500";
    return <article className={`mx-4 my-2 rounded-xl border ${tombstoneStyle} p-4 text-sm`}><span className={`text-xs ${tombstoneMeta}`}>{time}</span> {reason}</article>;
  }

  const isCiphertext = message.content.type === "ciphertext";
  const ciphertextContent = isCiphertext ? (message.content as { type: "ciphertext"; ciphertext: string; algorithm: string; senderDeviceId: string; readOnce: boolean; expiresAt?: string; attachments: unknown[] }) : null;
  const policyLabel = ciphertextContent && ciphertextContent.readOnce ? "Read once" : ciphertextContent && ciphertextContent.expiresAt ? "Disappearing" : undefined;
  const body = message.content.type === "text" ? message.content.text : decryptedText ?? "Decrypting encrypted message...";
  const senderStyle = isSelf ? "text-amber-400" : isLight ? "text-slate-700" : "text-slate-300";
  const metaStyle = isLight ? "text-slate-400" : "text-slate-500";
  const bodyStyle = isLight ? "text-slate-800" : "text-slate-100";
  const canEdit = message.content.type === "text" && !message.editedAt;
  const isNotCiphertext = !isCiphertext;

  const menuItems: ContextMenuItem[] = [
    { label: "Reply", icon: "↩", onClick: onReply },
    { label: "Copy Text", icon: "📋", disabled: isCiphertext, onClick: onCopy },
    { label: "Forward", icon: "↗", onClick: onForward },
    { label: "Edit", icon: "✏", disabled: !canEdit, onClick: startEdit },
    { label: "Delete", icon: "🗑", danger: true, onClick: onDelete },
    { label: "React", icon: "😀", onClick: () => { onReact("👍"); closeMenu(); } }
  ];

  const reactionEmojis = reactions ? Object.entries(reactions) : [];
  const replyTarget = message.replyToMessageId ? messagesMap.get(message.replyToMessageId) : undefined;

  return (
    <>
      <article className="group" onContextMenu={handleContextMenu}>
        <div className={compactMsg}>
        <div className={`mb-2 flex items-center gap-2 text-xs ${metaStyle}`}>
          <span className={`font-bold ${senderStyle}`}>{senderName ?? message.senderId.slice(0, 12)}</span>
          <span>{time}</span>
          {message.editedAt ? <span className="italic">edited</span> : null}
          {policyLabel ? <Badge tone="warning">{policyLabel}</Badge> : null}
          {sendStatus === "sending" ? <span className="italic text-amber-300">sending...</span> : sendStatus === "sent" && transportLabel?.endsWith("received") ? <span className="text-sky-300">↓ received{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "sent" ? <span className="text-emerald-400">✓ sent{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "failed" ? <span className="text-red-400">✗ failed</span> : null}
          {readCount !== undefined && readCount > 0 ? <span className={isLight ? "text-slate-400" : "text-slate-500"}>· read by {readCount}</span> : null}
        </div>
        {replyTarget ? (
          <div className={`mb-2 rounded-lg border-l-2 px-3 py-1.5 text-xs ${isLight ? "border-sky-400 bg-sky-50 text-slate-600" : "border-sky-500 bg-sky-500/10 text-slate-400"}`}>
            <span className="font-bold text-sky-400">Replying to {replyTarget.senderId.slice(0, 10)}</span>
            <span className="ml-2 line-clamp-1">{replyTarget.content.type === "text" ? replyTarget.content.text.slice(0, 80) : replyTarget.content.type === "ciphertext" ? "Encrypted message" : "Message"}</span>
          </div>
        ) : null}
        {editing ? (
          <div className="flex gap-1">
            <textarea
              className={`flex-1 rounded-lg border px-3 py-2 text-sm ${isLight ? "border-slate-300 bg-white text-slate-800" : "border-slate-600 bg-slate-800 text-slate-200"}`}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitEdit(); } }}
              autoFocus
              rows={2}
            />
            <div className="flex flex-col gap-1">
              <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={() => void submitEdit()}>Save</button>
              <button className="rounded-lg bg-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-600" type="button" onClick={() => setEditing(false)}>✕</button>
            </div>
          </div>
        ) : (
          <p className={`whitespace-pre-wrap text-sm leading-6 ${bodyStyle}`}>{body}</p>
        )}
        {isNotCiphertext ? (
          <div className="mt-1 flex items-center gap-1 pt-1">
            {reactionEmojis.map(([emoji, info]) => (
              <button
                key={emoji}
                className={`rounded-full px-2 py-0.5 text-xs transition ${info.reacted ? (isLight ? "bg-sky-100 text-sky-700" : "bg-sky-500/20 text-sky-200") : (isLight ? "bg-slate-100 hover:bg-slate-200" : "bg-slate-800 hover:bg-slate-700")}`}
                type="button"
                onClick={() => onReact(emoji)}
                title={`${info.reacted ? "Remove" : "Add"} ${emoji}`}
              >
                {emoji} {info.count > 1 ? info.count : null}
              </button>
            ))}
          </div>
        ) : null}
        </div>
      </article>
      {menuPos ? <ContextMenu x={menuPos.x} y={menuPos.y} items={menuItems} onClose={closeMenu} /> : null}
    </>
  );
};
