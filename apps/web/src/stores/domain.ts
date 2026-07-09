/**
 * Zustand Domain Stores (Web Client State Management)
 *
 * Multi-store architecture with normalized state for O(1) lookups.
 * Each store owns a distinct domain concern:
 *
 * Stores:
 * - useAuthStore — persisted to localStorage ("nexus-auth" key); session, tokens, user profile
 * - useWorkspaceStore — workspace list and active workspace ID
 * - useChannelStore — channel list, active channel, per-channel unread counts
 * - useMessageStore — normalized message Map + insertion order array, send statuses, reactions
 * - usePresenceStore — online user IDs Set
 * - useSignalStore — E2E-enabled channel IDs Set
 * - useBotStore — bot manifests and registered input actions
 * - useUiStore — sidebar, draft, disappearing policy, settings, DM transport mode
 *
 * Key Design Decisions:
 * - Messages use a Map<id, Message> for O(1) upsert/lookup plus a separate "order" array
 *   for insertion-order iteration. This avoids re-sorting on every update.
 * - Reactions are stored as Record<messageId, Record<emoji, {count, reacted}>> —
 *   each MessageRow subscribes only to its own reactions, not the full reactions map.
 * - createOptimisticMessage generates local Messages with an "optimistic-" prefix for
 *   instant UI feedback before the server confirms.
 * - Auth is persisted to localStorage (via zustand/middleware persist) so the session
 *   survives page reloads.
 *
 * Does NOT:
 * - Handle WebSocket state (owned by ChatRoute.tsx refs)
 * - Store decrypted message text (owned by ChatRoute.tsx useState)
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AuthSession, BotManifest, Channel, Message, MessageContent, User, Workspace } from "@nexus-chat/shared";

export type MessageSendStatus = "sending" | "sent" | "failed";
export type DisappearingDraftPolicy = { mode: "none" } | { mode: "read_once" } | { mode: "ttl"; ttlSeconds: number };
export type InputAction = { id: string; label: string; description: string; command: string };

export const createClientMsgId = () => `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * Creates a local-only Message for instant UI feedback.
 *
 * The message gets a temporary "optimistic-*" ID. When the server broadcasts
 * the confirmed message (via WebSocket message.created), ChatRoute replaces
 * this optimistic entry using clientMsgId deduplication.
 *
 * Side Effects: None (pure factory, no store mutation).
 */
export const createOptimisticMessage = (input: {
  workspaceId: string;
  channelId: string;
  senderId: string;
  text: string;
  policy: DisappearingDraftPolicy;
}): Message => {
  const now = new Date();
  let content: MessageContent;
  if (input.policy.mode === "none") {
    content = { type: "text", text: input.text, attachments: [] };
  } else if (input.policy.mode === "ttl") {
    content = {
      type: "ciphertext",
      ciphertext: input.text,
      algorithm: "signal-v1",
      senderDeviceId: "local-device",
      readOnce: false,
      expiresAt: new Date(now.getTime() + input.policy.ttlSeconds * 1000).toISOString(),
      attachments: []
    };
  } else {
    content = {
      type: "ciphertext",
      ciphertext: input.text,
      algorithm: "signal-v1",
      senderDeviceId: "local-device",
      readOnce: true,
      attachments: []
    };
  }

  return {
    id: `optimistic-${createClientMsgId()}`,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    senderId: input.senderId,
    clientMsgId: createClientMsgId(),
    content,
    state: "sent",
    createdAt: now.toISOString()
  };
};

export const getPolicyLabel = (policy: DisappearingDraftPolicy) => {
  if (policy.mode === "read_once") return "Read once";
  if (policy.mode === "ttl") return `Expires after ${Math.round(policy.ttlSeconds / 60)} min`;
  return "Standard message";
};

export const getCommandSuggestions = (manifests: BotManifest[], input: string) => {
  if (!input.startsWith("/")) return [];
  const query = input.trim().split(/\s+/)[0]?.toLowerCase() ?? "/";
  return manifests
    .flatMap((manifest) => manifest.commands.map((command) => ({ ...command, botName: manifest.name, botId: manifest.id })))
    .filter((command) => command.name.toLowerCase().startsWith(query))
    .slice(0, 8);
};

export const selectChannelMessages = (messages: Map<string, Message>, order: string[], channelId?: string) =>
  order
    .map((id) => messages.get(id))
    .filter((message): message is Message => message !== undefined)
    .filter((message) => message.channelId === channelId);

export const useAuthStore = create(
  persist<{ user: User | undefined; accessToken: string | undefined; refreshToken: string | undefined; setSession: (session: AuthSession) => void; clear: () => void }>(
    (set) => ({
      user: undefined,
      accessToken: undefined,
      refreshToken: undefined,
      setSession: (session) => set({ user: session.user, accessToken: session.tokens.accessToken, refreshToken: session.tokens.refreshToken }),
      clear: () => set({ user: undefined, accessToken: undefined, refreshToken: undefined })
    }),
    {
      name: "nexus-auth",
      storage: createJSONStorage(() => localStorage)
    }
  )
);

export const useWorkspaceStore = create<{ workspaces: Workspace[]; activeWorkspaceId?: string; setWorkspaces: (workspaces: Workspace[]) => void; setActive: (id: string) => void }>((set) => ({
  workspaces: [],
  setWorkspaces: (workspaces) => set({ workspaces }),
  setActive: (id) => set({ activeWorkspaceId: id })
}));

export const useChannelStore = create<{
  channels: Channel[];
  activeChannelId?: string;
  unreadCounts: Record<string, number>;
  setChannels: (channels: Channel[]) => void;
  setActive: (id: string) => void;
  setUnread: (channelId: string, count: number) => void;
}>((set) => ({
  channels: [],
  unreadCounts: {},
  setChannels: (channels) => set({ channels }),
  setActive: (id) => set({ activeChannelId: id }),
  setUnread: (channelId, count) => set((state) => ({ unreadCounts: { ...state.unreadCounts, [channelId]: count } }))
}));

export const useMessageStore = create<{
  messages: Map<string, Message>;
  order: string[];
  sendStatusByClientId: Record<string, MessageSendStatus>;
  // reactions shape: { [messageId]: { [emoji]: { count, reacted } } }
  // Nested by messageId so each MessageRow can subscribe to only its own
  // reactions slice, avoiding re-renders when other messages receive reactions.
  reactions: Record<string, Record<string, { count: number; reacted: boolean }>>;
  currentUserId: string | undefined;
  setCurrentUser: (userId: string) => void;
  upsert: (message: Message, status?: MessageSendStatus) => void;
  sendOptimistic: (message: Message) => void;
  markFailed: (clientMsgId: string) => void;
  setReaction: (messageId: string, emoji: string, count: number, reacted: boolean) => void;
  clear: () => void;
}>((set) => ({
  messages: new Map(),
  order: [],
  sendStatusByClientId: {},
  reactions: {},
  currentUserId: undefined,
  upsert: (message, status = "sent") => set((state) => {
    const messages = new Map(state.messages);
    messages.set(message.id, message);
    return {
      messages,
      order: state.order.includes(message.id) ? state.order : [...state.order, message.id],
      sendStatusByClientId: { ...state.sendStatusByClientId, [message.clientMsgId]: status }
    };
  }),
  sendOptimistic: (message) => set((state) => {
    const messages = new Map(state.messages);
    messages.set(message.id, message);
    return {
      messages,
      order: state.order.includes(message.id) ? state.order : [...state.order, message.id],
      sendStatusByClientId: { ...state.sendStatusByClientId, [message.clientMsgId]: "sending" }
    };
  }),
  markFailed: (clientMsgId) => set((state) => ({ sendStatusByClientId: { ...state.sendStatusByClientId, [clientMsgId]: "failed" } })),
  setReaction: (messageId, emoji, count, reacted) => set((state) => {
    const messageReactions = { ...(state.reactions[messageId] ?? {}) };
    if (count === 0) delete messageReactions[emoji];
    else messageReactions[emoji] = { count, reacted };
    return { reactions: { ...state.reactions, [messageId]: messageReactions } };
  }),
  setCurrentUser: (userId) => set({ currentUserId: userId }),
  clear: () => set({ messages: new Map(), order: [], sendStatusByClientId: {}, reactions: {}, currentUserId: undefined })
}));

export const usePresenceStore = create<{ onlineUserIds: Set<string>; setOnline: (userId: string, online: boolean) => void }>((set) => ({
  onlineUserIds: new Set(),
  setOnline: (userId, online) => set((state) => {
    const onlineUserIds = new Set(state.onlineUserIds);
    if (online) onlineUserIds.add(userId); else onlineUserIds.delete(userId);
    return { onlineUserIds };
  })
}));

export const useSignalStore = create<{ e2eEnabledChannelIds: Set<string>; markE2e: (channelId: string) => void }>((set) => ({
  e2eEnabledChannelIds: new Set(),
  markE2e: (channelId) => set((state) => ({ e2eEnabledChannelIds: new Set(state.e2eEnabledChannelIds).add(channelId) }))
}));

export const useBotStore = create<{
  manifests: BotManifest[];
  inputActions: InputAction[];
  setManifests: (manifests: BotManifest[]) => void;
  registerInputAction: (action: InputAction) => void;
}>((set) => ({
  manifests: [],
  inputActions: [],
  setManifests: (manifests) => set({ manifests }),
  registerInputAction: (action) => set((state) => ({ inputActions: [...state.inputActions.filter((item) => item.id !== action.id), action] }))
}));
export type AppTheme = "dark" | "light";
export type AppSettings = {
  theme: AppTheme;
  compactMode: boolean;
  soundEnabled: boolean;
  notificationsEnabled: boolean;
};
export type DmTransportMode = "auto" | "relay" | "p2p";

export const useUiStore = create<{
  sidebarOpen: boolean;
  messageDraft: string;
  disappearingPolicy: DisappearingDraftPolicy;
  settings: AppSettings;
  dmTransportMode: DmTransportMode;
  setSidebarOpen: (open: boolean) => void;
  setMessageDraft: (messageDraft: string) => void;
  setDisappearingPolicy: (disappearingPolicy: DisappearingDraftPolicy) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setDmTransportMode: (mode: DmTransportMode) => void;
}>((set) => ({
  sidebarOpen: false,
  messageDraft: "",
  disappearingPolicy: { mode: "none" },
  settings: { theme: "dark", compactMode: false, soundEnabled: false, notificationsEnabled: true },
  dmTransportMode: "auto",
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setMessageDraft: (messageDraft) => set({ messageDraft }),
  setDisappearingPolicy: (disappearingPolicy) => set({ disappearingPolicy }),
  updateSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
  setDmTransportMode: (dmTransportMode) => set({ dmTransportMode })
}));
