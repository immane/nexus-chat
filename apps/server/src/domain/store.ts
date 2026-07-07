import type { BotEvent, BotManifest, Channel, FileRecord, Message, SignalPreKeyBundle, User, Workspace, WorkspaceMember } from "@nexus-chat/shared";

export type StoredUser = User & { passwordHash: string };
export type ChannelMember = { channelId: string; userId: string };
export type RefreshSession = { userId: string; tokenHash: string; expiresAt: number; revokedAt?: number };
export type OneTimePreKey = { userId: string; deviceId: string; keyId: number; publicKey: string; consumedAt?: string };
export type SignalSessionRecord = { id: string; ownerUserId: string; peerUserId: string; deviceId: string; metadata: unknown; updatedAt: string };
export type UploadSession = { id: string; fileId: string; userId: string; uploadUrl: string; expiresAt: string; completedAt?: string };
export type BotIntegration = { id: string; workspaceId: string; manifest: BotManifest; tokenHash: string; channelIds: Set<string>; subscribedEvents: Set<string>; pendingEvents: BotEvent[] };
export type MessageReaction = { messageId: string; userId: string; emoji: string; createdAt: string };
export type SavedMessage = { messageId: string; userId: string; createdAt: string };
export type ReadReceipt = { messageId: string; userId: string; readAt: string };
export type MessageDomainEvent = { type: "message.updated" | "message.deleted" | "message.reaction" | "message.read"; channelId: string; payload: unknown; createdAt: string };

export class InMemoryStore {
  users = new Map<string, StoredUser>();
  usersByEmail = new Map<string, string>();
  workspaces = new Map<string, Workspace>();
  workspaceMembers = new Map<string, WorkspaceMember>();
  channels = new Map<string, Channel>();
  channelMembers = new Map<string, ChannelMember>();
  messages = new Map<string, Message>();
  messagesByClientId = new Map<string, string>();
  messageReactions = new Map<string, MessageReaction>();
  savedMessages = new Map<string, SavedMessage>();
  readReceipts = new Map<string, ReadReceipt>();
  pendingReadReceipts: ReadReceipt[] = [];
  messageEvents: MessageDomainEvent[] = [];
  messageAttachments = new Map<string, Set<string>>();
  files = new Map<string, FileRecord>();
  uploadSessions = new Map<string, UploadSession>();
  refreshSessions = new Map<string, RefreshSession>();
  bots = new Map<string, BotIntegration>();
  signalBundles = new Map<string, SignalPreKeyBundle>();
  oneTimePreKeys = new Map<string, OneTimePreKey>();
  signalSessions = new Map<string, SignalSessionRecord>();
  channelLastRead = new Map<string, string>();
  devFileContent?: Map<string, ArrayBuffer>;
  auditLogs: Array<{ id: string; actorUserId?: string | undefined; workspaceId?: string | undefined; action: string; metadata: unknown; createdAt: string }> = [];
}

export const store = new InMemoryStore();
