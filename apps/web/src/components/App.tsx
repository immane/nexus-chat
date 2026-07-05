import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { Virtuoso } from "react-virtuoso";
import { io, type Socket } from "socket.io-client";
import { Badge, InputActionBar } from "@nexus-chat/ui";
import type { BotManifest, Channel, Message, User, Workspace } from "@nexus-chat/shared";
import {
  createOptimisticMessage,
  getCommandSuggestions,
  getPolicyLabel,
  selectChannelMessages,
  useAuthStore,
  useBotStore,
  useChannelStore,
  useMessageStore,
  useUiStore,
  useWorkspaceStore,
  type DisappearingDraftPolicy
} from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";

const demoUser: User = {
  id: "user-demo-1",
  email: "demo@nexus.local",
  displayName: "Demo User",
  createdAt: "2026-07-05T00:00:00.000Z"
};

const demoWorkspace: Workspace = {
  id: "workspace-demo-1",
  name: "Nexus HQ",
  createdAt: "2026-07-05T00:00:00.000Z"
};

const demoChannels: Channel[] = [
  {
    id: "channel-general-1",
    workspaceId: demoWorkspace.id,
    name: "general",
    kind: "channel",
    mode: "normal",
    isPrivate: false,
    createdById: demoUser.id,
    createdAt: "2026-07-05T00:00:00.000Z"
  },
  {
    id: "channel-dm-e2e-1",
    workspaceId: demoWorkspace.id,
    name: "encrypted-dm",
    kind: "dm",
    mode: "e2e",
    isPrivate: true,
    createdById: demoUser.id,
    createdAt: "2026-07-05T00:00:00.000Z"
  }
];

const demoManifests: BotManifest[] = [
  {
    id: "bot-help-1",
    name: "help",
    description: "Lists available commands.",
    commands: [{ name: "/help", description: "Show command help." }],
    scopes: ["commands:handle", "messages:write"]
  },
  {
    id: "bot-notification-1",
    name: "notification",
    description: "Sends generic workspace announcements.",
    commands: [{ name: "/announce", description: "Send an announcement." }],
    scopes: ["commands:handle", "messages:write"]
  }
];

const demoMessages: Message[] = [
  {
    id: "message-welcome-1",
    workspaceId: demoWorkspace.id,
    channelId: "channel-general-1",
    senderId: "bot-welcome",
    clientMsgId: "seed-welcome-1",
    content: { type: "text", text: "Welcome to Nexus Chat. Try /help or switch to the encrypted DM.", attachments: [] },
    state: "sent",
    createdAt: "2026-07-05T00:00:00.000Z"
  },
  {
    id: "message-expired-1",
    workspaceId: demoWorkspace.id,
    channelId: "channel-dm-e2e-1",
    senderId: "peer-user-1",
    clientMsgId: "seed-expired-1",
    content: { type: "tombstone", reason: "expired" },
    state: "deleted",
    createdAt: "2026-07-05T00:01:00.000Z"
  }
];

const seedDemoSession = () => {
  useAuthStore.getState().setSession({
    user: demoUser,
    tokens: { accessToken: "demo-access-token", refreshToken: "demo-refresh-token", expiresInSeconds: 900 }
  });
  useWorkspaceStore.getState().setWorkspaces([demoWorkspace]);
  useWorkspaceStore.getState().setActive(demoWorkspace.id);
  useChannelStore.getState().setChannels(demoChannels);
  useChannelStore.getState().setActive(demoChannels[0]?.id ?? "");
  useMessageStore.getState().clear();
  demoMessages.forEach((message) => useMessageStore.getState().upsert(message));
  useBotStore.getState().setManifests(demoManifests);
  useBotStore.getState().registerInputAction({
    id: "announcement-template",
    label: "Announcement",
    description: "Insert a generic bot command template.",
    command: "/announce "
  });
};

export const ChannelList = ({
  channels,
  activeChannelId,
  unreadCounts,
  onSelect
}: {
  channels: Channel[];
  activeChannelId: string | undefined;
  unreadCounts: Record<string, number>;
  onSelect: (id: string) => void;
}) => {
  const settings = useUiStore((state) => state.settings);
  const themeSideActive = settings.theme === "light" ? "bg-sky-100 text-sky-700 ring-sky-300" : "bg-sky-500/20 text-sky-100 ring-sky-400/30";
  const themeSideBtn = settings.theme === "light" ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-900 text-slate-300 hover:bg-slate-800";
  return (
  <div className="space-y-2">
    {channels.map((channel) => (
      <button
        key={channel.id}
        className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition ${
          channel.id === activeChannelId ? themeSideActive : themeSideBtn
        }`}
        type="button"
        onClick={() => onSelect(channel.id)}
      >
        <span>
          {channel.kind === "dm" ? "@" : "#"}
          {channel.name}
        </span>
        <span className="flex items-center gap-2">
          {unreadCounts[channel.id] ? <Badge tone="success">{unreadCounts[channel.id]}</Badge> : null}
          {channel.mode === "e2e" ? <Badge tone="warning">E2E</Badge> : null}
        </span>
      </button>
    ))}
  </div>
  );
};

export const MessageRow = ({ message, status }: { message: Message; status: string | undefined }) => {
  const settings = useUiStore((state) => state.settings);
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const themeCard = settings.theme === "light" ? "bg-white ring-slate-200" : "bg-slate-900/80 ring-slate-800";
  const compactMsg = settings.compactMode ? "mx-2 my-1 p-2 text-xs" : "mx-4 my-2 p-4 text-sm";
  if (message.content.type === "tombstone") {
    const reason = message.content.reason === "read_once_consumed" ? "Read-once message consumed" : "Message expired";
    return <article className="mx-4 my-2 rounded-xl border border-dashed border-slate-700 bg-slate-900/50 p-4 text-sm text-slate-400"><span className="text-xs text-slate-500">{time}</span> {reason}</article>;
  }

  const policyLabel = message.content.type === "ciphertext" && message.content.readOnce ? "Read once" : message.content.type === "ciphertext" && message.content.expiresAt ? "Disappearing" : undefined;
  const body = message.content.type === "text" ? message.content.text : "Encrypted message payload";

  return (
    <article className={`rounded-2xl ${themeCard} ${compactMsg} shadow-sm`}>
      <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
        <span className="font-medium text-slate-300">{message.senderId.slice(0, 12)}</span>
        <span>{time}</span>
        {policyLabel ? <Badge tone="warning">{policyLabel}</Badge> : null}
        {status === "sending" ? <span className="italic text-amber-300">sending...</span> : status === "sent" ? <span className="text-emerald-400">✓ sent</span> : status === "failed" ? <span className="text-red-400">✗ failed</span> : null}
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6 text-slate-100">{body}</p>
    </article>
  );
};

export const MessageList = ({ messages, statuses }: { messages: Message[]; statuses: Record<string, string> }) => (
  <Virtuoso
    className="flex-1"
    data={messages}
    followOutput="smooth"
    itemContent={(_, message) => <MessageRow message={message} status={statuses[message.clientMsgId]} />}
  />
);

const LoginRoute = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"demo" | "server">("demo");
  const [error, setError] = useState("");

  const demoSubmit = (event: FormEvent) => {
    event.preventDefault();
    seedDemoSession();
  };

  const serverSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const resp = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const json = (await resp.json()) as { ok: boolean; data?: { user: User; tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number } }; error?: { message: string } };
      if (!json.ok || !json.data) { setError(json.error?.message ?? "Login failed"); return; }
      useAuthStore.getState().setSession({ user: json.data.user, tokens: json.data.tokens });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,#164e63,#020617_45%)] p-6 text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-4 flex gap-2">
          <button className={`rounded-xl px-4 py-2 text-sm font-medium ${mode === "demo" ? "bg-sky-400 text-slate-950" : "bg-slate-800 text-slate-300"}`} type="button" onClick={() => setMode("demo")}>Demo</button>
          <button className={`rounded-xl px-4 py-2 text-sm font-medium ${mode === "server" ? "bg-emerald-400 text-slate-950" : "bg-slate-800 text-slate-300"}`} type="button" onClick={() => setMode("server")}>Real Server</button>
        </div>
        {mode === "demo" ? (
          <form className="rounded-3xl border border-white/10 bg-slate-950/85 p-8 shadow-2xl" onSubmit={demoSubmit}>
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-sky-300">Nexus Chat</p>
            <h1 className="mt-3 text-3xl font-semibold">Demo Mode</h1>
            <p className="mt-2 text-sm text-slate-400">Pre-loaded with sample data. No server required.</p>
            <button className="mt-6 w-full rounded-xl bg-sky-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-sky-300" type="submit">Enter Demo</button>
          </form>
        ) : (
          <form className="rounded-3xl border border-white/10 bg-slate-950/85 p-8 shadow-2xl" onSubmit={serverSubmit}>
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-emerald-300">Nexus Chat</p>
            <h1 className="mt-3 text-3xl font-semibold">Sign in to your workspace</h1>
            {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
            <label className="mt-6 block text-sm text-slate-300" htmlFor="email">Email</label>
            <input id="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="mt-4 block text-sm text-slate-300" htmlFor="password">Password</label>
            <input id="password" type="password" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="mt-6 w-full rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300" type="submit">Continue</button>
          </form>
        )}
      </div>
    </main>
  );
};

const PolicyControl = ({ isE2e, policy, onChange }: { isE2e: boolean; policy: DisappearingDraftPolicy; onChange: (policy: DisappearingDraftPolicy) => void }) => {
  if (!isE2e) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <span>Policy:</span>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "none" })}>
        Standard
      </button>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "read_once" })}>
        Read once
      </button>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "ttl", ttlSeconds: 300 })}>
        5 min TTL
      </button>
      <Badge tone={policy.mode === "none" ? "neutral" : "warning"}>{getPolicyLabel(policy)}</Badge>
    </div>
  );
};

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
  const [wsConnected, setWsConnected] = useState(false);
  const [channelCreateOpen, setChannelCreateOpen] = useState(false);
  const [dmCreateOpen, setDmCreateOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [newDmEmail, setNewDmEmail] = useState("");
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
    socket.on("connect", () => setWsConnected(true));
    socket.on("disconnect", () => setWsConnected(false));
    socket.on("event", (event: { type: string; payload: unknown }) => {
      if (event.type === "message.created" && event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
        const serverMsg = event.payload as Message;
        const state = useMessageStore.getState();
        // Skip if already added
        if (state.messages.has(serverMsg.id)) return;
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
    return () => { socket.disconnect(); };
  }, [accessToken]);

  const submit = (event: FormEvent) => {
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
      if (isSlashCommand && cmdName) {
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
        // Don't show optimistic — wait for server broadcast
        socketRef.current.emit(
          "event",
          {
            type: "message.send",
            workspaceId: activeChannel.workspaceId,
            channelId: activeChannel.id,
            payload: {
              workspaceId: activeChannel.workspaceId,
              channelId: activeChannel.id,
              clientMsgId: `web-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              content: { type: "text" as const, text, attachments: [] }
            },
            timestamp: new Date().toISOString(),
            encrypted: false
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

  const createDm = async () => {
    if (!newDmEmail.trim() || !accessToken || !workspaces[0]) return;
    try {
      // First find user by email via login (we need the userId)
      const resp = await fetch(`${API_BASE}/api/v1/dms?workspaceId=${workspaces[0].id}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ peerUserId: newDmEmail.trim(), mode: "normal" })
      });
      const json = (await resp.json()) as { ok: boolean; data: Channel };
      if (json.ok) {
        setChannels([...channels, json.data]);
        setActiveChannel(json.data.id);
      }
    } catch { /* */ }
    setNewDmEmail("");
    setDmCreateOpen(false);
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
                  <button className="rounded-lg bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700" type="button" onClick={() => { setDmCreateOpen(!dmCreateOpen); setChannelCreateOpen(false); }} title="Create DM">+DM</button>
                </div>
              </div>
              {channelCreateOpen ? (
                <div className="mb-2 flex gap-1">
                  <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="channel name" value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createChannel()} />
                  <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200" type="button" onClick={createChannel}>Create</button>
                </div>
              ) : null}
              {dmCreateOpen ? (
                <div className="mb-2 flex gap-1">
                  <input className="flex-1 rounded-lg bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none" placeholder="user ID or email" value={newDmEmail} onChange={(e) => setNewDmEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createDm()} />
                  <button className="rounded-lg bg-purple-500/20 px-2 py-1 text-xs text-purple-200" type="button" onClick={createDm}>DM</button>
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
                        <button className="rounded bg-slate-700 px-1.5 py-0.5 text-xs hover:bg-sky-500/20 hover:text-sky-200" type="button" onClick={() => { setDmCreateOpen(true); setLeftTab("chat"); }} title="Message">💬</button>
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
        <MessageList messages={channelMessages} statuses={statuses} />
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

export const App = () => {
  const user = useAuthStore((state) => state.user);

  return user ? <ChatRoute /> : <LoginRoute />;
};
