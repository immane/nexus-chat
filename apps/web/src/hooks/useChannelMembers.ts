import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api.js";

export type ChatMember = { userId: string; role: string; displayName?: string; email?: string };
export type ChannelMemberView = { channelId: string; userId: string; role?: string };

export const useChannelMembers = ({
  accessToken,
  activeChannelId,
  workspaceId
}: {
  accessToken: string | undefined;
  activeChannelId: string | undefined;
  workspaceId: string | undefined;
}) => {
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [channelMembers, setChannelMembers] = useState<ChannelMemberView[]>([]);
  const [addMemberInput, setAddMemberInput] = useState("");

  useEffect(() => {
    if (!accessToken || !workspaceId || members.length > 0) return;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/workspaces/${workspaceId}/members`, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const json = (await resp.json()) as { ok: boolean; data: Array<{ userId: string; role: string; email: string; displayName: string }> };
        if (json.ok) setMembers(json.data.map((member) => ({ ...member, displayName: member.displayName || (member.email?.split("@")[0] ?? member.userId.slice(0, 10)) })));
      } catch { /* */ }
    })();
  }, [accessToken, members.length, workspaceId]);

  useEffect(() => {
    if (!accessToken || !activeChannelId) { setChannelMembers([]); return; }
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members`, { headers: { authorization: `Bearer ${accessToken}` } });
        const json = (await resp.json()) as { ok: boolean; data: ChannelMemberView[] };
        if (json.ok) setChannelMembers(json.data);
      } catch { setChannelMembers([]); }
    })();
  }, [accessToken, activeChannelId]);

  const addChannelMember = async () => {
    if (!addMemberInput.trim() || !accessToken || !activeChannelId) return;
    try {
      await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ userId: addMemberInput.trim() }) });
      setAddMemberInput("");
      const resp = await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members`, { headers: { authorization: `Bearer ${accessToken}` } });
      const json = (await resp.json()) as { ok: boolean; data: ChannelMemberView[] };
      if (json.ok) setChannelMembers(json.data);
    } catch { /* */ }
  };

  const removeChannelMember = async (userId: string) => {
    if (!accessToken || !activeChannelId) return;
    try {
      await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members/${userId}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
      setChannelMembers((prev) => prev.filter((member) => member.userId !== userId));
    } catch { /* */ }
  };

  const senderNames = Object.fromEntries(members.map((member) => [member.userId, member.displayName ?? member.email?.split("@")[0] ?? member.userId.slice(0, 10)]));

  return {
    addChannelMember,
    addMemberInput,
    channelMembers,
    members,
    removeChannelMember,
    senderNames,
    setAddMemberInput
  };
};
