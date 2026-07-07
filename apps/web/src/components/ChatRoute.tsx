import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import { Badge, InputActionBar } from "@nexus-chat/ui";
import type { BotManifest, Channel, Message, Workspace } from "@nexus-chat/shared";
import {
  createInMemorySignalSessionStore,
  createLocalSignalIdentity,
  decryptFromSession,
  encryptForSession,
  extractOneTimePreKeys,
  toPreKeyBundle,
  type LocalSignalIdentity,
  type SignalSession
} from "@nexus-chat/signal";
import { HybridTransport, P2pConnectionPool, sendP2pEvent } from "../lib/p2p/index.js";
import {
  createOptimisticMessage,
  getCommandSuggestions,
  selectChannelMessages,
  useAuthStore,
  useBotStore,
  useChannelStore,
  useMessageStore,
  useUiStore,
  useWorkspaceStore
} from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";
import { WEB_SIGNAL_DEVICE_ID, parseDmPeerUserId, applyDisappearingPolicy, ensureSignalSession as doEnsureSignalSession, type TransportLabel } from "./signal-helpers.js";
import { ChannelList } from "./ChannelList.js";
import { MessageList } from "./MessageList.js";
import PolicyControl from "./PolicyControl.js";

const ChatRoute = () => {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const channels = useChannelStore((state) => state.channels);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const unreadCounts = useChannelStore((state) => state.unreadCounts);
  const setActiveChannel = useChannelStore((state) => state.setActive);
  const setChannels = useChannelStore((state) => state.setChannels);
  const messagesMap = useMessageStore((state) => state.messages);
  const order = useMessageStore((state) => state.order);
  const statuses = useMessageStore((state) => state.sendStatusByClientId);
  const sendOptimistic = useMessageStore((state) => state.sendOptimistic);
  const upsertMessage = useMessageStore((state) => state.upsert);
  const setManifests = useBotStore((state) => state.setManifests);
  const manifests = useBotStore((state) => state.manifests);
  const inputActions = useBotStore((state) => state.inputActions);
  const draft = useUiStore((state) => state.messageDraft);
  const policy = useUiStore((state) => state.disappearingPolicy);
  const settings = useUiStore((state) => state.settings);
  const updateSettings = useUiStore((state) => state.updateSettings);
  const setDraft = useUiStore((state) => state.setMessageDraft);
  const setPolicy = useUiStore((state) => state.setDisappearingPolicy);
  const setWorkspaces = useWorkspaceStore((state) => state.setWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActive);
  const deferredDraft = useDeferredValue(draft);
  const socketRef = useRef<Socket | undefined>(undefined);
  const p2pTransportRef = useRef<HybridTransport | undefined>(undefined);
  const signalIdentityRef = useRef<LocalSignalIdentity | undefined>(undefined);
  const signalSessionStoreRef = useRef(createInMemorySignalSessionStore());
  const signalSessionsRef = useRef(new Map<string, SignalSession>());
  const [wsConnected, setWsConnected] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [transportLabels, setTransportLabels] = useState<Record<string, TransportLabel>>({});
  const [channelCreateOpen, setChannelCreateOpen] = useState(false);
  const [dmCreateOpen, setDmCreateOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newDmEmail, setNewDmEmail] = useState("");
  const [dmError, setDmError] = useState("");
  const [members, setMembers] = useState<Array<{ userId: string; role: string; displayName?: string; email?: string }>>([]);
  const [leftTab, setLeftTab] = useState<"chat" | "member" | "settings">("chat");
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [channelMembers, setChannelMembers] = useState<Array<{ channelId: string; userId: string; role?: string }>>([]);
  const [addMemberInput, setAddMemberInput] = useState("");
  const [friendSearchInput, setFriendSearchInput] = useState("");
  const clearAuth = useAuthStore((state) => state.clear);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const channelMessages = selectChannelMessages(messagesMap, order, activeChannelId);
  const isE2e = activeChannel?.mode === "e2e";
  const suggestions = isE2e ? [] : getCommandSuggestions(manifests, deferredDraft);

  const ensureSignalSession = async (peerUserId: string, peerDeviceId = WEB_SIGNAL_DEVICE_ID): Promise<SignalSession> =>
    doEnsureSignalSession({
      userId: user!.id,
      accessToken: accessToken!,
      identityRef: signalIdentityRef,
      sessionStoreRef: signalSessionStoreRef,
      sessionsRef: signalSessionsRef
    }, peerUserId, peerDeviceId);

  useEffect(() => {
    if (!user || !accessToken || accessToken === "demo-access-token") return;
    if (!signalIdentityRef.current) signalIdentityRef.current = createLocalSignalIdentity(user.id, WEB_SIGNAL_DEVICE_ID, 5);
    const identity = signalIdentityRef.current;
    const bundle = { ...toPreKeyBundle(identity), oneTimePreKeys: extractOneTimePreKeys(identity) };
    void fetch(`${API_BASE}/api/v1/signal/prekey-bundles`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(bundle)
    }).catch(() => {});
  }, [accessToken, user]);

  useEffect(() => {
    if (!accessToken || !user) return;
    const encryptedMessages = channelMessages.filter((message) => message.content.type === "ciphertext" && decryptedMessages[message.id] === undefined);
    if (!encryptedMessages.length) return;

    let cancelled = false;
    void (async () => {
      const updates: Record<string, string> = {};
      for (const message of encryptedMessages) {
        if (message.content.type !== "ciphertext") continue;
        try {
          const session = await ensureSignalSession(message.senderId, message.content.senderDeviceId);
          updates[message.id] = await decryptFromSession(session, message.content.ciphertext);
        } catch {
          updates[message.id] = "Unable to decrypt message";
        }
      }
      if (!cancelled && Object.keys(updates).length) setDecryptedMessages((current) => ({ ...current, ...updates }));
    })();

    return () => { cancelled = true; };
  }, [accessToken, channelMessages, decryptedMessages, user]);

  // Verify persisted token on mount; clear if expired
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
        // server not reachable — keep session for offline retry
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Connect to server and fetch data when in server mode
  useEffect(() => {
    if (!accessToken || workspaces.length > 0) return;
    (async () => {
      try {
        const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
        const w = await fetch(`${API_BASE}/api/v1/workspaces`, { headers });
        const wJson = (await w.json()) as { ok: boolean; data: Workspace[] };
        if (!wJson.ok || !wJson.data?.length) return;
        setWorkspaces(wJson.data);
        setActiveWorkspace(wJson.data[0]!.id);

        // Seed bot manifests (no server endpoint for manifests yet)
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

          for (const channel of chJson.data) {
            const msgs = await fetch(`${API_BASE}/api/v1/channels/${channel.id}/messages?limit=50`, { headers });
            const msgsJson = (await msgs.json()) as { ok: boolean; data: Message[] };
            if (msgsJson.ok && Array.isArray(msgsJson.data)) {
              msgsJson.data.forEach((m: Message) => upsertMessage(m, "sent"));
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
  }, [accessToken]);

  // WebSocket connection
  useEffect(() => {
    if (!accessToken) return;
    const socket = io(API_BASE, { transports: ["websocket"], auth: { token: accessToken } });
    socketRef.current = socket;
    const pool = new P2pConnectionPool((type, payload) => sendP2pEvent(socket, type, payload));
    const wsSend = (event: string, payload: unknown): Promise<unknown> => new Promise((resolve) => {
      socket.emit(event, payload, (response: unknown) => resolve(response));
    });
    p2pTransportRef.current = new HybridTransport(pool, socket, wsSend, (p2pMessage) => {
      const message: Message = {
        id: `p2p-${p2pMessage.clientMsgId}`,
        workspaceId: p2pMessage.workspaceId,
        channelId: p2pMessage.channelId,
        senderId: p2pMessage.senderId,
        clientMsgId: p2pMessage.clientMsgId,
        content: { ...p2pMessage.content, algorithm: "signal-v1", readOnce: p2pMessage.content.readOnce ?? false, attachments: [] },
        state: "sent",
        createdAt: p2pMessage.timestamp
      };
      upsertMessage(message, "sent");
      setTransportLabels((current) => ({ ...current, [message.clientMsgId]: "p2p received" }));
    });
    socket.on("connect", () => setWsConnected(true));
    socket.on("disconnect", () => setWsConnected(false));
    socket.on("event", (event: { type: string; payload: unknown }) => {
      if (event.type === "message.created" && event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
        const serverMsg = event.payload as Message;
        const state = useMessageStore.getState();
        // Skip if already added
        if (state.messages.has(serverMsg.id)) return;
        setTransportLabels((current) => ({ ...current, [serverMsg.clientMsgId]: serverMsg.senderId === user?.id ? "relay sent" : "relay received" }));
        // Find and remove optimistic duplicate by clientMsgId
        const dup = [...state.messages.values()].find((m) => m.clientMsgId === serverMsg.clientMsgId);
        if (dup) {
          const newMsgs = new Map(state.messages);
          newMsgs.delete(dup.id);
          newMsgs.set(serverMsg.id, serverMsg);
          useMessageStore.setState({ messages: newMsgs, order: state.order.map((id) => (id === dup.id ? serverMsg.id : id)) });
        } else {
          upsertMessage(serverMsg, "sent");
        }
      }
    });
    return () => {
      p2pTransportRef.current?.destroy();
      p2pTransportRef.current = undefined;
      socket.disconnect();
    };
  }, [accessToken, user?.id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !activeChannel || !draft.trim()) return;

    const text = draft.trim();
    const isSlashCommand = text.startsWith("/");
    const [cmdName, ...cmdArgs] = isSlashCommand ? text.split(/\s+/) : ["", []];
    const isDemoSession = accessToken === "demo-access-token";

    if (!socketRef.current?.connected && isDemoSession) {
      const msg = createOptimisticMessage({
        workspaceId: activeChannel.workspaceId,
        channelId: activeChannel.id,
        senderId: user.id,
        text,
        policy: isE2e ? policy : { mode: "none" }
      });
      upsertMessage(msg, "sent");

      if (!isE2e && cmdName === "/help") {
        const helpBot = manifests.find((manifest) => manifest.commands.some((command) => command.name === "/help"));
        if (helpBot) {
          const now = new Date().toISOString();
          const commands = helpBot.commands.map((command) => `${command.name} - ${command.description}`).join("\n");
          upsertMessage({
            id: `demo-bot-${Date.now()}`,
            workspaceId: activeChannel.workspaceId,
            channelId: activeChannel.id,
            senderId: helpBot.id,
            clientMsgId: `demo-bot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            content: { type: "text", text: `Available commands:\n${commands}`, attachments: [] },
            state: "sent",
            createdAt: now
          });
        }
      }

      setDraft("");
      return;
    }

    if (socketRef.current?.connected) {
      if (!isE2e && isSlashCommand && cmdName) {
        const msg = createOptimisticMessage({
          workspaceId: activeChannel.workspaceId,
          channelId: activeChannel.id,
          senderId: user.id,
          text,
          policy: isE2e ? policy : { mode: "none" }
        });
        sendOptimistic(msg);
        socketRef.current.emit(
          "event",
          {
            type: "bot.command.invoke",
            workspaceId: activeChannel.workspaceId,
            channelId: activeChannel.id,
            payload: {
              type: "bot.command.invoke",
              botName: cmdName.replace("/", ""),
              command: cmdName,
              workspaceId: activeChannel.workspaceId,
              channelId: activeChannel.id,
              args: cmdArgs
            },
            timestamp: new Date().toISOString(),
            encrypted: false
          },
          (response: { ok: boolean; error?: { message: string } }) => {
            useMessageStore.getState().upsert(msg, response.ok ? "sent" : "failed");
          }
        );
      } else {
        const clientMsgId = `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const peerUserId = activeChannel.kind === "dm" ? parseDmPeerUserId(activeChannel, user.id) : undefined;
        const session = isE2e ? await ensureSignalSession(peerUserId ?? user.id) : undefined;
        const encryptedContent = session ? applyDisappearingPolicy(await encryptForSession(session, text), policy) : undefined;

        if (isE2e && encryptedContent && peerUserId && p2pTransportRef.current) {
          const result = await p2pTransportRef.current.sendMessage({
            workspaceId: activeChannel.workspaceId,
            channelId: activeChannel.id,
            clientMsgId,
            content: encryptedContent,
            targetUserId: peerUserId
          });

          setTransportLabels((current) => ({ ...current, [clientMsgId]: result.path === "p2p" ? "p2p sent" : "relay sent" }));

          if (result.ok && result.path === "p2p") {
            const message: Message = {
              id: `p2p-local-${clientMsgId}`,
              workspaceId: activeChannel.workspaceId,
              channelId: activeChannel.id,
              senderId: user.id,
              clientMsgId,
              content: encryptedContent,
              state: "sent",
              createdAt: new Date().toISOString()
            };
            upsertMessage(message, "sent");
            setDecryptedMessages((current) => ({ ...current, [message.id]: text }));
          }

          setDraft("");
          return;
        }

        // Don't show optimistic — wait for server broadcast.
        socketRef.current.emit(
          "event",
          {
            type: "message.send",
            workspaceId: activeChannel.workspaceId,
            channelId: activeChannel.id,
            payload: {
              workspaceId: activeChannel.workspaceId,
              channelId: activeChannel.id,
              clientMsgId,
              content: encryptedContent ?? { type: "text" as const, text, attachments: [] }
            },
            timestamp: new Date().toISOString(),
            encrypted: Boolean(encryptedContent)
          }
        );
      }
    }
    setDraft("");
  };

  const createChannel = async () => {
    if (!newChannelName.trim() || !accessToken || !workspaces[0]) return;
    try {
      const resp = await fetch(`${API_BASE}/api/v1/workspaces/${workspaces[0].id}/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: newChannelName.trim(), mode: "normal" })
      });
      const json = (await resp.json()) as { ok: boolean; data: Channel };
      if (json.ok) {
        setChannels([...channels, json.data]);
        setActiveChannel(json.data.id);
      }
    } catch { /* */ }
    setNewChannelName("");
    setChannelCreateOpen(false);
  };

  const startDmWithUser = async (peerUserId: string) => {
    if (!accessToken || !workspaces[0]) return;
    const headers = { "content-type": "application/json", authorization: `Bearer ${accessToken}` };
    try {
      const resp = await fetch(`${API_BASE}/api/v1/dms?workspaceId=${workspaces[0].id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ peerUserId, mode: "e2e" })
      });
      const json = (await resp.json()) as { ok: boolean; data: Channel; error?: { message: string } };
      if (json.ok) {
        if (!channels.some((c) => c.id === json.data.id)) setChannels([...channels, json.data]);
        setActiveChannel(json.data.id);
        setLeftTab("chat");
      }
    } catch { /* ignore */ }
  };

  const createDm = async () => {
    if (!newDmEmail.trim() || !accessToken || !workspaces[0]) return;
    const headers = { "content-type": "application/json", authorization: `Bearer ${accessToken}` };
    setDmError("");
    try {
      let peerUserId = newDmEmail.trim();
      if (peerUserId.includes("@")) {
        const lookupResp = await fetch(`${API_BASE}/api/v1/users/by-email?email=${encodeURIComponent(peerUserId)}`, { headers });
        const lookupJson = (await lookupResp.json()) as { ok: boolean; data?: { id: string }; error?: { message: string } };
        if (!lookupJson.ok) {
          setDmError(lookupJson.error?.message ?? "User not found");
          return;
        }
        if (lookupJson.data?.id) peerUserId = lookupJson.data.id;
      }

      await startDmWithUser(peerUserId);
      setNewDmEmail("");
      setDmCreateOpen(false);
    } catch {
      setDmError("Network error — is the server running?");
    }
  };

  // Fetch members when in server mode
  useEffect(() => {
    if (!accessToken || !workspaces[0] || members.length > 0) return;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/workspaces/${workspaces[0]!.id}/members`, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const json = (await resp.json()) as { ok: boolean; data: Array<{ userId: string; role: string }> };
        if (json.ok) setMembers(json.data.map((m) => ({ ...m, displayName: m.userId.slice(0, 10) })));
      } catch { /* */ }
    })();
  }, [accessToken, workspaces]);

  // Fetch channel members
  useEffect(() => {
    if (!accessToken || !activeChannelId) { setChannelMembers([]); return; }
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members`, { headers: { authorization: `Bearer ${accessToken}` } });
        const json = (await resp.json()) as { ok: boolean; data: Array<{ channelId: string; userId: string }> };
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
      const json = (await resp.json()) as { ok: boolean; data: Array<{ channelId: string; userId: string }> };
      if (json.ok) setChannelMembers(json.data);
    } catch { /* */ }
  };

  const removeChannelMember = async (userId: string) => {
    if (!accessToken || !activeChannelId) return;
    try {
      await fetch(`${API_BASE}/api/v1/channels/${activeChannelId}/members/${userId}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
      setChannelMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch { /* */ }
  };

  const themeBg = settings.theme === "light" ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100";
  const themeAside = settings.theme === "light" ? "border-slate-200 bg-white" : "border-slate-800";
  const themeHeader = settings.theme === "light" ? "border-slate-200 bg-white" : "border-slate-800";
  const compact = settings.compactMode ? "p-2 text-xs" : "p-4";

  return (
    <main className={`grid min-h-screen grid-cols-[280px_1fr] ${themeBg} max-md:grid-cols-1`} style={rightSidebarOpen ? { gridTemplateColumns: "280px 1fr 260px" } : undefined}>
      <aside className={`flex flex-col h-screen overflow-hidden border-r ${themeAside} max-md:border-b max-md:border-r-0`}>
        <div className={`${compact}`}>
          <h1 className="text-xl font-semibold">Nexus Chat</h1>
          <section className="mt-6">
            <h2 className="text-xs uppercase tracking-wide text-slate-400">Workspaces</h2>
            {workspaces.map((workspace) => (
              <div key={workspace.id} className="mt-2 rounded-xl bg-slate-900 p-3 text-sm font-medium">
                {workspace.name}
              </div>
            ))}
          </section>
        </div>
        <div className={`flex-1 overflow-y-auto ${compact}`}>
        {leftTab === "chat" ? (
          <>
            <section className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-xs uppercase tracking-wide text-slate-400">Channels & DMs</h2>
                <div className="flex gap-1">
                  <button className="rounded-lg bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700" type="button" onClick={() => { setChannelCreateOpen(!channelCreateOpen); setDmCreateOpen(false); }} title="Create Channel">+CH</button>
                  <button className="rounded-lg bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700" type="button" onClick={() => { setDmCreateOpen(!dmCreateOpen); setChannelCreateOpen(false); setDmError(""); }} title="Create DM">+DM</button>
                </div>
              </div>
              {channelCreateOpen ? (
                <div className="mb-2 flex gap-1">
                  <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="channel name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createChannel()} />
                  <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200" type="button" onClick={createChannel}>Create</button>
                </div>
              ) : null}
              {dmCreateOpen ? (
                <div className="mb-2">
                  <div className="flex gap-1">
                    <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="user ID or email" value={newDmEmail} onChange={(e) => setNewDmEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createDm()} />
                    <button className="rounded-lg bg-purple-500/20 px-2 py-1 text-xs text-purple-200" type="button" onClick={createDm}>DM</button>
                  </div>
                  {dmError ? <p className="mt-1 text-xs text-red-400">{dmError}</p> : null}
                </div>
              ) : null}
              <ChannelList channels={channels} activeChannelId={activeChannelId} unreadCounts={unreadCounts} onSelect={setActiveChannel} />
            </section>
          </>
        ) : leftTab === "member" ? (
          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs uppercase tracking-wide text-slate-400">Members ({members.length})</h2>
            </div>
            <div className="mb-2 flex gap-1">
              <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="Search..." value={friendSearchInput} onChange={(e) => setFriendSearchInput(e.target.value)} />
            </div>
            <div className="space-y-1">
              {members.filter((m) => !friendSearchInput || m.displayName?.toLowerCase().includes(friendSearchInput.toLowerCase()) || m.userId.includes(friendSearchInput)).map((m) => (
                <div key={m.userId} className="group flex items-center justify-between rounded-lg px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${m.role === "owner" ? "bg-amber-400" : m.role === "admin" ? "bg-sky-400" : "bg-emerald-400"}`}></span>
                    <span>{m.displayName ?? m.userId.slice(0, 10)}</span>
                    <span className="text-slate-500">({m.role})</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                      {m.userId !== user?.id ? (
                        <>
                          <button className="rounded bg-slate-700 px-1.5 py-0.5 text-xs hover:bg-sky-500/20 hover:text-sky-200" type="button" onClick={() => startDmWithUser(m.userId)} title="Message">💬</button>
                          <button className="rounded bg-slate-700 px-1.5 py-0.5 text-xs hover:bg-red-500/20 hover:text-red-200" type="button" title="Ban">🚫</button>
                        </>
                      ) : null}
                  </div>
                </div>
              ))}
              {members.length === 0 ? <p className="text-xs text-slate-500 px-3">No members</p> : null}
            </div>
          </section>
        ) : (
          <section className="mt-6">
            <h2 className="mb-3 text-xs uppercase tracking-wide text-slate-400">Settings</h2>
            {user ? (
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-slate-400 mb-1">Display Name</p>
                  <p className="text-slate-100 font-medium">{user.displayName}</p>
                </div>
                <div>
                  <p className="text-slate-400 mb-1">Email</p>
                  <p className="text-slate-100 text-xs">{user.email}</p>
                </div>
                <hr className="border-slate-700" />
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Theme</span>
                  <select className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-200 border border-slate-700" value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as "dark" | "light" })}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Compact</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.compactMode ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400"}`} type="button" onClick={() => updateSettings({ compactMode: !settings.compactMode })}>{settings.compactMode ? "ON" : "OFF"}</button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Sound</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.soundEnabled ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400"}`} type="button" onClick={() => updateSettings({ soundEnabled: !settings.soundEnabled })}>{settings.soundEnabled ? "ON" : "OFF"}</button>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Notifications</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.notificationsEnabled ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400"}`} type="button" onClick={() => updateSettings({ notificationsEnabled: !settings.notificationsEnabled })}>{settings.notificationsEnabled ? "ON" : "OFF"}</button>
                </div>
              </div>
            ) : null}
            <button className="mt-6 w-full rounded-xl bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 ring-1 ring-red-400/30 hover:bg-red-500/30 transition" type="button" onClick={() => { socketRef.current?.disconnect(); clearAuth(); useMessageStore.getState().clear(); }}>
              Log Out
            </button>
          </section>
        )}
        </div>
        <div className="border-t border-slate-800 px-3 py-3">
          <div className="flex gap-1">
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "chat" ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`} type="button" onClick={() => setLeftTab("chat")} title="Chat">💬</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "member" ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`} type="button" onClick={() => setLeftTab("member")} title="Members">👥</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "settings" ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`} type="button" onClick={() => setLeftTab("settings")} title="Settings">⚙</button>
          </div>
        </div>
      </aside>
      <section className="relative flex min-h-screen min-w-0 flex-col max-md:min-h-[70vh]">
        <header className={`border-b ${themeHeader} ${compact}`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{activeChannel?.name ?? "Select a channel"}</h2>
            {isE2e ? <Badge tone="warning">Encrypted DM</Badge> : <Badge tone="success">Bots enabled</Badge>}
            {socketRef.current ? <Badge tone={wsConnected ? "success" : "warning"}>{wsConnected ? "WS connected" : "WS disconnected"}</Badge> : null}
            <div className="ml-auto flex items-center gap-2">
              <button className={`rounded-lg px-3 py-1 text-sm transition ${rightSidebarOpen ? "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30" : "bg-slate-800 text-slate-400 hover:bg-slate-700"}`} type="button" onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title="Group Members">👥 Members</button>
            </div>
          </div>
          {isE2e ? <p className="mt-2 text-sm text-amber-200">Bots, slash commands, previews, and server-side search are disabled here.</p> : null}
        </header>
        <MessageList messages={channelMessages} statuses={statuses} decryptedMessages={decryptedMessages} transportLabels={transportLabels} />
        <form onSubmit={submit}>
          <InputActionBar
            actions={
              <>
                {!isE2e
                  ? inputActions.map((action) => (
                      <button key={action.id} className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-200 hover:bg-slate-700" type="button" onClick={() => setDraft(action.command)}>
                        {action.label}
                      </button>
                    ))
                  : null}
                <PolicyControl isE2e={Boolean(isE2e)} policy={policy} onChange={setPolicy} />
              </>
            }
          >
            <div className="relative flex flex-1 flex-col">
              {suggestions.length ? (
                <div className="absolute bottom-12 left-0 z-10 w-full max-w-lg overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 shadow-xl">
                  {suggestions.map((suggestion) => (
                    <button key={`${suggestion.botId}-${suggestion.name}`} className="block w-full px-4 py-3 text-left text-sm hover:bg-slate-800" type="button" onClick={() => setDraft(`${suggestion.name} `)}>
                      <span className="font-medium text-sky-200">{suggestion.name}</span>
                      <span className="ml-2 text-slate-400">{suggestion.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                className="w-full rounded-xl bg-slate-900 px-4 py-3 outline-none ring-sky-400 transition placeholder:text-slate-500 focus:ring-2"
                placeholder={isE2e ? "Encrypted message" : "Message or /command"}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </div>
            <button className="rounded-xl bg-sky-400 px-5 py-3 font-semibold text-slate-950 hover:bg-sky-300" type="submit">
              Send
            </button>
          </InputActionBar>
        </form>
      </section>
      {rightSidebarOpen ? (
        <aside className={`border-l ${themeAside} max-md:hidden overflow-y-auto`}>
          <div className={`${compact}`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-wide text-slate-400">Group Members ({channelMembers.length})</h2>
              <button className="rounded-lg bg-slate-800 px-2 py-0.5 text-xs text-slate-400 hover:bg-slate-700" type="button" onClick={() => setRightSidebarOpen(false)}>✕</button>
            </div>
            <div className="mb-2 flex gap-1">
              <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="User ID to add..." value={addMemberInput} onChange={(e) => setAddMemberInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addChannelMember()} />
              <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={addChannelMember}>Add</button>
            </div>
            <div className="space-y-1">
              {channelMembers.map((cm) => {
                const memberInfo = members.find((m) => m.userId === cm.userId);
                return (
                  <div key={cm.userId} className="group flex items-center justify-between rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                      <span>{memberInfo?.displayName ?? cm.userId.slice(0, 10)}</span>
                    </div>
                    {cm.userId !== user?.id ? (
                      <button className="rounded bg-slate-700 px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-200 transition" type="button" onClick={() => removeChannelMember(cm.userId)} title="Remove">✕</button>
                    ) : null}
                  </div>
                );
              })}
              {channelMembers.length === 0 ? <p className="text-xs text-slate-500 px-2">No members yet</p> : null}
            </div>
          </div>
        </aside>
      ) : null}
    </main>
  );
};

export default ChatRoute;
