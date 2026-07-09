import { useState, useCallback, useEffect, useRef } from "react";
import type { Message } from "@nexus-chat/shared";
import { Badge } from "@nexus-chat/ui";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu.js";
import { useAuthStore, useMessageStore, useUiStore } from "../stores/domain.js";
import { renderMarkdown, formatRelativeTime, formatFileSize } from "../lib/markdown.js";
import { API_BASE } from "../lib/api.js";

const REACTION_EMOJIS = ["👍", "❤️", "😄", "😢", "😮", "🔥", "👏", "🎉", "😡", "🤔", "💯", "✅", "🚀", "👀", "🎯", "💪", "🙏", "👋", "💀", "🐱"];

// Module-level blob URL cache avoids re-downloading attachments when
// messages re-render in the virtual list. Keys are file IDs, values are
// object URLs created via URL.createObjectURL(). Never cleared in Phase 1;
// production should add a size-bounded LRU cache.
const blobUrlCache = new Map<string, string>();

export const MessageRow = ({
  message,
  status,
  decryptedText,
  readCount,
  senderName,
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
  onReply: () => void;
  onForward: () => void;
  onEdit: (newText: string) => Promise<void>;
  onDelete: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
}) => {
  const settings = useUiStore((state) => state.settings);
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUserId = useMessageStore((state) => state.currentUserId);
  const replyTarget = useMessageStore((state) => (message.replyToMessageId ? state.messages.get(message.replyToMessageId) : undefined));
  const reactions = useMessageStore((state) => state.reactions[message.id]);
  const isSelf = currentUserId ? message.senderId === currentUserId : false;
  const isLight = settings.theme === "light";
  const time = formatRelativeTime(message.createdAt);
  const fullTime = new Date(message.createdAt).toLocaleString();
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }, []);

  // Long-press for touch devices (mobile adaptation P0): hold for 500ms to
  // open the context menu. Movement >10px cancels to avoid accidental triggers
  // while scrolling. Complements the right-click context menu on desktop.
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    longPressStart.current = { x: touch.clientX, y: touch.clientY };
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      setMenuPos({ x: touch.clientX, y: touch.clientY });
    }, 500);
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const dx = Math.abs(touch.clientX - longPressStart.current.x);
    const dy = Math.abs(touch.clientY - longPressStart.current.y);
    if (dx > 10 || dy > 10) clearLongPress();
  }, [clearLongPress]);

  const onTouchEnd = useCallback(() => { clearLongPress(); }, [clearLongPress]);

  const [enlargedImg, setEnlargedImg] = useState<string | null>(null);
  const [attachmentUrls, setAttachmentUrls] = useState<Record<string, string>>({});

  const textAttachments = message.content.type === "text" ? message.content.attachments : [];
  const imageAttachmentKey = textAttachments.filter((att) => att.mimeType.startsWith("image/")).map((att) => att.fileId).join(":");

  useEffect(() => {
    if (!accessToken) {
      setAttachmentUrls({});
      return;
    }
    const imageAttachments = textAttachments.filter((att) => att.mimeType.startsWith("image/"));
    if (imageAttachments.length === 0) {
      setAttachmentUrls({});
      return;
    }

    const next: Record<string, string> = {};
    let hasAll = true;
    for (const att of imageAttachments) {
      const cached = blobUrlCache.get(att.fileId);
      if (cached) { next[att.fileId] = cached; continue; }
      hasAll = false;
    }
    if (hasAll) { setAttachmentUrls(next); return; }

    let cancelled = false;
    void (async () => {
      for (const att of imageAttachments) {
        if (next[att.fileId]) continue;
        try {
          const response = await fetch(`${API_BASE}/dev-download/${att.fileId}`, { headers: { authorization: `Bearer ${accessToken}` } });
          if (!response.ok) continue;
          const url = window.URL.createObjectURL(await response.blob());
          blobUrlCache.set(att.fileId, url);
          next[att.fileId] = url;
        } catch {
          // Ignore broken development-only previews.
        }
      }
      if (!cancelled) setAttachmentUrls(next);
    })();

    return () => { cancelled = true; };
  }, [accessToken, imageAttachmentKey, message.id]);

  const downloadAttachment = useCallback(async (fileId: string, name: string) => {
    if (!accessToken) return;
    try {
      const response = await fetch(`${API_BASE}/dev-download/${fileId}`, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) return;
      const url = window.URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch {
      // Ignore development-only download failures.
    }
  }, [accessToken]);

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
  const canEdit = isSelf && message.content.type === "text";
  const isNotCiphertext = !isCiphertext;

  const menuItems: ContextMenuItem[] = [
    { label: "Reply", icon: "↩", onClick: onReply },
    { label: "Copy Text", icon: "📋", disabled: isCiphertext, onClick: onCopy },
    { label: "Forward", icon: "↗", onClick: onForward },
    { label: "Edit", icon: "✏", disabled: !canEdit, onClick: startEdit },
    { label: "Delete", icon: "🗑", danger: true, onClick: onDelete },
    { label: "React", icon: "😀", onClick: () => { setEmojiPickerOpen(!emojiPickerOpen); closeMenu(); } }
  ];

  const reactionEmojis = reactions ? Object.entries(reactions) : [];

  return (
    <>
      <article className="group" onContextMenu={handleContextMenu} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div className={compactMsg}>
        <div className={`mb-2 flex items-center gap-2 text-xs ${metaStyle}`}>
          <span className={`font-bold ${senderStyle}`}>{senderName ?? message.senderId.slice(0, 12)}</span>
          <span title={fullTime}>{time}</span>
          {message.editedAt ? <span className="text-xs text-slate-500">(edited)</span> : null}
          {policyLabel ? <Badge tone="warning">{policyLabel}</Badge> : null}
          {sendStatus === "sending" ? <span className="italic text-amber-300">sending...</span> : sendStatus === "sent" && transportLabel?.endsWith("received") ? <span className="text-sky-300">↓ received{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "sent" ? <span className="text-emerald-400">✓ sent{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "failed" ? <span className="text-red-400">✗ failed</span> : null}
          {readCount !== undefined && readCount > 0 ? <span className={isLight ? "text-slate-400" : "text-slate-500"}>· read by {readCount}</span> : null}
        </div>
        {replyTarget ? (
          <div className={`mb-2 rounded-lg border-l-2 px-3 py-1.5 text-xs ${isLight ? "border-sky-400 bg-sky-50 text-slate-600" : "border-sky-500 bg-sky-500/10 text-slate-400"}`}>
            <span className="font-bold text-sky-400">Replying to {replyTarget.senderId.slice(0, 10)}</span>
            <span className="ml-2 line-clamp-1">{(replyTarget.content.type === "text" ? replyTarget.content.text : "Message").slice(0, 80)}</span>
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
          <>
            <div className="md-content text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
            {textAttachments.length > 0 ? (
              <div className="mt-2 grid gap-2">
                {textAttachments.map((att) => {
                  const isImage = att.mimeType.startsWith("image/");
                  const imageUrl = attachmentUrls[att.fileId];
                  if (isImage) {
                    return (
                      <div key={att.fileId}>
                        {imageUrl ? (
                          <img
                            src={imageUrl}
                            alt={att.name}
                            className="max-h-48 cursor-pointer rounded-lg object-cover hover:opacity-90"
                            onClick={() => setEnlargedImg(imageUrl)}
                          />
                        ) : null}
                      </div>
                    );
                  }
                  return (
                    <div key={att.fileId} className={`flex items-center gap-2 rounded-lg p-2 text-xs ${isLight ? "bg-slate-100" : "bg-slate-800/50"}`}>
                      <span className="text-lg">📄</span>
                      <div className="flex-1 truncate">
                        <p className="text-slate-300">{att.name}</p>
                        <p className="text-slate-500">{formatFileSize(att.size)}</p>
                      </div>
                      <button className="rounded bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={() => void downloadAttachment(att.fileId, att.name)}>DL</button>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {enlargedImg ? (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-pointer" onClick={() => setEnlargedImg(null)}>
                <img src={enlargedImg} alt="enlarged" className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
              </div>
            ) : null}
          </>
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
        {emojiPickerOpen ? (
          <div className={`mt-1 inline-flex flex-wrap gap-1 rounded-xl border p-2 shadow-lg ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"}`}>
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                className="rounded-lg px-2 py-1 text-lg transition hover:bg-slate-700"
                type="button"
                onClick={() => { onReact(emoji); setEmojiPickerOpen(false); }}
                title={emoji}
              >{emoji}</button>
            ))}
          </div>
        ) : null}
        </div>
      </article>
      {menuPos ? <ContextMenu x={menuPos.x} y={menuPos.y} items={menuItems} onClose={closeMenu} /> : null}
    </>
  );
};
