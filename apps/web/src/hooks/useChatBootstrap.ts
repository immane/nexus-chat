/**
 * useChatBootstrap — Initial Data Loading Hub
 *
 * Fires once on mount (guarded by dataLoadedRef) to bootstrap the entire
 * chat UI with initial data from the server:
 * - Validates persisted token via /api/v1/auth/me (clears auth if invalid)
 * - Fetches workspaces, channels, messages, reactions, unread counts
 * - Installs bot manifests and joins bots to channels
 *
 * Also handles:
 * - Setting currentUserId on the message store
 * - Requesting browser notification permission
 *
 * Design Decision:
 * This is a single monolithic hook rather than per-domain hooks because
 * the initial load has sequential dependencies (workspaces → channels →
 * messages) and we want a single loading gate. Individual domain hooks
 * handle subsequent updates.
 *
 * Does NOT:
 * - Handle real-time updates (handled by WebSocket event handlers in ChatRoute)
 * - Refresh data after the initial bootstrap (page reload required)
 */
import { useEffect, useRef } from "react";
import type { BotManifest, Channel, Message, Workspace } from "@nexus-chat/shared";
import { API_BASE } from "../lib/api.js";
import { useAuthStore, useBotStore, useChannelStore, useMessageStore, useWorkspaceStore } from "../stores/domain.js";

export const useChatBootstrap = () => {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const clearAuth = useAuthStore((state) => state.clear);
  const setMessageCurrentUser = useMessageStore((state) => state.setCurrentUser);
  const upsertMessage = useMessageStore((state) => state.upsert);
  const setManifests = useBotStore((state) => state.setManifests);
  const setChannels = useChannelStore((state) => state.setChannels);
  const setActiveChannel = useChannelStore((state) => state.setActive);
  const setUnread = useChannelStore((state) => state.setUnread);
  const setWorkspaces = useWorkspaceStore((state) => state.setWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActive);
  const dataLoadedRef = useRef(false);

  useEffect(() => {
    if (user) setMessageCurrentUser(user.id);
  }, [user, setMessageCurrentUser]);

  useEffect(() => {
    if ("Notification" in window && window.Notification.permission === "default") {
      window.Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!accessToken || accessToken === "demo-access-token") return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        if (!cancelled && !resp.ok) clearAuth();
      } catch {
        // Server not reachable; keep the session for offline retry.
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, clearAuth]);

  useEffect(() => {
    if (!accessToken || dataLoadedRef.current) return;
    dataLoadedRef.current = true;
    (async () => {
      try {
        const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
        const w = await fetch(`${API_BASE}/api/v1/workspaces`, { headers });
        const wJson = (await w.json()) as { ok: boolean; data: Workspace[] };
        if (!wJson.ok || !wJson.data?.length) return;
        setWorkspaces(wJson.data);
        setActiveWorkspace(wJson.data[0]!.id);

        // Seed bot manifests until the server exposes a manifest endpoint.
        const botManifests = [
          { id: "bot-help", name: "help", description: "Lists available commands.", commands: [{ name: "/help", description: "Show command help." }], scopes: ["commands:handle", "messages:write"] },
          { id: "bot-notification", name: "notification", description: "Sends announcements.", commands: [{ name: "/announce", description: "Send an announcement." }], scopes: ["commands:handle", "messages:write"] }
        ] as BotManifest[];
        setManifests(botManifests);

        for (const manifest of botManifests) {
          await fetch(`${API_BASE}/api/v1/bots/install?workspaceId=${encodeURIComponent(wJson.data[0]!.id)}`, {
            method: "POST",
            headers,
            body: JSON.stringify(manifest)
          }).catch(() => {});
        }

        const ch = await fetch(`${API_BASE}/api/v1/workspaces/${wJson.data[0]!.id}/channels`, { headers });
        const chJson = (await ch.json()) as { ok: boolean; data: Channel[] };
        if (chJson.ok && chJson.data?.length) {
          setChannels(chJson.data);
          setActiveChannel(chJson.data[0]!.id);
          setUnread(chJson.data[0]!.id, 0);

          const unreadResp = await fetch(`${API_BASE}/api/v1/workspaces/${wJson.data[0]!.id}/unread-counts`, { headers });
          const unreadJson = (await unreadResp.json()) as { ok: boolean; data: Record<string, number> };
          if (unreadJson.ok && unreadJson.data) {
            for (const [channelId, count] of Object.entries(unreadJson.data)) {
              useChannelStore.getState().setUnread(channelId, count);
            }
          }

          for (const channel of chJson.data) {
            const msgs = await fetch(`${API_BASE}/api/v1/channels/${channel.id}/messages?limit=50`, { headers });
            const msgsJson = (await msgs.json()) as { ok: boolean; data: Message[] };
            if (msgsJson.ok && Array.isArray(msgsJson.data)) {
              msgsJson.data.forEach((message: Message) => upsertMessage(message, "sent"));
            }

            const reactResp = await fetch(`${API_BASE}/api/v1/channels/${channel.id}/reactions`, { headers });
            const reactJson = (await reactResp.json()) as { ok: boolean; data: Record<string, Array<{ emoji: string; count: number; reacted: boolean }>> };
            if (reactJson.ok && reactJson.data) {
              const state = useMessageStore.getState();
              for (const [messageId, emojiList] of Object.entries(reactJson.data)) {
                for (const item of emojiList) {
                  state.setReaction(messageId, item.emoji, item.count, item.reacted);
                }
              }
            }

            if (channel.mode === "normal") {
              for (const manifest of botManifests) {
                await fetch(`${API_BASE}/api/v1/bots/${manifest.id}/channels/${channel.id}`, {
                  method: "POST",
                  headers
                }).catch(() => {});
              }
            }
          }
        }
      } catch { /* server may be down */ }
    })();
  }, [accessToken, setActiveChannel, setActiveWorkspace, setChannels, setManifests, setUnread, setWorkspaces, upsertMessage]);
};
