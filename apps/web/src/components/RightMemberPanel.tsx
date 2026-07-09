import { useState, useMemo } from "react";

export type ChatMember = { userId: string; role: string; displayName?: string; email?: string };
export type ChannelMemberView = { channelId: string; userId: string };

export const RightMemberPanel = ({
  addChannelMember,
  channelMembers,
  compact,
  currentUserId,
  members,
  onlineUserIds,
  removeChannelMember,
  setRightSidebarOpen,
  themeAside,
  themeBtn,
  themeInput,
  themeMember,
  themeMemberBadge,
  themeMuted,
  themeSectionTitle
}: {
  addChannelMember: (userId?: string) => void;
  channelMembers: ChannelMemberView[];
  compact: string;
  currentUserId: string | undefined;
  members: ChatMember[];
  onlineUserIds: Set<string>;
  removeChannelMember: (userId: string) => void;
  setRightSidebarOpen: (open: boolean) => void;
  themeAside: string;
  themeBtn: string;
  themeInput: string;
  themeMember: string;
  themeMemberBadge: string;
  themeMuted: string;
  themeSectionTitle: string;
}) => {
  const [searchFilter, setSearchFilter] = useState("");
  const channelMemberIds = useMemo(() => new Set(channelMembers.map((cm) => cm.userId)), [channelMembers]);

  const filtered = searchFilter.trim()
    ? channelMembers.filter((cm) => {
        const info = members.find((m) => m.userId === cm.userId);
        const name = info?.displayName ?? info?.email?.split("@")[0] ?? cm.userId.slice(0, 10);
        return name.toLowerCase().includes(searchFilter.toLowerCase());
      })
    : channelMembers;

  // Workspace members not yet in this channel, matching the search
  const suggestions = searchFilter.trim()
    ? members.filter((m) => !channelMemberIds.has(m.userId) && m.userId !== currentUserId).filter((m) => {
        const name = m.displayName ?? m.email?.split("@")[0] ?? m.userId.slice(0, 10);
        return name.toLowerCase().includes(searchFilter.toLowerCase()) || m.userId.includes(searchFilter);
      })
    : [];

  return (
    <aside className={`md:border-l ${themeAside} md:relative max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-50 max-md:max-h-[55vh] max-md:rounded-t-2xl max-md:shadow-2xl overflow-y-auto`}>
      <div className="md:hidden sticky top-0 flex justify-center pt-2 pb-1 bg-inherit">
        <div className="w-10 h-1 rounded-full bg-slate-500" />
      </div>
      <div className={`${compact}`}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Group Members ({filtered.length}{searchFilter ? ` / ${channelMembers.length}` : ""})</h2>
          <button className={`rounded-lg ${themeBtn} px-2 py-0.5 text-xs`} type="button" onClick={() => setRightSidebarOpen(false)}>✕</button>
        </div>
        <div className="mb-2 flex gap-1">
          <input className={`flex-1 rounded-lg ${themeInput} px-2 py-1 text-xs outline-none`} placeholder="Search members..." value={searchFilter} onChange={(event) => setSearchFilter(event.target.value)} />
          <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={() => { if (searchFilter.trim()) addChannelMember(searchFilter.trim()); setSearchFilter(""); }}>Add</button>
        </div>
        {suggestions.length > 0 ? (
          <div className={`mb-2 rounded-lg border ${themeAside} max-h-32 overflow-y-auto`}>
            {suggestions.map((m) => (
              <button
                key={m.userId}
                className={`w-full px-2 py-1.5 text-left text-xs ${themeMember} flex items-center gap-2`}
                type="button"
                onClick={() => { addChannelMember(m.userId); setSearchFilter(""); }}
              >
                <span className={`h-2 w-2 rounded-full ${onlineUserIds.has(m.userId) ? "bg-emerald-400" : "bg-slate-500"}`}></span>
                <span>{m.displayName ?? m.email?.split("@")[0] ?? m.userId.slice(0, 10)}</span>
                <span className={themeMuted}>+ Add</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="space-y-1">
          {filtered.map((channelMember) => {
            const memberInfo = members.find((member) => member.userId === channelMember.userId);
            return (
              <div key={channelMember.userId} className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-xs ${themeMember}`}>
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${onlineUserIds.has(channelMember.userId) ? "bg-emerald-400" : "bg-slate-500"}`}></span>
                  <span>{memberInfo?.displayName ?? channelMember.userId.slice(0, 10)}</span>
                </div>
                {channelMember.userId !== currentUserId ? (
                  <button className={`rounded ${themeMemberBadge} px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-200 transition`} type="button" onClick={() => removeChannelMember(channelMember.userId)} title="Remove">✕</button>
                ) : null}
              </div>
            );
          })}
          {filtered.length === 0 ? <p className={`px-2 text-xs ${themeMuted}`}>{searchFilter ? "No matching members" : "No members yet"}</p> : null}
        </div>
      </div>
    </aside>
  );
};