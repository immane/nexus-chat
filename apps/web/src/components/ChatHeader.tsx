import { Badge } from "@nexus-chat/ui";
import type { Channel } from "@nexus-chat/shared";
import type { DmTransportMode } from "../stores/domain.js";
import { useUiStore } from "../stores/domain.js";

export const ChatHeader = ({
  activeChannel,
  activeChannelId,
  compact,
  dmTransportMode,
  isDm,
  isE2e,
  peerOnline,
  rightSidebarOpen,
  setDmTransportMode,
  setRightSidebarOpen,
  themeHeader,
  themeSelect,
  themeTabActive,
  themeTabInactive,
  typingUsers,
  wsConnected,
  wsVisible
}: {
  activeChannel: Channel | undefined;
  activeChannelId: string | undefined;
  compact: string;
  dmTransportMode: DmTransportMode;
  isDm: boolean;
  isE2e: boolean;
  peerOnline: boolean;
  rightSidebarOpen: boolean;
  setDmTransportMode: (mode: DmTransportMode) => void;
  setRightSidebarOpen: (open: boolean) => void;
  themeHeader: string;
  themeSelect: string;
  themeTabActive: string;
  themeTabInactive: string;
  typingUsers: Record<string, string>;
  wsConnected: boolean;
  wsVisible: boolean;
}) => {
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const typingUserIds = activeChannelId ? Object.entries(typingUsers).filter(([, chId]) => chId === activeChannelId).map(([uid]) => uid) : [];

  return (
    <header className={`border-b ${themeHeader} ${compact}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button className="md:hidden flex flex-col gap-1 p-1" type="button" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Toggle sidebar">
          <span className="block h-0.5 w-5 bg-current rounded" />
          <span className="block h-0.5 w-5 bg-current rounded" />
          <span className="block h-0.5 w-5 bg-current rounded" />
        </button>
        <h2 className="text-lg font-semibold">{activeChannel?.name ?? "Select a channel"}</h2>
        {isE2e ? <Badge tone="warning">Encrypted DM</Badge> : <Badge tone="success">Bots enabled</Badge>}
        {isDm ? (
          <select
            className={`rounded-lg ${themeSelect} px-2 py-1 text-xs`}
            value={dmTransportMode}
            onChange={(event) => setDmTransportMode(event.target.value as DmTransportMode)}
          >
            <option value="auto">Auto</option>
            <option value="relay">Signal</option>
            <option value="p2p">P2P</option>
          </select>
        ) : null}
        {isDm ? <Badge tone={peerOnline ? "success" : "warning"}>{peerOnline ? "Online" : "Offline"}</Badge> : null}
        {wsVisible ? <Badge tone={wsConnected ? "success" : "warning"}>{wsConnected ? "WS connected" : "WS disconnected"}</Badge> : null}
        <div className="ml-auto flex items-center gap-2">
          <button className={`rounded-lg px-3 py-1 text-sm transition ${rightSidebarOpen ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title="Group Members">👥 Members</button>
        </div>
      </div>
      {isE2e ? <p className="mt-2 text-sm text-amber-200">Bots, slash commands, previews, and server-side search are disabled here.</p> : null}
      {typingUserIds.length > 0 ? <p className="mt-1 text-xs italic text-slate-400">{typingUserIds.map((uid) => uid.slice(0, 10)).join(", ")} typing...</p> : null}
    </header>
  );
};
