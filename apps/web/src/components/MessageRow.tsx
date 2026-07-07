import type { Message } from "@nexus-chat/shared";
import { Badge } from "@nexus-chat/ui";
import { useUiStore } from "../stores/domain.js";

export const MessageRow = ({ message, status, decryptedText }: { message: Message; status: string | undefined; decryptedText?: string }) => {
  const settings = useUiStore((state) => state.settings);
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const themeCard = settings.theme === "light" ? "bg-white ring-slate-200" : "bg-slate-900/80 ring-slate-800";
  const compactMsg = settings.compactMode ? "mx-2 my-1 p-2 text-xs" : "mx-4 my-2 p-4 text-sm";
  const [sendStatus, transportLabel] = status?.split(" · ") ?? [];
  const transportName = transportLabel?.startsWith("p2p") ? "p2p" : transportLabel?.startsWith("relay") ? "relay" : undefined;
  if (message.content.type === "tombstone") {
    const reason = message.content.reason === "read_once_consumed" ? "Read-once message consumed" : "Message expired";
    return <article className="mx-4 my-2 rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-4 text-sm text-slate-400"><span className="text-xs text-slate-500">{time}</span> {reason}</article>;
  }

  const policyLabel = message.content.type === "ciphertext" && message.content.readOnce ? "Read once" : message.content.type === "ciphertext" && message.content.expiresAt ? "Disappearing" : undefined;
  const body = message.content.type === "text" ? message.content.text : decryptedText ?? "Decrypting encrypted message...";

  return (
    <article className={`rounded-2xl ${themeCard} ${compactMsg} shadow-sm`}>
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-300">{message.senderId.slice(0, 12)}</span>
        <span>{time}</span>
        {policyLabel ? <Badge tone="warning">{policyLabel}</Badge> : null}
        {sendStatus === "sending" ? <span className="italic text-amber-300">sending...</span> : sendStatus === "sent" && transportLabel?.endsWith("received") ? <span className="text-sky-300">↓ received{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "sent" ? <span className="text-emerald-400">✓ sent{transportName ? ` (${transportName})` : ""}</span> : sendStatus === "failed" ? <span className="text-red-400">✗ failed</span> : null}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{body}</p>
    </article>
  );
};
