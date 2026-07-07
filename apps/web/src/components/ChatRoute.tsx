import { useDeferredValue, useEffect, useRef, useState, type FormEvent, type ClipboardEvent as ReactClipboardEvent } from "react";
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
  useWorkspaceStore,
  usePresenceStore,
  type DmTransportMode
} from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";
import { WEB_SIGNAL_DEVICE_ID, parseDmPeerUserId, applyDisappearingPolicy, ensureSignalSession as doEnsureSignalSession, type TransportLabel } from "./signal-helpers.js";
import { ChannelList } from "./ChannelList.js";
import { MessageList } from "./MessageList.js";
import PolicyControl from "./PolicyControl.js";

const ChatRoute = () => {
  const user = useAuthStore((state) => state.user);
  const setMessageCurrentUser = useMessageStore((state) => state.setCurrentUser);
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
  const setManifests = useBotStore((state) => state.setManifests);
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
  const setWorkspaces = useWorkspaceStore((state) => state.setWorkspaces);
  const setActiveWorkspace = useWorkspaceStore((state) => state.setActive);
  const deferredDraft = useDeferredValue(draft);
  const socketRef = useRef<Socket | undefined>(undefined);
  const p2pTransportRef = useRef<HybridTransport | undefined>(undefined);
  const signalIdentityRef = useRef<LocalSignalIdentity | undefined>(undefined);
  const signalSessionStoreRef = useRef(createInMemorySignalSessionStore());
  const signalSessionsRef = useRef(new Map<string, SignalSession>());
  const [wsConnected, setWsConnected] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, string>>({});
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isTypingRef = useRef(false);
  const ackedMessagesRef = useRef(new Set<string>());
  const [readReceipts, setReadReceipts] = useState<Record<string, number>>({});
  const [decryptedMessages, setDecryptedMessages] = useState<Record<string, string>>({});

  const handleMessagesVisible = (messageIds: string[]) => {
    if (!socketRef.current?.connected) return;
    for (const id of messageIds) {
      if (ackedMessagesRef.current.has(id)) continue;
      ackedMessagesRef.current.add(id);
      socketRef.current.emit("event", {
        type: "message.ack",
        payload: { messageId: id },
        timestamp: new Date().toISOString()
      });
    }
  };
  const [transportLabels, setTransportLabels] = useState<Record<string, TransportLabel>>({});
  const [addPopupOpen, setAddPopupOpen] = useState(false);
  const [addPopupSearch, setAddPopupSearch] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [members, setMembers] = useState<Array<{ userId: string; role: string; displayName?: string; email?: string }>>([]);
  const [leftTab, setLeftTab] = useState<"chat" | "member" | "settings">("chat");
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [channelMembers, setChannelMembers] = useState<Array<{ channelId: string; userId: string; role?: string }>>([]);
  const [addMemberInput, setAddMemberInput] = useState("");
  const [friendSearchInput, setFriendSearchInput] = useState("");
  const [replyMessage, setReplyMessage] = useState<Message | null>(null);
  const [forwardSource, setForwardSource] = useState<Message | null>(null);
  const [forwardSearch, setForwardSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [emojiPickerPos, setEmojiPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [uploading, setUploading] = useState<Array<{ name: string; progress: number; cancel: () => void }>>([]);
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ fileId: string; name: string; mimeType: string; size: number; scanStatus: string }>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clearAuth = useAuthStore((state) => state.clear);
  const reactions = useMessageStore((state) => state.reactions);
  const setReaction = useMessageStore((state) => state.setReaction);
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const channelMessages = selectChannelMessages(messagesMap, order, activeChannelId);
  const isE2e = activeChannel?.mode === "e2e";
  const suggestions = isE2e ? [] : getCommandSuggestions(manifests, deferredDraft);

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

  const emitTyping = (typing: boolean) => {
    if (!socketRef.current?.connected || !activeChannel || !user) return;
    socketRef.current.emit("event", {
      type: typing ? "typing.start" : "typing.stop",
      workspaceId: activeChannel.workspaceId,
      channelId: activeChannel.id,
      payload: { workspaceId: activeChannel.workspaceId, channelId: activeChannel.id },
      timestamp: new Date().toISOString()
    });
  };

  const handleTypingChange = (value: string) => {
    setDraft(value);
    if (!isTypingRef.current && value.length > 0) {
      isTypingRef.current = true;
      emitTyping(true);
    }
    if (value.length === 0) {
      stopTyping();
    }
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(stopTyping, 3000);
  };

  const stopTyping = () => {
    if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); typingTimeoutRef.current = undefined; }
    if (isTypingRef.current) {
      isTypingRef.current = false;
      emitTyping(false);
    }
  };

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

  // Keep message store's currentUserId in sync
  useEffect(() => {
    if (user) setMessageCurrentUser(user.id);
  }, [user, setMessageCurrentUser]);

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
          setUnread(chJson.data[0]!.id, 0);

          const unreadResp = await fetch(`${API_BASE}/api/v1/workspaces/${wJson.data[0]!.id}/unread-counts`, { headers });
          const unreadJson = (await unreadResp.json()) as { ok: boolean; data: Record<string, number> };
          if (unreadJson.ok && unreadJson.data) {
            for (const [chId, count] of Object.entries(unreadJson.data)) {
              useChannelStore.getState().setUnread(chId, count);
            }
          }

          for (const channel of chJson.data) {
            const msgs = await fetch(`${API_BASE}/api/v1/channels/${channel.id}/messages?limit=50`, { headers });
            const msgsJson = (await msgs.json()) as { ok: boolean; data: Message[] };
            if (msgsJson.ok && Array.isArray(msgsJson.data)) {
              msgsJson.data.forEach((m: Message) => upsertMessage(m, "sent"));
            }

            // Load reactions for this channel
            const reactResp = await fetch(`${API_BASE}/api/v1/channels/${channel.id}/reactions`, { headers });
            const reactJson = (await reactResp.json()) as { ok: boolean; data: Record<string, Array<{ emoji: string; count: number; reacted: boolean }>> };
            if (reactJson.ok && reactJson.data) {
              const state = useMessageStore.getState();
              for (const [msgId, emojiList] of Object.entries(reactJson.data)) {
                for (const item of emojiList) {
                  state.setReaction(msgId, item.emoji, item.count, item.reacted);
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
        const payload = event.payload as { messageId: string; emoji: string; count: number; reacted: boolean };
        if (payload.messageId && payload.emoji) {
          setReaction(payload.messageId, payload.emoji, payload.count, payload.reacted);
        }
      }
      if (event.type === "channel.created") {
        const ch = event.payload as Channel;
        if (ch.id && ch.workspaceId) {
          setChannels([...useChannelStore.getState().channels, ch]);
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

  // Fetch members when in server mode
  useEffect(() => {
    if (!accessToken || !workspaces[0] || members.length > 0) return;
    (async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/v1/workspaces/${workspaces[0]!.id}/members`, {
          headers: { authorization: `Bearer ${accessToken}` }
        });
        const json = (await resp.json()) as { ok: boolean; data: Array<{ userId: string; role: string; email: string; displayName: string }> };
        if (json.ok) setMembers(json.data.map((m) => ({ ...m, displayName: m.displayName || (m.email?.split("@")[0] ?? m.userId.slice(0, 10)) })));
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

  const handleCopy = (message: Message) => {
    const text = message.content.type === "text" ? message.content.text : decryptedMessages[message.id] ?? "";
    void window.navigator.clipboard.writeText(text);
  };

  const insertEmoji = (emoji: string) => {
    setDraft(draft + emoji);
  };

  const handleFileUpload = async (file: File) => {
    if (!accessToken || !workspaces[0]) return;
    const controller = new AbortController();
    const entry = { name: file.name, progress: 0, cancel: () => controller.abort() };
    setUploading((prev) => [...prev, entry]);
    try {
      const createResp = await fetch(`${API_BASE}/api/v1/attachments/upload-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ workspaceId: workspaces[0].id, fileName: file.name, contentType: file.type, sizeBytes: file.size })
      });
      const createJson = (await createResp.json()) as { ok: boolean; data?: { file: { id: string; objectKey: string; scanStatus: string }; uploadSession: { id: string; uploadUrl: string } } };
      if (!createJson.ok || !createJson.data) return;
      const { uploadSession, file: fileRecord } = createJson.data;
      const uploadResp = await fetch(uploadSession.uploadUrl, { method: "PUT", body: file, signal: controller.signal });
      if (!uploadResp.ok) throw new Error("Upload failed");
      await fetch(`${API_BASE}/api/v1/attachments/upload-sessions/${uploadSession.id}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      setPendingAttachments((prev) => [...prev, { fileId: fileRecord.id, name: file.name, mimeType: file.type, size: file.size, scanStatus: fileRecord.scanStatus }]);
      const currentDraft = useUiStore.getState().messageDraft;
      setDraft((currentDraft ? `${currentDraft} ` : "") + `[${file.name}]`);
    } catch (e) {
      if (e instanceof Error && e.name !== "AbortError") { /* ignore */ }
    }
    setUploading((prev) => prev.filter((e) => e !== entry));
  };

  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item?.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) void handleFileUpload(file);
      }
    }
  };

  const handleEdit = async (messageId: string, newText: string) => {
    if (!accessToken) return;
    try {
      const resp = await fetch(`${API_BASE}/api/v1/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ text: newText })
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) upsertMessage(json.data);
    } catch { /* */ }
  };

  const handleDelete = async (messageId: string) => {
    setConfirmDeleteId(messageId);
  };

  const confirmDelete = async () => {
    if (!accessToken || !confirmDeleteId) { setConfirmDeleteId(null); return; }
    try {
      const resp = await fetch(`${API_BASE}/api/v1/messages/${confirmDeleteId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      const json = (await resp.json()) as { ok: boolean; data?: Message };
      if (json.ok && json.data) upsertMessage(json.data);
    } catch { /* */ }
    setConfirmDeleteId(null);
  };

  const handleReact = async (messageId: string, emoji: string) => {
    if (!accessToken) return;
    const msgReactions = reactions[messageId] ?? {};
    const existing = msgReactions[emoji];
    const isRemove = existing?.reacted === true;
    try {
      const method = isRemove ? "DELETE" : "POST";
      const resp = await fetch(`${API_BASE}/api/v1/messages/${messageId}/reactions`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ emoji })
      });
      const json = (await resp.json()) as { ok: boolean; data?: { messageId: string; emoji: string; count: number; reacted: boolean } };
      if (json.ok && json.data) {
        setReaction(json.data.messageId, json.data.emoji, json.data.count, json.data.reacted);
      }
    } catch { /* */ }
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
    setPendingAttachments([]);
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
  const themeChatInput = isLight ? "bg-white border border-slate-200 focus:ring-sky-400" : "bg-slate-900 ring-sky-400";
  const themeDivider = isLight ? "border-slate-200" : "border-slate-700";
  const themeSelect = isLight ? "bg-white border border-slate-300 text-slate-800" : "bg-slate-800 border border-slate-700 text-slate-200";
  const compact = settings.compactMode ? "p-2 text-xs" : "p-4";
  const senderNames = Object.fromEntries(members.map((m) => [m.userId, m.displayName ?? m.email?.split("@")[0] ?? m.userId.slice(0, 10)]));
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
                    <span className={`h-2 w-2 rounded-full ${m.role === "owner" ? "bg-amber-400" : m.role === "admin" ? "bg-sky-400" : "bg-emerald-400"}`}></span>
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
        <div className={`border-t ${themeBorder} px-3 py-3`}>
          <div className="flex gap-1">
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "chat" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("chat")} title="Chat">💬</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "member" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("member")} title="Members">👥</button>
            <button className={`flex-1 rounded-lg px-3 py-2 text-center text-sm transition ${leftTab === "settings" ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setLeftTab("settings")} title="Settings">⚙</button>
          </div>
        </div>
      </aside>
      <section className="relative flex min-w-0 flex-col overflow-hidden">
        <header className={`border-b ${themeHeader} ${compact}`}>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{activeChannel?.name ?? "Select a channel"}</h2>
            {isE2e ? <Badge tone="warning">Encrypted DM</Badge> : <Badge tone="success">Bots enabled</Badge>}
            {isDm ? (
              <select
                className={`rounded-lg ${themeSelect} px-2 py-1 text-xs`}
                value={dmTransportMode}
                onChange={(e) => setDmTransportMode(e.target.value as DmTransportMode)}
              >
                <option value="auto">Auto</option>
                <option value="relay">Signal</option>
                <option value="p2p">P2P</option>
              </select>
            ) : null}
            {isDm ? <Badge tone={peerOnline ? "success" : "warning"}>{peerOnline ? "Online" : "Offline"}</Badge> : null}
            {socketRef.current ? <Badge tone={wsConnected ? "success" : "warning"}>{wsConnected ? "WS connected" : "WS disconnected"}</Badge> : null}
            <div className="ml-auto flex items-center gap-2">
              <button className={`rounded-lg px-3 py-1 text-sm transition ${rightSidebarOpen ? themeTabActive : themeTabInactive}`} type="button" onClick={() => setRightSidebarOpen(!rightSidebarOpen)} title="Group Members">👥 Members</button>
            </div>
          </div>
          {isE2e ? <p className="mt-2 text-sm text-amber-200">Bots, slash commands, previews, and server-side search are disabled here.</p> : null}
          {activeChannelId ? Object.entries(typingUsers).filter(([, chId]) => chId === activeChannelId).length > 0 ? (
            <p className="mt-1 text-xs italic text-slate-400">
              {Object.entries(typingUsers)
                .filter(([, chId]) => chId === activeChannelId)
                .map(([uid]) => uid.slice(0, 10))
                .join(", ")}{" "}
              typing...
            </p>
          ) : null : null}
        </header>
        <MessageList messages={channelMessages} statuses={statuses} decryptedMessages={decryptedMessages} transportLabels={transportLabels} readReceipts={readReceipts} senderNames={senderNames} onMessagesVisible={handleMessagesVisible} onReply={setReplyMessage} onForward={setForwardSource} onEdit={handleEdit} onDelete={handleDelete} onCopy={handleCopy} onReact={handleReact} />
        <form onSubmit={submit}>
          {replyMessage ? (
            <div className={`mx-4 mb-1 flex items-center gap-2 rounded-t-xl border-l-4 border-sky-400 px-4 py-2 ${isLight ? "bg-sky-50" : "bg-sky-500/10"}`}>
              <span className="text-xs text-sky-400">Replying to</span>
              <span className="text-xs font-medium text-sky-300">{senderNames[replyMessage.senderId] ?? replyMessage.senderId.slice(0, 10)}</span>
              <span className="flex-1 truncate text-xs text-slate-400">{replyMessage.content.type === "text" ? replyMessage.content.text.slice(0, 60) : "message"}</span>
              <button className="rounded px-1 text-xs text-slate-400 hover:text-slate-200" type="button" onClick={() => setReplyMessage(null)}>✕</button>
            </div>
          ) : null}
          <InputActionBar
            actions={
              <>
                {!isE2e
                  ? inputActions.map((action) => (
                      <button key={action.id} className={`rounded-full ${themeBtn} px-3 py-1 text-xs`} type="button" onClick={() => setDraft(action.command)}>
                        {action.label}
                      </button>
                    ))
                  : null}
                <PolicyControl isE2e={Boolean(isE2e)} policy={policy} onChange={setPolicy} />
              </>
            }
          >
            <div className="relative">
              <button
                className={`rounded-full ${themeBtn} px-3 py-1 text-xs`}
                type="button"
                onClick={(e) => {
                  const rect = (e.target as HTMLElement).getBoundingClientRect();
                  setEmojiPickerPos({ x: rect.left, y: rect.top });
                  setEmojiPickerOpen(!emojiPickerOpen);
                }}
                title="Emoji"
              >😀</button>
            </div>
            <input ref={fileInputRef} className="hidden" type="file" multiple onChange={(e) => { const files = e.target.files; if (files) for (let i = 0; i < files.length; i += 1) void handleFileUpload(files[i]!); e.target.value = ""; }} />
            {!isE2e ? (
              <button className={`rounded-full ${themeBtn} px-3 py-1 text-xs`} type="button" onClick={() => fileInputRef.current?.click()} title="Attach">📎</button>
            ) : null}
            <div className="relative flex flex-1 flex-col">
              {suggestions.length ? (
                <div className={`absolute bottom-full left-0 z-10 mb-1 w-full max-w-lg overflow-hidden rounded-2xl border ${themeBorder} ${isLight ? "bg-white shadow-lg" : "bg-slate-900 shadow-xl"}`}>
                  {suggestions.map((suggestion) => (
                    <button key={`${suggestion.botId}-${suggestion.name}`} className={`block w-full px-4 py-3 text-left text-sm ${isLight ? "hover:bg-slate-100" : "hover:bg-slate-800"}`} type="button" onClick={() => setDraft(`${suggestion.name} `)}>
                      <span className="font-medium text-sky-200">{suggestion.name}</span>
                      <span className="ml-2 text-slate-400">{suggestion.description}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                className={`w-full resize-none rounded-xl ${themeChatInput} px-4 py-3 outline-none transition placeholder:text-slate-400 focus:ring-2`}
                placeholder={p2pBlocked ? "P2P mode: peer is offline" : isE2e ? "Encrypted message" : "Message or /command"}
                value={draft}
                disabled={p2pBlocked}
                onChange={(event) => handleTypingChange(event.target.value)}
                onBlur={stopTyping}
                onPaste={handlePaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(event as unknown as FormEvent); }
                }}
                rows={1}
              />
            </div>
            {uploading.map((entry) => (
              <div key={entry.name} className="flex items-center gap-2 px-1 text-xs text-slate-400">
                <span className="truncate">{entry.name}</span>
                <div className="h-1 flex-1 rounded-full bg-slate-700">
                  <div className="h-full rounded-full bg-sky-400" style={{ width: `${entry.progress}%` }} />
                </div>
                <button className="text-red-400 hover:text-red-300" type="button" onClick={entry.cancel}>✕</button>
              </div>
            ))}
            <button className={`rounded-xl px-5 py-3 font-semibold text-slate-950 transition ${p2pBlocked ? "cursor-not-allowed bg-slate-600" : "bg-sky-400 hover:bg-sky-300"}`} type="submit" disabled={p2pBlocked}>
              Send
            </button>
          </InputActionBar>
        </form>
      </section>
      {rightSidebarOpen ? (
        <aside className={`border-l ${themeAside} max-md:hidden overflow-y-auto`}>
          <div className={`${compact}`}>
            <div className="flex items-center justify-between mb-3">
              <h2 className={`text-xs uppercase tracking-wide ${themeSectionTitle}`}>Group Members ({channelMembers.length})</h2>
              <button className={`rounded-lg ${themeBtn} px-2 py-0.5 text-xs`} type="button" onClick={() => setRightSidebarOpen(false)}>✕</button>
            </div>
            <div className="mb-2 flex gap-1">
              <input className={`flex-1 rounded-lg ${themeInput} px-2 py-1 text-xs outline-none`} placeholder="User ID to add..." value={addMemberInput} onChange={(e) => setAddMemberInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addChannelMember()} />
              <button className="rounded-lg bg-sky-500/20 px-2 py-1 text-xs text-sky-200 hover:bg-sky-500/30" type="button" onClick={addChannelMember}>Add</button>
            </div>
            <div className="space-y-1">
              {channelMembers.map((cm) => {
                const memberInfo = members.find((m) => m.userId === cm.userId);
                return (
                  <div key={cm.userId} className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-xs ${themeMember}`}>
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                      <span>{memberInfo?.displayName ?? cm.userId.slice(0, 10)}</span>
                    </div>
                    {cm.userId !== user?.id ? (
                      <button className={`rounded ${themeMemberBadge} px-1.5 py-0.5 text-xs opacity-0 group-hover:opacity-100 hover:bg-red-500/20 hover:text-red-200 transition`} type="button" onClick={() => removeChannelMember(cm.userId)} title="Remove">✕</button>
                    ) : null}
                  </div>
                );
              })}
              {channelMembers.length === 0 ? <p className={`text-xs ${themeMuted} px-2`}>No members yet</p> : null}
            </div>
          </div>
        </aside>
      ) : null}
      {forwardSource ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => { setForwardSource(null); setForwardSearch(""); }}>
          <div className={`w-80 rounded-2xl border ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"} p-4 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-semibold">Forward message</h3>
            <input className={`mb-2 w-full rounded-lg ${themeInput} px-3 py-2 text-sm outline-none`} placeholder="Search channels..." value={forwardSearch} onChange={(e) => setForwardSearch(e.target.value)} autoFocus />
            <div className="max-h-48 space-y-0.5 overflow-y-auto">
              {channels.filter((c) => c.id !== activeChannelId && (!forwardSearch || c.name.toLowerCase().includes(forwardSearch.toLowerCase()))).map((c) => (
                <button
                  key={c.id}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${isLight ? "hover:bg-slate-100 text-slate-700" : "hover:bg-slate-800 text-slate-300"}`}
                  type="button"
                  onClick={async () => {
                    if (!accessToken) return;
                    try {
                      const resp = await fetch(`${API_BASE}/api/v1/messages/${forwardSource.id}/forward`, {
                        method: "POST",
                        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
                        body: JSON.stringify({ targetChannelId: c.id, clientMsgId: `fwd-${Date.now()}` })
                      });
                      const json = (await resp.json()) as { ok: boolean; data?: Message };
                      if (json.ok && json.data) {
                        upsertMessage(json.data);
                        selectChannel(c.id);
                      }
                    } catch { /* */ }
                    setForwardSource(null);
                    setForwardSearch("");
                  }}
                >{c.kind === "dm" ? "@" : "#"} {c.name}</button>
              ))}
            </div>
            <button className={`mt-3 w-full rounded-lg px-3 py-2 text-sm ${themeBtn}`} type="button" onClick={() => { setForwardSource(null); setForwardSearch(""); }}>Cancel</button>
          </div>
        </div>
      ) : null}
      {confirmDeleteId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setConfirmDeleteId(null)}>
          <div className={`w-72 rounded-2xl border ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"} p-4 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
            <p className="mb-4 text-sm">Delete this message?</p>
            <div className="flex gap-2">
              <button className="flex-1 rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-200 hover:bg-red-500/30" type="button" onClick={() => void confirmDelete()}>Delete</button>
              <button className={`flex-1 rounded-lg px-3 py-2 text-sm ${themeBtn}`} type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
      {emojiPickerOpen && emojiPickerPos ? (
        <div className="fixed inset-0 z-40" onClick={() => setEmojiPickerOpen(false)}>
          <div
            className={`absolute grid grid-cols-8 gap-1 rounded-xl border p-2 shadow-2xl ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"}`}
            style={{ left: emojiPickerPos.x, bottom: window.innerHeight - emojiPickerPos.y + 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            {["😀","😂","😍","🤔","😢","😡","👍","👎","👏","🙏","💪","🎉","🔥","❤️","💯","✅","❌","⭐","🚀","💡","🎯","📌","👀","💀","🎵","💰","📅","🔒","🔑","💬","🍕","☕"].map((e) => (
              <button key={e} className="rounded-lg p-1 text-lg hover:bg-slate-700" type="button" onClick={() => { insertEmoji(e); setEmojiPickerOpen(false); }}>{e}</button>
            ))}
          </div>
        </div>
      ) : null}
    </main>
  );
};

export default ChatRoute;
