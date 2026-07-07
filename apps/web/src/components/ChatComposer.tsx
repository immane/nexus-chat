import type { ClipboardEvent as ReactClipboardEvent, FormEvent, RefObject } from "react";
import type { BotManifest, Message } from "@nexus-chat/shared";
import { InputActionBar } from "@nexus-chat/ui";
import type { DisappearingDraftPolicy, InputAction } from "../stores/domain.js";
import PolicyControl from "./PolicyControl.js";

const MESSAGE_EMOJIS = ["😀", "😂", "😍", "🤔", "😢", "😡", "👍", "👎", "👏", "🙏", "💪", "🎉", "🔥", "❤️", "💯", "✅", "❌", "⭐", "🚀", "💡", "🎯", "📌", "👀", "💀", "🎵", "💰", "📅", "🔒", "🔑", "💬", "🍕", "☕"];

type CommandSuggestion = BotManifest["commands"][number] & { botId: string; botName: string };

export const ChatComposer = ({
  draft,
  emojiPickerOpen,
  fileInputRef,
  handleFileUpload,
  handlePaste,
  handleTypingChange,
  inputActions,
  insertEmoji,
  isE2e,
  isLight,
  onSubmit,
  pendingReply,
  p2pBlocked,
  policy,
  senderNames,
  setDraft,
  setEmojiPickerOpen,
  setPolicy,
  setReplyMessage,
  stopTyping,
  suggestions,
  themeBorder,
  themeBtn,
  uploading
}: {
  draft: string;
  emojiPickerOpen: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  handleFileUpload: (file: File) => void;
  handlePaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  handleTypingChange: (value: string) => void;
  inputActions: InputAction[];
  insertEmoji: (emoji: string) => void;
  isE2e: boolean;
  isLight: boolean;
  onSubmit: (event: FormEvent) => void;
  pendingReply: Message | null;
  p2pBlocked: boolean;
  policy: DisappearingDraftPolicy;
  senderNames: Record<string, string>;
  setDraft: (draft: string) => void;
  setEmojiPickerOpen: (open: boolean) => void;
  setPolicy: (policy: DisappearingDraftPolicy) => void;
  setReplyMessage: (message: Message | null) => void;
  stopTyping: () => void;
  suggestions: CommandSuggestion[];
  themeBorder: string;
  themeBtn: string;
  uploading: Array<{ name: string; progress: number; cancel: () => void }>;
}) => (
  <form className="m-0" onSubmit={onSubmit}>
    {pendingReply ? (
      <div className={`mx-4 mb-1 flex items-center gap-2 rounded-t-xl border-l-4 border-sky-400 px-4 py-2 ${isLight ? "bg-sky-50" : "bg-sky-500/10"}`}>
        <span className="text-xs text-sky-400">Replying to</span>
        <span className="text-xs font-medium text-sky-300">{senderNames[pendingReply.senderId] ?? pendingReply.senderId.slice(0, 10)}</span>
        <span className="flex-1 truncate text-xs text-slate-400">{pendingReply.content.type === "text" ? pendingReply.content.text.slice(0, 60) : "message"}</span>
        <button className="rounded px-1 text-xs text-slate-400 hover:text-slate-200" type="button" onClick={() => setReplyMessage(null)}>✕</button>
      </div>
    ) : null}
    <InputActionBar
      actions={
        <>
          {!isE2e
            ? inputActions.map((action) => (
                <button key={action.id} className={`rounded-full ${themeBtn} px-3 py-1 text-xs`} type="button" onClick={() => setDraft(action.command)}>
                  {action.label}
                </button>
              ))
            : null}
          <PolicyControl isE2e={isE2e} policy={policy} onChange={setPolicy} />
        </>
      }
    >
      <input ref={fileInputRef} className="hidden" type="file" multiple onChange={(event) => { const files = event.target.files; if (files) for (let index = 0; index < files.length; index += 1) handleFileUpload(files[index]!); event.target.value = ""; }} />
      <div className={`flex flex-1 items-center gap-1 rounded-xl border px-2 transition ${isLight ? "bg-white border-slate-300 focus-within:ring-2 focus-within:ring-sky-400" : "bg-slate-800 border-slate-700 focus-within:ring-2 focus-within:ring-sky-400"}`}>
        {!isE2e ? (
          <button className="rounded-full p-1 text-slate-400 hover:text-slate-200" type="button" onClick={() => fileInputRef.current?.click()} title="Attach">📎</button>
        ) : null}
        <div className="relative flex-1">
          {suggestions.length ? (
            <div className={`absolute bottom-full left-0 z-10 mb-1 w-full max-w-lg overflow-hidden rounded-2xl border ${themeBorder} ${isLight ? "bg-white shadow-lg" : "bg-slate-900 shadow-xl"}`}>
              {suggestions.map((suggestion) => (
                <button key={`${suggestion.botId}-${suggestion.name}`} className={`block w-full px-4 py-3 text-left text-sm ${isLight ? "hover:bg-slate-100" : "hover:bg-slate-800"}`} type="button" onClick={() => setDraft(`${suggestion.name} `)}>
                  <span className="font-medium text-sky-200">{suggestion.name}</span>
                  <span className="ml-2 text-slate-400">{suggestion.description}</span>
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            className={`w-full resize-none bg-transparent px-2 py-3 text-sm outline-none placeholder:text-slate-400 ${isLight ? "text-slate-900" : "text-slate-200"}`}
            placeholder={p2pBlocked ? "P2P mode: peer is offline" : isE2e ? "Encrypted message" : "Message or /command"}
            value={draft}
            disabled={p2pBlocked}
            onChange={(event) => handleTypingChange(event.target.value)}
            onBlur={stopTyping}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(event as unknown as FormEvent); }
            }}
            rows={1}
          />
        </div>
        <div className="relative">
          <button className="rounded-full p-1 text-slate-400 hover:text-slate-200" type="button" onClick={() => setEmojiPickerOpen(!emojiPickerOpen)} title="Emoji">😀</button>
          {emojiPickerOpen ? (
            <div className={`absolute bottom-full right-0 z-30 mb-1 grid w-72 grid-cols-8 gap-1 rounded-xl border p-2 shadow-xl ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"}`}>
              {MESSAGE_EMOJIS.map((emoji) => (
                <button key={emoji} className="rounded-lg p-1 text-lg hover:bg-slate-700" type="button" onClick={() => { insertEmoji(emoji); setEmojiPickerOpen(false); }}>{emoji}</button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {uploading.map((entry) => (
        <div key={entry.name} className="flex items-center gap-2 px-1 text-xs text-slate-400">
          <span className="truncate">{entry.name}</span>
          <div className="h-1 flex-1 rounded-full bg-slate-700">
            <div className="h-full rounded-full bg-sky-400" style={{ width: `${entry.progress}%` }} />
          </div>
          <button className="text-red-400 hover:text-red-300" type="button" onClick={entry.cancel}>✕</button>
        </div>
      ))}
    </InputActionBar>
  </form>
);
