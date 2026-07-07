import { useDeferredValue, useEffect, useRef, useState, type FormEvent } from "react";
import { io, type Socket } from "socket.io-client";
import type { Channel, Message } from "@nexus-chat/shared";
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
  useWorkspaceStore,
  usePresenceStore
} from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";
import { useAttachments } from "../hooks/useAttachments.js";
import { useChatBootstrap } from "../hooks/useChatBootstrap.js";
import { useChannelMembers } from "../hooks/useChannelMembers.js";
import { useMessageActions } from "../hooks/useMessageActions.js";
import { useReadReceipts } from "../hooks/useReadReceipts.js";
import { useTyping } from "../hooks/useTyping.js";
import { WEB_SIGNAL_DEVICE_ID, parseDmPeerUserId, applyDisappearingPolicy, ensureSignalSession as doEnsureSignalSession, type TransportLabel } from "./signal-helpers.js";
import { ChannelList } from "./ChannelList.js";
import { ChatComposer } from "./ChatComposer.js";
import { ChatHeader } from "./ChatHeader.js";
import { DeleteConfirmModal } from "./DeleteConfirmModal.js";
import { ForwardModal } from "./ForwardModal.js";
import { MessageList } from "./MessageList.js";
import { RightMemberPanel } from "./RightMemberPanel.js";

const ChatRoute = () => {
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const channels = useChannelStore((state) => state.channels);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const unreadCounts = useChannelStore((state) => state.unreadCounts);
  const setActiveChannel = useChannelStore((state) => state.setActive);
  const setUnread = useChannelStore((state) => state.setUnread);
  const setChannels = useChannelStore((state) => state.setChannels);
  const messagesMap = useMessageStore((state) => state.messages);
  const order = useMessageStore((state) => state.order);
  const statuses = useMessageStore((state) => state.sendStatusByClientId);
  const sendOptimistic = useMessageStore((state) => state.sendOptimistic);
  const upsertMessage = useMessageStore((state) => state.upsert);
  const manifests = useBotStore((state) => state.manifests);
  const inputActions = useBotStore((state) => state.inputActions);
  const draft = useUiStore((state) => state.messageDraft);
  const policy = useUiStore((state) => state.disappearingPolicy);
  const settings = useUiStore((state) => state.settings);
  const updateSettings = useUiStore((state) => state.updateSettings);
  const setDraft = useUiStore((state) => state.setMessageDraft);
  const setPolicy = useUiStore((state) => state.setDisappearingPolicy);
  const dmTransportMode = useUiStore((state) => state.dmTransportMode);
  const setDmTransportMode = useUiStore((state) => state.setDmTransportMode);
  const onlineUserIds = usePresenceStore((state) => state.onlineUserIds);
  const setOnline = usePresenceStore((state) => state.setOnline);
  const deferredDraft = useDeferredValue(draft);
  const socketRef = useRef<Socket | undefined>(undefined);
  const p2pTransportRef = useRef<HybridTransport | undefined>(undefined);
  const signalIdentityRef = useRef<LocalSignalIdentity | undefined>(undefined);
  const signalSessionStoreRef = useRef(createInMemorySignalSessionStore());
  const signalSessionsRef = useRef(new Map<string, SignalSession>());
  const [wsConnected, setWsConnected] = useState(false);
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});
  const [transportLabels, setTransportLabels] = useState<Record<string, TransportLabel>>({});
  const [addPopupOpen, setAddPopupOpen] = useState(false);
  const [addPopupSearch, setAddPopupSearch] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [leftTab, setLeftTab] = useState<"chat" | "member" | "settings">("chat");
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [friendSearchInput, setFriendSearchInput] = useState("");
  const [replyMessage, setReplyMessage] = useState<Message | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: string; text: string; channelId: string }>>([]);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearAuth = useAuthStore((state) => state.clear);
  const setReaction = useMessageStore((state) => state.setReaction);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const activeWorkspaceId = workspaces[0]?.id;
  const channelMessages = selectChannelMessages(messagesMap, order, activeChannelId);
  const isE2e = activeChannel?.mode === "e2e";
  const suggestions = isE2e ? [] : getCommandSuggestions(manifests, deferredDraft);
  useChatBootstrap();
  const { addChannelMember, addMemberInput, channelMembers, members, removeChannelMember, senderNames, setAddMemberInput } = useChannelMembers({ accessToken, activeChannelId, workspaceId: activeWorkspaceId });
  const { clearPendingAttachments, fileInputRef, handleFileUpload, handlePaste, pendingAttachments, uploading } = useAttachments({ accessToken, setDraft, workspaceId: activeWorkspaceId });
  const { handleMessagesVisible, readReceipts, setReadReceipts } = useReadReceipts(socketRef);
  const { handleTypingChange, setTypingUsers, stopTyping, typingUsers } = useTyping({ activeChannel, setDraft, socketRef, userId: user?.id });

  const selectChannel = (id: string) => {
    stopTyping();
    setActiveChannel(id);
    setUnread(id, 0);
    if (accessToken) {
      void fetch(`${API_BASE}/api/v1/channels/${id}/mark-read`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` }
      }).catch(() => {});
    }
  };

  const {
    cancelForward,
    confirmDelete,
    confirmDeleteId,
    forwardSearch,
    forwardSource,
    handleCopy,
    handleDelete,
    handleEdit,
    handleForwardToChannel,
    handleReact,
    setConfirmDeleteId,
    setForwardSearch,
    setForwardSource
  } = useMessageActions({ accessToken, decryptedMessages, selectChannel });

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
    socket.on("connect", () => {
      setWsConnected(true);
      socket.emit("event", { type: "presence.update", payload: { status: "online" }, timestamp: new Date().toISOString() });
    });
    socket.on("disconnect", () => setWsConnected(false));
    socket.on("event", (event: { type: string; payload: unknown }) => {
      if (event.type === "message.created" && event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
        const serverMsg = event.payload as Message;
        const state = useMessageStore.getState();
        if (state.messages.has(serverMsg.id)) return;
        setTransportLabels((current) => ({ ...current, [serverMsg.clientMsgId]: serverMsg.senderId === user?.id ? "relay sent" : "relay received" }));
        const dup = [...state.messages.values()].find((m) => m.clientMsgId === serverMsg.clientMsgId);
        if (dup) {
          const newMsgs = new Map(state.messages);
          newMsgs.delete(dup.id);
          newMsgs.set(serverMsg.id, serverMsg);
          useMessageStore.setState({ messages: newMsgs, order: state.order.map((id) => (id === dup.id ? serverMsg.id : id)) });
        } else {
          upsertMessage(serverMsg, "sent");
        }
        // Increment unread for non-active channels (skip own messages)
        const currentActive = useChannelStore.getState().activeChannelId;
        if (serverMsg.channelId !== currentActive && serverMsg.senderId !== user?.id) {
          const counts = useChannelStore.getState().unreadCounts;
          useChannelStore.getState().setUnread(serverMsg.channelId, (counts[serverMsg.channelId] ?? 0) + 1);
          const ch = useChannelStore.getState().channels.find((c) => c.id === serverMsg.channelId);
          const sender = senderNames[serverMsg.senderId] ?? serverMsg.senderId.slice(0, 10);
          const preview = serverMsg.content.type === "text" ? serverMsg.content.text.slice(0, 40) : "Attachment";
          const toastId = `toast-${Date.now()}`;
          const notificationBody = `${sender}: ${preview}`;
          setToasts((prev) => [...prev, { id: toastId, text: `${ch?.name ?? "DM"}: ${notificationBody}`, channelId: serverMsg.channelId }]);
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
          toastTimerRef.current = setTimeout(() => { setToasts((prev) => prev.slice(1)); }, 5000);
          if (settings.notificationsEnabled && document.hidden) {
            try { new window.Notification("Nexus Chat", { body: notificationBody }); } catch { /* */ }
          }
        }
      }
      if (event.type === "typing.updated") {
        const payload = event.payload as { userId: string; channelId: string; typing: boolean };
        if (payload.channelId && payload.userId !== user?.id) {
          setTypingUsers((prev) => {
            const next = { ...prev };
            if (payload.typing) next[payload.userId] = payload.channelId;
            else delete next[payload.userId];
            return next;
          });
        }
      }
      if (event.type === "presence.updated") {
        const payload = event.payload as { userId: string; status: string };
        if (payload.userId) setOnline(payload.userId, payload.status === "online");
      }
      if (event.type === "message.read") {
        const payload = event.payload as { messageId: string; readCount: number };
        if (payload.messageId && typeof payload.readCount === "number") {
          setReadReceipts((prev) => ({ ...prev, [payload.messageId]: payload.readCount }));
        }
      }
      if (event.type === "message.reaction") {
        const payload = event.payload as { messageId: string; emoji: string; count: number; reacted: boolean; actorUserId?: string };
        if (payload.messageId && payload.emoji) {
          const current = useMessageStore.getState().reactions[payload.messageId]?.[payload.emoji];
          const reacted = payload.actorUserId === user?.id ? payload.reacted : current?.reacted ?? false;
          setReaction(payload.messageId, payload.emoji, payload.count, reacted);
        }
      }
      if (event.type === "channel.created") {
        const ch = event.payload as Channel;
        if (ch.id && ch.workspaceId) {
          const current = useChannelStore.getState().channels;
          if (!current.some((c) => c.id === ch.id)) setChannels([...current, ch]);
        }
      }
      if (event.type === "dm.created") {
        const dm = event.payload as Channel;
        if (dm.id && dm.workspaceId) {
          const current = useChannelStore.getState().channels;
          if (!current.some((c) => c.id === dm.id)) setChannels([...current, dm]);
        }
      }
      if (event.type === "message.updated") {
        const updatedMsg = event.payload as Message;
        if (updatedMsg.id) upsertMessage(updatedMsg, "sent");
      }
      if (event.type === "message.deleted") {
        const deletedMsg = event.payload as Message;
        if (deletedMsg.id) upsertMessage(deletedMsg, "sent");
      }
    });
    return () => {
      p2pTransportRef.current?.destroy();
      p2pTransportRef.current = undefined;
      socket.disconnect();
    };
  }, [accessToken, user?.id]);

  const createChannel = async (name?: string) => {
    const channelName = (name ?? newChannelName).trim();
    if (!channelName || !accessToken || !workspaces[0]) return;
    try {
      const resp = await fetch(`${API_BASE}/api/v1/workspaces/${workspaces[0].id}/channels`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ name: channelName, mode: "normal" })
      });
      const json = (await resp.json()) as { ok: boolean; data: Channel };
      if (json.ok) {
        setChannels([...channels, json.data]);
        selectChannel(json.data.id);
      }
    } catch { /* */ }
    setNewChannelName("");
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
        selectChannel(json.data.id);
        setLeftTab("chat");
      }
    } catch { /* ignore */ }
  };

  const insertEmoji = (emoji: string) => {
    setDraft(draft + emoji);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user || !activeChannel || (!draft.trim() && pendingAttachments.length === 0)) return;
    if (p2pBlocked) return;

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

      stopTyping();
      setDraft("");
      setReplyMessage(null);
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

          if (result.path === "p2p") {
            if (result.ok) {
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
            stopTyping();
            setDraft("");
            setReplyMessage(null);
            return;
          }

          // relay fallback — continue to WS emit below
          if (isP2pMode) {
            stopTyping();
            setDraft("");
            setReplyMessage(null);
            return;
          }
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
              content: encryptedContent ?? { type: "text" as const, text, attachments: pendingAttachments.map(({ scanStatus, ...a }) => ({ ...a, scanStatus: scanStatus as "pending" | "clean" | "blocked" | "skipped" })) },
              ...(replyMessage ? { replyToMessageId: replyMessage.id } : {})
            },
            timestamp: new Date().toISOString(),
            encrypted: Boolean(encryptedContent)
          }
        );
      }
    }
    stopTyping();
    setDraft("");
    setReplyMessage(null);
    clearPendingAttachments();
  };

  const isLight = settings.theme === "light";
  const themeBg = isLight ? "bg-slate-50 text-slate-900" : "bg-slate-950 text-slate-100";
  const themeAside = isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-950";
  const themeHeader = isLight ? "border-slate-200 bg-white" : "border-slate-700";
  const themeCard = isLight ? "bg-slate-100 text-slate-800" : "bg-slate-900 text-slate-300";
  const themeBtn = isLight ? "bg-slate-200 text-slate-700 hover:bg-slate-300" : "bg-slate-800 text-slate-300 hover:bg-slate-700";
  const themeInput = isLight ? "bg-white border border-slate-300 text-slate-900 placeholder:text-slate-400" : "bg-slate-800 text-slate-200 placeholder:text-slate-500";
  const themeMuted = isLight ? "text-slate-400" : "text-slate-400";
  const themeSectionTitle = isLight ? "text-slate-500" : "text-slate-400";
  const themeTabActive = isLight ? "bg-sky-500/10 text-sky-700 ring-1 ring-sky-300" : "bg-sky-500/20 text-sky-200 ring-1 ring-sky-400/30";
  const themeTabInactive = isLight ? "bg-slate-200 text-slate-500 hover:bg-slate-300" : "bg-slate-800 text-slate-400 hover:bg-slate-700";
  const themeMember = isLight ? "text-slate-700 hover:bg-slate-200" : "text-slate-300 hover:bg-slate-800";
  const themeMemberBadge = isLight ? "bg-slate-200 text-slate-500" : "bg-slate-700 text-slate-300";
  const themeSettingLabel = isLight ? "text-slate-500" : "text-slate-400";
  const themeSettingValue = isLight ? "text-slate-900" : "text-slate-100";
  const themeBorder = isLight ? "border-slate-200" : "border-slate-700";
  const themeDivider = isLight ? "border-slate-200" : "border-slate-700";
  const themeSelect = isLight ? "bg-white border border-slate-300 text-slate-800" : "bg-slate-800 border border-slate-700 text-slate-200";
  const compact = settings.compactMode ? "p-2 text-xs" : "p-4";
  const isDm = activeChannel?.kind === "dm";
  const peerUserId = isDm && activeChannel ? parseDmPeerUserId(activeChannel, user?.id ?? "") : undefined;
  const peerOnline = peerUserId ? onlineUserIds.has(peerUserId) : false;
  const isP2pMode = dmTransportMode === "p2p" || (dmTransportMode === "auto" && peerOnline);
  const p2pBlocked = dmTransportMode === "p2p" && !peerOnline;

  return (
    <main className={`grid h-screen grid-cols-[280px_1fr] ${themeBg} max-md:grid-cols-1`} style={rightSidebarOpen ? { gridTemplateColumns: "280px 1fr 260px" } : undefined}>
      <aside className={`flex flex-col h-screen overflow-hidden border-r ${themeAside} max-md:border-b max-md:border-r-0`}>
        <div className={`${compact}`}>
          <h1 className="text-xl font-semibold">Nexus Chat</h1>
          <section className="mt-6">
            <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Workspaces</h2>
            {workspaces.map((workspace) => (
              <div key={workspace.id} className={`mt-2 rounded-xl ${themeCard} p-3 text-sm font-medium`}>
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
                <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Channels & DMs</h2>
                <div className="flex gap-1">
                  <button className={`rounded-lg ${themeBtn} px-2 py-0.5 text-xs font-bold`} type="button" onClick={() => { setAddPopupOpen(!addPopupOpen); setAddPopupSearch(""); }} title="Add">+</button>
                </div>
              </div>
              {addPopupOpen ? (
                <div className={`mb-2 rounded-xl border ${themeBorder} ${isLight ? "bg-white" : "bg-slate-900"} p-2 shadow-lg`}>
                  <input className={`mb-2 w-full rounded-lg ${themeInput} px-2 py-1 text-xs outline-none`} placeholder="Search members or type channel name..." value={addPopupSearch} onChange={(e) => setAddPopupSearch(e.target.value)} autoFocus />
                  <div className="max-h-40 overflow-y-auto space-y-0.5">
                    {addPopupSearch.trim() ? (
                      <>
                        <button
                          className={`w-full rounded-lg px-2 py-1 text-left text-xs ${isLight ? "hover:bg-sky-100 text-sky-700" : "hover:bg-sky-500/10 text-sky-200"}`}
                          type="button"
                          onClick={() => {
                            createChannel(addPopupSearch.trim());
                            setAddPopupSearch("");
                            setAddPopupOpen(false);
                          }}
                        ># Create channel &quot;{addPopupSearch.trim()}&quot;</button>
                        {members
                          .filter((m) => m.userId !== user!.id && (m.displayName?.toLowerCase().includes(addPopupSearch.toLowerCase()) ?? m.userId.includes(addPopupSearch)))
                          .slice(0, 6)
                          .map((m) => (
                            <button
                              key={m.userId}
                              className={`w-full rounded-lg px-2 py-1 text-left text-xs ${isLight ? "hover:bg-slate-100" : "hover:bg-slate-800"}`}
                              type="button"
                              onClick={() => {
                                startDmWithUser(m.userId);
                                setAddPopupSearch("");
                                setAddPopupOpen(false);
                              }}
                            >@ {m.displayName ?? m.email?.split("@")[0] ?? m.userId.slice(0, 10)}</button>
                          ))}
                        {channels
                          .filter((c) => c.name.toLowerCase().includes(addPopupSearch.toLowerCase()))
                          .map((c) => (
                            <button
                              key={c.id}
                              className={`w-full rounded-lg px-2 py-1 text-left text-xs ${isLight ? "hover:bg-slate-100" : "hover:bg-slate-800"}`}
                              type="button"
                              onClick={() => {
                                selectChannel(c.id);
                                setAddPopupSearch("");
                                setAddPopupOpen(false);
                              }}
                            >{c.kind === "dm" ? "@" : "#"} {c.name}</button>
                          ))}
                      </>
                    ) : (
                      <p className={`px-2 py-1 text-xs ${themeMuted}`}>Type to search or create a channel</p>
                    )}
                  </div>
                </div>
              ) : null}
              <ChannelList channels={channels} activeChannelId={activeChannelId} unreadCounts={unreadCounts} onSelect={selectChannel} currentUserId={user!.id} userNames={senderNames} />
            </section>
          </>
        ) : leftTab === "member" ? (
          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Members ({members.length})</h2>
            </div>
            <div className="mb-2 flex gap-1">
              <input className={`flex-1 rounded-lg ${themeInput} px-2 py-1 text-xs outline-none`} placeholder="Search..." value={friendSearchInput} onChange={(e) => setFriendSearchInput(e.target.value)} />
            </div>
            <div className="space-y-1">
              {members.filter((m) => !friendSearchInput || m.displayName?.toLowerCase().includes(friendSearchInput.toLowerCase()) || m.userId.includes(friendSearchInput)).map((m) => (
                <div key={m.userId} className={`group flex items-center justify-between rounded-lg px-3 py-1.5 text-xs ${themeMember}`}>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${onlineUserIds.has(m.userId) ? "bg-emerald-400" : "bg-slate-500"}`}></span>
                    <span>{m.displayName ?? m.email?.split("@")[0] ?? m.userId.slice(0, 10)}</span>
                    <span className={themeMuted}>({m.role})</span>
                  </div>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition">
                      {m.userId !== user?.id ? (
                        <>
                          <button className={`rounded ${themeMemberBadge} px-1.5 py-0.5 text-xs hover:bg-sky-500/20 hover:text-sky-200`} type="button" onClick={() => startDmWithUser(m.userId)} title="Message">💬</button>
                          <button className={`rounded ${themeMemberBadge} px-1.5 py-0.5 text-xs hover:bg-red-500/20 hover:text-red-200`} type="button" title="Ban">🚫</button>
                        </>
                      ) : null}
                  </div>
                </div>
              ))}
              {members.length === 0 ? <p className={`text-xs ${themeMuted} px-3`}>No members</p> : null}
            </div>
          </section>
        ) : (
          <section className="mt-6">
            <h2 className={`mb-3 text-xs uppercase tracking-wide ${themeSectionTitle}`}>Settings</h2>
            {user ? (
              <div className="space-y-4 text-sm">
                <div>
                  <p className={`${themeSettingLabel} mb-1`}>Display Name</p>
                  <p className={`${themeSettingValue} font-medium`}>{user.displayName}</p>
                </div>
                <div>
                  <p className={`${themeSettingLabel} mb-1`}>Email</p>
                  <p className={`${themeSettingValue} text-xs`}>{user.email}</p>
                </div>
                <hr className={themeDivider} />
                <div className="flex items-center justify-between">
                  <span className={themeSettingLabel}>Theme</span>
                  <select className={`rounded-lg ${themeSelect} px-3 py-1 text-sm`} value={settings.theme} onChange={(e) => updateSettings({ theme: e.target.value as "dark" | "light" })}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className={themeSettingLabel}>Compact</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.compactMode ? themeTabActive : themeBtn}`} type="button" onClick={() => updateSettings({ compactMode: !settings.compactMode })}>{settings.compactMode ? "ON" : "OFF"}</button>
                </div>
                <div className="flex items-center justify-between">
                  <span className={themeSettingLabel}>Sound</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.soundEnabled ? themeTabActive : themeBtn}`} type="button" onClick={() => updateSettings({ soundEnabled: !settings.soundEnabled })}>{settings.soundEnabled ? "ON" : "OFF"}</button>
                </div>
                <div className="flex items-center justify-between">
                  <span className={themeSettingLabel}>Notifications</span>
                  <button className={`rounded-lg px-3 py-1 text-sm transition ${settings.notificationsEnabled ? themeTabActive : themeBtn}`} type="button" onClick={() => updateSettings({ notificationsEnabled: !settings.notificationsEnabled })}>{settings.notificationsEnabled ? "ON" : "OFF"}</button>
                </div>
              </div>
            ) : null}
            <button className="mt-6 w-full rounded-xl bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 ring-1 ring-red-400/30 hover:bg-red-500/30 transition" type="button" onClick={() => { socketRef.current?.disconnect(); clearAuth(); useMessageStore.getState().clear(); }}>
              Log Out
            </button>
          </section>
        )}
        </div>
        <div className={`${themeBorder} p-3`}>
          <div className="flex items-center gap-1">
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-base transition ${leftTab === "chat" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("chat")} title="Chat">💬</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-base transition ${leftTab === "member" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("member")} title="Members">👥</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-base transition ${leftTab === "settings" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("settings")} title="Settings">⚙️</button>
          </div>
        </div>
      </aside>
      <section className="chat-main relative flex min-w-0 flex-col">
        {toasts.length > 0 ? (
          <div className="absolute right-2 top-2 z-20 flex flex-col gap-1">
            {toasts.map((t) => (
              <button
                key={t.id}
                className={`cursor-pointer rounded-lg px-4 py-2 text-sm shadow-lg transition ${isLight ? "bg-white text-slate-800" : "bg-slate-800 text-slate-200"}`}
                type="button"
                onClick={() => selectChannel(t.channelId)}
              >{t.text}</button>
            ))}
          </div>
        ) : null}
        <ChatHeader
          activeChannel={activeChannel}
          activeChannelId={activeChannelId}
          compact={compact}
          dmTransportMode={dmTransportMode}
          isDm={Boolean(isDm)}
          isE2e={Boolean(isE2e)}
          peerOnline={peerOnline}
          rightSidebarOpen={rightSidebarOpen}
          setDmTransportMode={setDmTransportMode}
          setRightSidebarOpen={setRightSidebarOpen}
          themeHeader={themeHeader}
          themeSelect={themeSelect}
          themeTabActive={themeTabActive}
          themeTabInactive={themeTabInactive}
          typingUsers={typingUsers}
          wsConnected={wsConnected}
          wsVisible={Boolean(socketRef.current)}
        />
        <MessageList messages={channelMessages} statuses={statuses} decryptedMessages={decryptedMessages} transportLabels={transportLabels} readReceipts={readReceipts} senderNames={senderNames} onMessagesVisible={handleMessagesVisible} onReply={setReplyMessage} onForward={setForwardSource} onEdit={handleEdit} onDelete={handleDelete} onCopy={handleCopy} onReact={handleReact} />
        <ChatComposer
          draft={draft}
          emojiPickerOpen={emojiPickerOpen}
          fileInputRef={fileInputRef}
          handleFileUpload={(file) => void handleFileUpload(file)}
          handlePaste={handlePaste}
          handleTypingChange={handleTypingChange}
          inputActions={inputActions}
          insertEmoji={insertEmoji}
          isE2e={Boolean(isE2e)}
          isLight={isLight}
          onSubmit={submit}
          pendingReply={replyMessage}
          p2pBlocked={p2pBlocked}
          policy={policy}
          senderNames={senderNames}
          setDraft={setDraft}
          setEmojiPickerOpen={setEmojiPickerOpen}
          setPolicy={setPolicy}
          setReplyMessage={setReplyMessage}
          stopTyping={stopTyping}
          suggestions={suggestions}
          themeBorder={themeBorder}
          themeBtn={themeBtn}
          uploading={uploading}
        />
      </section>
      {rightSidebarOpen ? (
        <RightMemberPanel
          addChannelMember={addChannelMember}
          addMemberInput={addMemberInput}
          channelMembers={channelMembers}
          compact={compact}
          currentUserId={user?.id}
          members={members}
          onlineUserIds={onlineUserIds}
          removeChannelMember={removeChannelMember}
          setAddMemberInput={setAddMemberInput}
          setRightSidebarOpen={setRightSidebarOpen}
          themeAside={themeAside}
          themeBtn={themeBtn}
          themeInput={themeInput}
          themeMember={themeMember}
          themeMemberBadge={themeMemberBadge}
          themeMuted={themeMuted}
          themeSectionTitle={themeSectionTitle}
        />
      ) : null}
      {forwardSource ? (
        <ForwardModal
          activeChannelId={activeChannelId}
          channels={channels}
          forwardSearch={forwardSearch}
          isLight={isLight}
          onCancel={cancelForward}
          onForwardToChannel={(channelId) => void handleForwardToChannel(channelId)}
          setForwardSearch={setForwardSearch}
          themeBtn={themeBtn}
          themeInput={themeInput}
        />
      ) : null}
      {confirmDeleteId ? (
        <DeleteConfirmModal confirmDelete={() => void confirmDelete()} isLight={isLight} onCancel={() => setConfirmDeleteId(null)} themeBtn={themeBtn} />
      ) : null}
    </main>
  );
};

export default ChatRoute;
