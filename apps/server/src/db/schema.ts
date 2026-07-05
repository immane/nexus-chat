import { desc, relations } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const workspaceRole = pgEnum("workspace_role", ["owner", "admin", "member"]);
export const channelKind = pgEnum("channel_kind", ["channel", "dm"]);
export const channelMode = pgEnum("channel_mode", ["normal", "e2e"]);
export const messageState = pgEnum("message_state", ["sent", "delivered", "read", "deleted"]);
export const scanStatus = pgEnum("scan_status", ["pending", "clean", "blocked", "skipped"]);
export const uploadSessionStatus = pgEnum("upload_session_status", ["pending", "completed", "expired", "aborted"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    userId: text("user_id").notNull().references(() => users.id),
    role: workspaceRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ pk: primaryKey({ columns: [table.workspaceId, table.userId] }), userIdx: index("workspace_members_user_idx").on(table.userId) })
);

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    name: text("name").notNull(),
    kind: channelKind("kind").notNull().default("channel"),
    mode: channelMode("mode").notNull().default("normal"),
    isPrivate: boolean("is_private").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ workspaceIdx: index("channels_workspace_idx").on(table.workspaceId), lookupIdx: uniqueIndex("channels_workspace_name_idx").on(table.workspaceId, table.name) })
);

export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: text("channel_id").notNull().references(() => channels.id),
    userId: text("user_id").notNull().references(() => users.id),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    readCursorMessageId: text("read_cursor_message_id")
  },
  (table) => ({ pk: primaryKey({ columns: [table.channelId, table.userId] }), userJoinedIdx: index("channel_members_user_joined_idx").on(table.userId, table.joinedAt) })
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    channelId: text("channel_id").notNull().references(() => channels.id),
    senderId: text("sender_id").notNull().references(() => users.id),
    clientMsgId: text("client_msg_id").notNull(),
    content: jsonb("content").notNull(),
    state: messageState("state").notNull().default("sent"),
    originalMessageId: text("original_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true })
  },
  (table) => ({
    channelPageIdx: index("messages_channel_page_idx").on(table.channelId, desc(table.id)),
    idempotencyIdx: uniqueIndex("messages_sender_client_msg_idx").on(table.senderId, table.clientMsgId)
  })
);

export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: text("message_id").notNull().references(() => messages.id),
    userId: text("user_id").notNull().references(() => users.id),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ pk: primaryKey({ columns: [table.messageId, table.userId, table.emoji] }) })
);

export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
    ownerId: text("owner_id").notNull().references(() => users.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    objectKey: text("object_key").notNull(),
    encrypted: boolean("encrypted").notNull().default(false),
    scanStatus: scanStatus("scan_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({ workspaceListingIdx: index("files_workspace_created_idx").on(table.workspaceId, table.createdAt), ownerListingIdx: index("files_workspace_owner_idx").on(table.workspaceId, table.ownerId), scanIdx: index("files_scan_idx").on(table.scanStatus) })
);

export const uploadSessions = pgTable("upload_sessions", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().references(() => files.id),
  userId: text("user_id").notNull().references(() => users.id),
  status: uploadSessionStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true })
}, (table) => ({ cleanupIdx: index("upload_sessions_cleanup_idx").on(table.status, table.expiresAt) }));

export const messageAttachments = pgTable(
  "message_attachments",
  {
    messageId: text("message_id").notNull().references(() => messages.id),
    fileId: text("file_id").notNull().references(() => files.id)
  },
  (table) => ({ pk: primaryKey({ columns: [table.messageId, table.fileId] }) })
);

export const botIntegrations = pgTable("bot_integrations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  manifest: jsonb("manifest").notNull(),
  scopes: jsonb("scopes").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({ workspaceIdx: index("bot_integrations_workspace_idx").on(table.workspaceId) }));

export const botChannelMemberships = pgTable(
  "bot_channel_memberships",
  {
    botId: text("bot_id").notNull().references(() => botIntegrations.id),
    channelId: text("channel_id").notNull().references(() => channels.id)
  },
  (table) => ({ pk: primaryKey({ columns: [table.botId, table.channelId] }), channelIdx: index("bot_channel_memberships_channel_idx").on(table.channelId) })
);

export const botEventSubscriptions = pgTable("bot_event_subscriptions", {
  id: text("id").primaryKey(),
  botId: text("bot_id").notNull().references(() => botIntegrations.id),
  eventType: text("event_type").notNull()
});

export const signalPreKeyBundles = pgTable("signal_prekey_bundles", {
  userId: text("user_id").notNull().references(() => users.id),
  deviceId: text("device_id").notNull(),
  identityKey: text("identity_key").notNull(),
  signedPreKeyId: integer("signed_prekey_id").notNull(),
  signedPreKey: text("signed_prekey").notNull(),
  signedPreKeySignature: text("signed_prekey_signature").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.deviceId] }) }));

export const signalOneTimePreKeys = pgTable("signal_one_time_prekeys", {
  userId: text("user_id").notNull().references(() => users.id),
  deviceId: text("device_id").notNull(),
  keyId: integer("key_id").notNull(),
  publicKey: text("public_key").notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true })
}, (table) => ({ pk: primaryKey({ columns: [table.userId, table.deviceId, table.keyId] }) }));

export const signalSessions = pgTable("signal_sessions", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  peerUserId: text("peer_user_id").notNull().references(() => users.id),
  deviceId: text("device_id").notNull(),
  metadata: jsonb("metadata").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const auditLogs = pgTable("audit_logs", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id"),
  workspaceId: text("workspace_id"),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const workspaceRelations = relations(workspaces, ({ many }) => ({ members: many(workspaceMembers), channels: many(channels) }));
