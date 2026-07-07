export type ChatMember = { userId: string; role: string; displayName?: string; email?: string };
export type ChannelMemberView = { channelId: string; userId: string; role?: string };

export const RightMemberPanel = ({
  addChannelMember,
  addMemberInput,
  channelMembers,
  compact,
  currentUserId,
  members,
  onlineUserIds,
  removeChannelMember,
  setAddMemberInput,
  setRightSidebarOpen,
  themeAside,
  themeBtn,
  themeInput,
  themeMember,
  themeMemberBadge,
  themeMuted,
  themeSectionTitle
}: {
  addChannelMember: () => void;
  addMemberInput: string;
  channelMembers: ChannelMemberView[];
  compact: string;
  currentUserId: string | undefined;
  members: ChatMember[];
  onlineUserIds: Set<string>;
  removeChannelMember: (userId: string) => void;
  setAddMemberInput: (value: string) => void;
  setRightSidebarOpen: (open: boolean) => void;
  themeAside: string;
  themeBtn: string;
  themeInput: string;
  themeMember: string;
  themeMemberBadge: string;
  themeMuted: string;
  themeSectionTitle: string;
}) => (
  <aside className={`border-l ${themeAside} max-md:hidden overflow-y-auto`}>
    <div className={`${compact}`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Group Members ({channelMembers.length})</h2>
        <button className={`rounded-lg ${themeBtn} px-2 py-0.5 text-xs`} type="button" onClick={() => setRightSidebarOpen(false)}>✕</button>
      </div>
      <div className="mb-2 flex gap-1">
        <input className={`flex-1 rounded-lg ${themeInput} px-2 py-1 text-xs outline-none`} placeholder="User ID to add..." value={addMemberInput} onChange={(event) => setAddMemberInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addChannelMember(); }} />
        <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={addChannelMember}>Add</button>
      </div>
      <div className="space-y-1">
        {channelMembers.map((channelMember) => {
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
        {channelMembers.length === 0 ? <p className={`px-2 text-xs ${themeMuted}`}>No members yet</p> : null}
      </div>
    </div>
  </aside>
);
