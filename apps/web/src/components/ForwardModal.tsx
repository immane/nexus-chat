import type { Channel } from "@nexus-chat/shared";

export const ForwardModal = ({
  activeChannelId,
  channels,
  forwardSearch,
  isLight,
  onCancel,
  onForwardToChannel,
  setForwardSearch,
  themeBtn,
  themeInput
}: {
  activeChannelId: string | undefined;
  channels: Channel[];
  forwardSearch: string;
  isLight: boolean;
  onCancel: () => void;
  onForwardToChannel: (channelId: string) => void;
  setForwardSearch: (value: string) => void;
  themeBtn: string;
  themeInput: string;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
    <div className={`w-80 rounded-2xl border ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"} p-4 shadow-2xl`} onClick={(event) => event.stopPropagation()}>
      <h3 className="mb-2 text-sm font-semibold">Forward message</h3>
      <input className={`mb-2 w-full rounded-lg ${themeInput} px-3 py-2 text-sm outline-none`} placeholder="Search channels..." value={forwardSearch} onChange={(event) => setForwardSearch(event.target.value)} autoFocus />
      <div className="max-h-48 space-y-0.5 overflow-y-auto">
        {channels.filter((channel) => channel.id !== activeChannelId && (!forwardSearch || channel.name.toLowerCase().includes(forwardSearch.toLowerCase()))).map((channel) => (
          <button
            key={channel.id}
            className={`w-full rounded-lg px-3 py-2 text-left text-sm ${isLight ? "hover:bg-slate-100 text-slate-700" : "hover:bg-slate-800 text-slate-300"}`}
            type="button"
            onClick={() => onForwardToChannel(channel.id)}
          >{channel.kind === "dm" ? "@" : "#"} {channel.name}</button>
        ))}
      </div>
      <button className={`mt-3 w-full rounded-lg px-3 py-2 text-sm ${themeBtn}`} type="button" onClick={onCancel}>Cancel</button>
    </div>
  </div>
);
