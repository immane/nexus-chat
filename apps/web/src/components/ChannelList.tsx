import type { Channel } from "@nexus-chat/shared";
import { Badge } from "@nexus-chat/ui";
import { useUiStore } from "../stores/domain.js";

const resolveDmDisplay = (channel: Channel, currentUserId?: string, userNames?: Record<string, string>) => {
  if (channel.kind !== "dm") return null;
  const parts = channel.name.split(":");
  if (parts.length < 3) return null;
  const peerId = parts[1] === currentUserId ? parts[2] : parts[1];
  const display = userNames?.[peerId ?? ""] ?? peerId?.slice(0, 10) ?? "?";
  return { peerId: peerId ?? "?", display };
};

export const ChannelList = ({
  channels,
  activeChannelId,
  unreadCounts,
  onSelect,
  currentUserId,
  userNames
}: {
  channels: Channel[];
  activeChannelId: string | undefined;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
  currentUserId?: string;
  userNames?: Record<string, string>;
}) => {
  const settings = useUiStore((state) => state.settings);
  const themeSideActive = settings.theme === "light" ? "bg-sky-100 text-sky-700 ring-sky-300" : "bg-sky-500/20 text-sky-100 ring-sky-400/30";
  const themeSideBtn = settings.theme === "light" ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-900 text-slate-300 hover:bg-slate-800";
  return (
  <div className="space-y-2">
    {channels.map((channel) => {
      const dm = resolveDmDisplay(channel, currentUserId, userNames);
      return (
      <button
        key={channel.id}
        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition ${
          channel.id === activeChannelId ? themeSideActive : themeSideBtn
        }`}
        type="button"
        onClick={() => onSelect(channel.id)}
        title={dm ? channel.name : undefined}
      >
        <span>
          {channel.kind === "dm" ? "@" : "#"}
          {dm ? dm.display : channel.name}
        </span>
        <span className="flex items-center gap-2">
          {unreadCounts[channel.id] ? <Badge tone="success">{unreadCounts[channel.id]}</Badge> : null}
          {channel.mode === "e2e" ? <Badge tone="warning">E2E</Badge> : null}
        </span>
      </button>
      );
    })}
  </div>
  );
};
