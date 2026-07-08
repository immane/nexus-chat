import { useState, useEffect, useCallback } from "react";
import type { Channel, Workspace } from "@nexus-chat/shared";
import { request } from "../lib/api.js";

type ChatMember = { userId: string; role: string; displayName?: string; email?: string };

export const useChannelData = () => {
  const [workspaceId, setWorkspaceId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [members, setMembers] = useState<ChatMember[]>([]);
  const [senderNames, setSenderNames] = useState<Record<string, string>>({});
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const wsList = await request<Workspace[]>("/api/v1/workspaces");
        if (wsList.length === 0) {
          setError("No workspaces found. Create one first with: nexus workspace-create");
          setLoading(false);
          return;
        }
        const wid = wsList[0]!.id;
        setWorkspaceId(wid);

        const [chList, memberList] = await Promise.all([
          request<Channel[]>(`/api/v1/workspaces/${wid}/channels`),
          request<Array<{ userId: string; role: string; email: string; displayName: string }>>(`/api/v1/workspaces/${wid}/members`)
        ]);

        setChannels(chList);
        setMembers(memberList);

        const names: Record<string, string> = {};
        for (const m of memberList) {
          names[m.userId] = m.displayName || m.email?.split("@")[0] || m.userId.slice(0, 10);
        }
        setSenderNames(names);
      } catch (err) {
        setError(String(err));
      }
      setLoading(false);
    })();
  }, []);

  const setOnline = useCallback((userId: string, online: boolean) => {
    setOnlineUserIds((prev) => {
      const next = new Set(prev);
      if (online) next.add(userId);
      else next.delete(userId);
      return next;
    });
  }, []);

  const addChannel = useCallback((channel: Channel) => {
    setChannels((prev) => {
      if (prev.some((c) => c.id === channel.id)) return prev;
      return [...prev, channel];
    });
  }, []);

  const createChannel = useCallback(async (name: string) => {
    if (!workspaceId) return;
    try {
      const ch = await request<Channel>(`/api/v1/workspaces/${workspaceId}/channels`, {
        method: "POST",
        body: JSON.stringify({ name, mode: "normal" })
      });
      setChannels((prev) => [...prev, ch]);
      return ch;
    } catch {
      // ignore
    }
    return undefined;
  }, [workspaceId]);

  return {
    addChannel,
    channels,
    createChannel,
    error,
    loading,
    members,
    onlineUserIds,
    senderNames,
    setOnline,
    workspaceId
  };
};
