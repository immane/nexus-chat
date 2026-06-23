---
lang: en
---

# 03 — Business Logic & Persistence Backend Design

> Version: v1.0 | Last Updated: 2026-06-24 | Status: Design Phase  
> Dependencies: [backend-im-state-machine](../research/backend-im-state-machine.md), [security-defense-e2ee-roadmap](../research/security-defense-e2ee-roadmap.md)

---

## Table of Contents

1. [Business Logic Module Breakdown](#1-business-logic-module-breakdown)
2. [Data Model — Drizzle ORM Schema](#2-data-model--drizzle-orm-schema)
3. [Message State Machine](#3-message-state-machine)
4. [Channel State Machine](#4-channel-state-machine)
5. [Signal Protocol Key Server](#5-signal-protocol-key-server)
6. [Redis Caching Architecture](#6-redis-caching-architecture)
7. [Bot Integration Module](#7-bot-integration-module)
8. [Security Implementation](#8-security-implementation)

---

## 1. Business Logic Module Breakdown

The backend domain logic is organized into eight self-contained modules. Each module owns its routes, service layer, and persistence concerns.

```
server/
└── modules/
    ├── auth/          # Registration, login, JWT, token refresh, password reset
    ├── workspace/     # Workspace CRUD, member management, roles (owner/admin/member)
    ├── channel/       # Channel CRUD, type (public/private/DM), mode (normal/e2e), member management
    ├── message/       # Message CRUD, pagination, edit/delete, encryption metadata
    ├── attachment/    # Upload sessions, file metadata, scan status, signed URLs, E2E opaque blobs
    ├── signal/        # PreKeyBundle upload/fetch/revoke, key server (public keys only)
    ├── bot/           # Bot registration, token issuance, permission scoping, webhook config
    └── presence/      # Online status, last seen, typing indicators
```

### 1.1 Module Responsibilities

| Module | Primary Responsibility | Key Dependencies |
|---|---|---|
| `auth` | User identity lifecycle — register, login, JWT issuance, refresh token rotation, password reset flow | Redis (token blacklist), Argon2id |
| `workspace` | Workspace CRUD, join/leave, role promotion/demotion, ownership transfer | `auth` (JWT middleware) |
| `channel` | Channel lifecycle, DM auto-creation, member add/remove, E2EE mode toggle | `workspace` (membership check), `signal` (key rotation) |
| `message` | Message send/receive, cursor pagination, edit/delete, encryption metadata passthrough | `channel` (membership), Redis (hot cache), Socket.IO |
| `attachment` | File upload sessions, object metadata, scan status, thumbnail references, signed download URLs, E2E opaque blob lifecycle | `message`, object storage, virus scanner |
| `signal` | Public-key store — PreKeyBundle upload/fetch, one-time prekey consumption, exhaustion detection | PostgreSQL (transactional prekey ops) |
| `bot` | Bot user creation, opaque token issuance (DB hash for revocation), permission scoping, webhook delivery | `workspace`, `channel` |
| `presence` | WebSocket-backed online/offline state, typing indicators, last-seen timestamp | Redis (TTL-based), Socket.IO |

### 1.2 Inter-Module Communication

- **Synchronous (in-process)**: Modules call each other's service functions directly. TypeScript ensures compile-time interface contracts.
- **Asynchronous (Pub/Sub)**: Redis Pub/Sub channels propagate cross-cutting events (`message:new`, `presence:update`, `channel:member_change`) to all server instances.
- **Socket.IO rooms**: Each user joins `user:{userId}` (personal notification pipe) and `channel:{channelId}` (message fan-out). The `message` module emits to rooms; `presence` broadcasts to workspace-scoped rooms.

---

## 2. Data Model — Drizzle ORM Schema

### 2.1 Design Rationale

- **UUID v7** for all primary keys: time-ordered, sortable, enables single-column cursor pagination without `(created_at, id)` compound keys.
- **JSONB** for polymorphic or loosely-structured data (message content, channel metadata, notification settings). Strictly avoid JSONB for indexed fields, foreign keys, or range-query columns.
- **Soft delete** (`deleted_at`) for messages and channels: preserves referential integrity and enables undo.
- **Composite primary keys** for join tables (no surrogate PKs on M:N tables).

### 2.2 Core Table Definitions

```typescript
import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  jsonb,
  integer,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════
// users
// ═══════════════════════════════════════════════════════════
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 256 }).notNull(),
  displayName: varchar("display_name", { length: 200 }).notNull(),
  avatarUrl: text("avatar_url"),
  e2eeCapable: boolean("e2ee_capable").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  emailIdx: uniqueIndex("users_email_idx").on(table.email),
}));

// ═══════════════════════════════════════════════════════════
// workspaces
// ═══════════════════════════════════════════════════════════
export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  slugIdx: uniqueIndex("workspaces_slug_idx").on(table.slug),
  ownerIdx: index("workspaces_owner_idx").on(table.ownerId),
}));

// ═══════════════════════════════════════════════════════════
// workspace_members
// ═══════════════════════════════════════════════════════════
export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role", { length: 20 }).default("member").notNull(),
  // "owner" | "admin" | "member"
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
  userWsIdx: index("wm_user_ws_idx").on(table.userId, table.workspaceId),
}));

// ═══════════════════════════════════════════════════════════
// channels
// ═══════════════════════════════════════════════════════════
export const channels = pgTable("channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  type: varchar("type", { length: 20 }).notNull().default("public"),
  // "public" | "private" | "dm"
  mode: varchar("mode", { length: 20 }).notNull().default("normal"),
  // "normal" | "e2e"
  status: varchar("status", { length: 20 }).notNull().default("active"),
  // "active" | "archived" | "deleted"
  metadata: jsonb("metadata").$type<{
    dmParticipants?: string[];
    pinnedMessageIds?: string[];
    customEmoji?: Record<string, string>;
  }>(),
  createdBy: uuid("created_by")
    .references(() => users.id, { onDelete: "restrict" }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceNameIdx: uniqueIndex("channels_workspace_name_idx")
    .on(table.workspaceId, table.name),
  typeIdx: index("channels_type_idx").on(table.type),
  statusIdx: index("channels_status_idx").on(table.status, table.workspaceId),
  modeIdx: index("channels_mode_idx").on(table.mode),
}));

// ═══════════════════════════════════════════════════════════
// channel_members
// ═══════════════════════════════════════════════════════════
export const channelMembers = pgTable("channel_members", {
  channelId: uuid("channel_id")
    .references(() => channels.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).defaultNow().notNull(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  notificationSettings: jsonb("notification_settings").$type<{
    allMessages?: boolean;
    mentionsOnly?: boolean;
    none?: boolean;
  }>(),
}, (table) => ({
  pk: primaryKey({ columns: [table.channelId, table.userId] }),
  userChannelsIdx: index("cm_user_channels_idx").on(table.userId, table.joinedAt),
}));

// ═══════════════════════════════════════════════════════════
// messages
// ═══════════════════════════════════════════════════════════
export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelId: uuid("channel_id")
    .references(() => channels.id, { onDelete: "cascade" }).notNull(),
  senderId: uuid("sender_id")
    .references(() => users.id, { onDelete: "restrict" }).notNull(),
  clientMsgId: varchar("client_msg_id", { length: 64 }),
   content: jsonb("content").$type<{
     type: "text" | "image" | "file" | "system";
     text?: string;
     ciphertext?: string;
     // attachments[] stores message-render references to core Attachment
     // Service records. Clients never submit arbitrary URLs; download URLs
     // are minted by the Attachment Service after authz and scan checks.
     // @FileBot is only a UX/workflow layer over this core service.
     attachments?: {
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      scanStatus: "pending" | "clean" | "blocked";
      thumbnailFileId?: string;
    }[];
    mentions?: string[];
  }>().notNull(),
  encryption: varchar("encryption", { length: 20 }).default("none").notNull(),
  // "none" | "e2e"
  encryptionMetadata: jsonb("encryption_metadata").$type<{
    senderDeviceId?: number;
    sessionVersion?: number;
    ratchetStep?: number;
  }>(),
  replyToId: uuid("reply_to_id"),
  threadId: uuid("thread_id"),
  status: varchar("status", { length: 20 }).default("sent").notNull(),
  // "sending" | "sent" | "delivered" | "read" | "failed"
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  channelCursorIdx: index("msg_channel_cursor_idx")
    .on(table.channelId, sql`id DESC`),
  clientMsgIdx: uniqueIndex("msg_client_msg_idx")
    .on(table.senderId, table.clientMsgId),
  senderIdx: index("msg_sender_idx").on(table.senderId, table.createdAt),
  threadIdx: index("msg_thread_idx").on(table.threadId, table.createdAt),
  encryptionIdx: index("msg_encryption_idx").on(table.encryption),
}));

// ═══════════════════════════════════════════════════════════
// files / attachments (core infrastructure)
// ═══════════════════════════════════════════════════════════
// Files are core because authz, scan status, retention, signed URL issuance,
// and E2E opaque blob lifecycle cannot safely be delegated to a bot.
// FileBot uses these APIs but does not own storage authority.
export const files = pgTable("files", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  ownerId: uuid("owner_id")
    .references(() => users.id, { onDelete: "restrict" }).notNull(),
  objectKey: text("object_key").notNull(),
  name: varchar("name", { length: 500 }).notNull(),
  mimeType: varchar("mime_type", { length: 255 }).notNull(),
  size: integer("size").notNull(),
  contentHash: varchar("content_hash", { length: 128 }).notNull(),
  encryption: varchar("encryption", { length: 20 }).default("none").notNull(),
  // "none" | "e2e". E2E files are client-encrypted opaque blobs.
  scanStatus: varchar("scan_status", { length: 20 }).default("pending").notNull(),
  // "pending" | "clean" | "blocked" | "failed"
  retentionUntil: timestamp("retention_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceIdx: index("files_workspace_idx").on(table.workspaceId, table.createdAt),
  hashIdx: index("files_hash_idx").on(table.contentHash),
  scanIdx: index("files_scan_idx").on(table.scanStatus),
}));

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  objectKey: text("object_key").notNull(),
  status: varchar("status", { length: 20 }).default("pending").notNull(),
  // "pending" | "uploaded" | "expired" | "cancelled"
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index("upload_sessions_user_idx").on(table.userId, table.createdAt),
  statusIdx: index("upload_sessions_status_idx").on(table.status, table.expiresAt),
}));

export const messageAttachments = pgTable("message_attachments", {
  messageId: uuid("message_id")
    .references(() => messages.id, { onDelete: "cascade" }).notNull(),
  fileId: uuid("file_id")
    .references(() => files.id, { onDelete: "restrict" }).notNull(),
  position: integer("position").default(0).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.messageId, table.fileId] }),
  fileIdx: index("message_attachments_file_idx").on(table.fileId),
}));

// ═══════════════════════════════════════════════════════════
// message_reactions
// ═══════════════════════════════════════════════════════════
export const messageReactions = pgTable("message_reactions", {
  messageId: uuid("message_id")
    .references(() => messages.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  emoji: varchar("emoji", { length: 50 }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.messageId, table.userId, table.emoji] }),
  messageIdx: index("reactions_message_idx").on(table.messageId),
}));

// ═══════════════════════════════════════════════════════════
// bot_integrations
// ═══════════════════════════════════════════════════════════
export const botIntegrations = pgTable("bot_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  botUserId: uuid("bot_user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  webhookUrl: text("webhook_url"),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  permissions: jsonb("permissions").$type<{
    messagesRead?: boolean;
    messagesWrite?: boolean;
    channelsRead?: boolean;
    channelsManage?: boolean;
  }>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceBotIdx: uniqueIndex("bots_workspace_name_idx")
    .on(table.workspaceId, table.name),
  botUserIdx: index("bots_user_idx").on(table.botUserId),
}));

export const botChannelMemberships = pgTable("bot_channel_memberships", {
  botId: uuid("bot_id")
    .references(() => botIntegrations.id, { onDelete: "cascade" }).notNull(),
  channelId: uuid("channel_id")
    .references(() => channels.id, { onDelete: "cascade" }).notNull(),
  addedBy: uuid("added_by")
    .references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.botId, table.channelId] }),
  channelIdx: index("bot_channel_memberships_channel_idx").on(table.channelId),
}));

export const botEventSubscriptions = pgTable("bot_event_subscriptions", {
  botId: uuid("bot_id")
    .references(() => botIntegrations.id, { onDelete: "cascade" }).notNull(),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  scope: jsonb("scope").$type<{ channelId?: string; workspaceId?: string }>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.botId, table.eventType] }),
  eventIdx: index("bot_event_subscriptions_event_idx").on(table.eventType),
}));

// ═══════════════════════════════════════════════════════════
// signal_prekey_bundles
// ═══════════════════════════════════════════════════════════
export const signalPrekeyBundles = pgTable("signal_prekey_bundles", {
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  deviceId: integer("device_id").default(1).notNull(),
  identityKey: text("identity_key").notNull(),
  signedPreKey: text("signed_pre_key").notNull(),
  signedPreKeySig: text("signed_pre_key_sig").notNull(),
  signedPreKeyId: integer("signed_pre_key_id").notNull(),
  signedPreKeyExpiresAt: timestamp("signed_pre_key_expires_at",
    { withTimezone: true }).notNull(),
  oneTimePreKeyIds: jsonb("one_time_pre_key_ids").$type<number[]>().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.deviceId] }),
}));

// ═══════════════════════════════════════════════════════════
// signal_one_time_prekeys
// ═══════════════════════════════════════════════════════════
export const signalOneTimePrekeys = pgTable("signal_one_time_prekeys", {
  id: integer("id").notNull(),
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  deviceId: integer("device_id").default(1).notNull(),
  publicKey: text("public_key").notNull(),
  isUsed: boolean("is_used").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.deviceId, table.id] }),
  unusedIdx: index("otpk_unused_idx").on(table.userId, table.deviceId, table.isUsed),
}));

// ═══════════════════════════════════════════════════════════
// signal_sessions (server-side — stores only opaque session data)
// ═══════════════════════════════════════════════════════════
// Note: In Phase 1, sessions are stored client-side only.
// This table is reserved for Phase 2+ multi-device session relay.
export const signalSessions = pgTable("signal_sessions", {
  userId: uuid("user_id")
    .references(() => users.id, { onDelete: "cascade" }).notNull(),
  deviceId: integer("device_id").default(1).notNull(),
  peerUserId: uuid("peer_user_id").notNull(),
  peerDeviceId: integer("peer_device_id").default(1).notNull(),
  sessionData: text("session_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({
    columns: [table.userId, table.deviceId, table.peerUserId, table.peerDeviceId],
  }),
}));

// ═══════════════════════════════════════════════════════════
// audit_logs (append-only)
// ═══════════════════════════════════════════════════════════
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 100 }).notNull(),
  resourceType: varchar("resource_type", { length: 50 }).notNull(),
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata"),
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  result: varchar("result", { length: 20 }).notNull(),
  // "success" | "failure" | "denied"
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index("audit_user_idx").on(table.userId),
  actionIdx: index("audit_action_idx").on(table.action),
  resourceIdx: index("audit_resource_idx").on(table.resourceType, table.resourceId),
  createdIdx: index("audit_created_idx").on(table.createdAt),
}));
```

### 2.3 Complete Index Strategy

```sql
-- users
CREATE UNIQUE INDEX users_email_idx ON users(email);

-- workspaces
CREATE UNIQUE INDEX workspaces_slug_idx ON workspaces(slug);
CREATE INDEX workspaces_owner_idx ON workspaces(owner_id);

-- workspace_members
CREATE INDEX wm_user_ws_idx ON workspace_members(user_id, workspace_id);

-- channels
CREATE UNIQUE INDEX channels_workspace_name_idx ON channels(workspace_id, name);
CREATE INDEX channels_type_idx ON channels(type);
CREATE INDEX channels_status_idx ON channels(status, workspace_id);
CREATE INDEX channels_mode_idx ON channels(mode);

-- channel_members
CREATE INDEX cm_user_channels_idx ON channel_members(user_id, joined_at);

-- messages
-- UUID v7 primary key is already sorted; single-column DESC index for cursor pagination
CREATE INDEX msg_channel_cursor_idx ON messages(channel_id, id DESC);
CREATE UNIQUE INDEX msg_client_msg_idx ON messages(client_msg_id)
  WHERE client_msg_id IS NOT NULL;
CREATE INDEX msg_sender_idx ON messages(sender_id, created_at);
CREATE INDEX msg_thread_idx ON messages(thread_id, created_at);
CREATE INDEX msg_encryption_idx ON messages(encryption);

-- message_reactions
CREATE INDEX reactions_message_idx ON message_reactions(message_id);

-- bot_integrations
CREATE UNIQUE INDEX bots_workspace_name_idx ON bot_integrations(workspace_id, name);
CREATE UNIQUE INDEX bots_token_hash_idx ON bot_integrations(token_hash);
CREATE INDEX bots_user_idx ON bot_integrations(bot_user_id);

-- signal_one_time_prekeys
CREATE INDEX otpk_unused_idx ON signal_one_time_prekeys(user_id, device_id, is_used);

-- audit_logs
CREATE INDEX audit_user_idx ON audit_logs(user_id);
CREATE INDEX audit_action_idx ON audit_logs(action);
CREATE INDEX audit_resource_idx ON audit_logs(resource_type, resource_id);
CREATE INDEX audit_created_idx ON audit_logs(created_at);
```

### 2.4 JSONB Usage Rationale

| Column | Reason for JSONB |
|---|---|
| `channels.metadata` | Variable schema: DM participant lists, pinned message IDs, custom emoji — evolves without migrations |
| `channel_members.notification_settings` | Key-value preference store; each user may have different shape |
| `messages.content` | Polymorphic message types (text, image, file, system) with optional attachments and mentions — impossible to model cleanly with fixed columns |
| `messages.encryption_metadata` | Optional E2EE metadata (ratchet step, device ID); absent for non-E2EE messages |
| `bot_integrations.permissions` | Permission set varies per bot; JSONB allows adding new permissions without ALTER TABLE |
| `audit_logs.metadata` | Free-form contextual data per action type |

**JSONB query examples:**

```sql
-- Find messages containing image attachments
SELECT * FROM messages WHERE content @> '{"type": "image"}';

-- Find messages that mention a specific user
SELECT * FROM messages WHERE content -> 'mentions' @> '"<user-uuid>"';

-- Find E2EE messages with a specific session version
SELECT * FROM messages WHERE encryption = 'e2e'
  AND encryption_metadata @> '{"sessionVersion": 3}';
```

---

## 3. Message State Machine

### 3.1 State Transition Diagram

```
                         ┌──────────────────────────────────┐
                         │            FAILED                 │
                         │  (network error / server reject   │
                         │   / timeout with retries exhausted)│
                         └──────▲───────────▲──────────────┘
                                │           │
                         ┌──────┴───────────┴───────┐
                         │      retry (≤3 times)      │
                         │   exponential backoff      │
                         │    1s → 2s → 4s            │
                         └──────────┬────────────────┘
                                    │
    ┌───────┐   send    ┌──────────┴───────────┐  server ACK  ┌──────────┐
    │DRAFT  │──────────→│      SENDING          │─────────────→│   SENT   │
    └───┬───┘           └──────▲───────────────┘              └────┬─────┘
        │ edit                 │                                  │
        │                      │ resend (after reconnect)         │ recipient
        ↓                      │                                  │ delivers
   ┌────────┐              reconnect                          ┌──┴──────────┐
   │ EDITED │                                                  │  DELIVERED  │
   └────┬───┘                                                  └──────┬──────┘
        │                                                             │
        │ delete                                                       │ read
        ↓                                                             ↓
   ┌────────┐                                                   ┌──────────┐
   │ DELETED│                                                   │   READ   │
   └────────┘                                                   └──────────┘
```

### 3.2 State Definitions

```typescript
enum MessageStatus {
  DRAFT     = "draft",      // Client is composing; not yet submitted
  SENDING   = "sending",    // Submitted to send queue, waiting for server ACK
  SENT      = "sent",       // Server has persisted and assigned an ID
  DELIVERED = "delivered",  // Recipient client has received the message
  READ      = "read",       // Recipient has viewed the message
  FAILED    = "failed",     // Send failed after all retries exhausted
  EDITED    = "edited",     // Content modified; original timestamp preserved
  DELETED   = "deleted",    // Soft-deleted; content replaced with tombstone
}
```

### 3.3 State Transitions

| From | To | Trigger | Condition |
|---|---|---|---|
| DRAFT | SENDING | User submits message | Content is non-empty |
| SENDING | SENT | Server sends `message:ack` with server ID | `ack.status === "sent"` |
| SENDING | FAILED | ACK timeout with retries exhausted | 3 retries at 1s/2s/4s exponential backoff with ±30% jitter |
| FAILED | SENDING | User taps "Retry" or client reconnects | Message is in FAILED state |
| SENT | DELIVERED | Server relays recipient's delivery ACK | Recipient client emits `message:delivered` |
| DELIVERED | READ | Recipient scrolls to or opens message | Read receipt batch aggregation |
| DRAFT / SENT / DELIVERED / READ | EDITED | Sender edits content | Message not deleted; sender owns message |
| Any non-terminal | DELETED | Sender or channel admin deletes | `deleted_at` set; content becomes tombstone |

**Invariant**: Status only moves forward. `READ` never transitions to `DELIVERED`. `DELETED` is terminal. `FAILED` can transition back to `SENDING`.

### 3.4 ACK Mechanism and Optimistic Update

```
  Sender Client                   Server                   Recipient Client
       │                            │                            │
       │ ── message:send ──────────→│                            │
       │     { clientMsgId,         │                            │
       │       channelId, content } │                            │
       │                            │  1. Validate + persist     │
       │                            │  2. Assign server ID       │
       │                            │  3. Redis dedup key set    │
       │ ←── message:ack ──────────│                             │
       │     { clientMsgId,         │                            │
       │       messageId,           │                            │
       │       status: "sent",      │                            │
       │       timestamp }          │                            │
       │                            │ ── message:new ──────────→│
       │                            │     (full message object)  │
       │                            │                            │
       │                            │ ←── message:delivered ────│
       │ ←── message:delivered ────│                             │
       │                            │                            │
       │                            │ ←── message:read ─────────│
       │ ←── message:read ─────────│                             │
```

**Optimistic update flow:**
1. Client creates message locally with `clientMsgId`, status = `SENDING`, renders immediately in UI.
2. Client sends `message:send` to server.
3. Server validates, inserts into PostgreSQL, sets dedup key in Redis (`dedup:{clientMsgId}` → `messageId`, TTL 24h).
4. Server emits `message:ack` back to sender with assigned `messageId` and server `createdAt`.
5. Sender updates local message: replaces temporary `clientMsgId` with server `messageId`, status → `SENT`.
6. Server emits `message:new` to all channel members (excluding sender via `socket.to(room)`).

**Idempotency guarantee**: Server checks `redis.get("dedup:{clientMsgId}")` before insert. If found, returns existing `messageId` with `status: "duplicate"` — prevents double-posting on network retry.

### 3.5 Retry Strategy

```typescript
const RETRY_POLICY = {
  maxRetries: 3,
  baseDelayMs: 1000,      // 1s → 2s → 4s
  maxDelayMs: 10000,
  jitterFactor: 0.3,      // ±30% random jitter
};

function getRetryDelay(attempt: number): number {
  const exponentialDelay = RETRY_POLICY.baseDelayMs * Math.pow(2, attempt - 1);
  const cappedDelay = Math.min(exponentialDelay, RETRY_POLICY.maxDelayMs);
  const jitter = cappedDelay * RETRY_POLICY.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}
```

### 3.6 Edit and Delete

**Edit**: Sender updates `content`, sets `editedAt`, and status → `EDITED`. Server broadcasts `message:edited` to channel. Original `id` and `createdAt` are preserved.

**Delete** (soft): Sender or channel admin sets `deletedAt`, status → `DELETED`, and content to `{ type: "deleted" }`. Server broadcasts `message:deleted` with `messageId`. Soft-deleted messages are excluded from pagination queries via `WHERE deleted_at IS NULL`.

**Permissions**:
- Edit: sender only, within 24 hours of creation (configurable), message not deleted.
- Delete: sender or channel admin, at any time.

### 3.7 Read Receipt Aggregation

Read receipts are the highest-frequency write in IM. They are batched via Redis buffer:

```typescript
class ReadReceiptAggregator {
  private buffer: Map<string, { userId: string; channelId: string;
    lastReadAt: Date; messageId: string }> = new Map();

  async record(channelId: string, userId: string, messageId: string) {
    // Immediate Redis write (for cross-instance visibility)
    await redis.set(`read_cursor:${channelId}:${userId}`, messageId, { EX: 604800 });
    // Merge into buffer (dedup by channel+user key)
    this.buffer.set(`${channelId}:${userId}`, { userId, channelId,
      lastReadAt: new Date(), messageId });
  }

  // Flush every 3 seconds — batch upsert to DB
  private async flush() { /* batch upsert to channel_members.last_read_at */ }
}
```

---

## 4. Channel State Machine

### 4.1 Lifecycle State Diagram

```
                            ┌────────────┐
                            │  ARCHIVED  │
                            └─────▲──────┘
                                  │ archive (owner/admin)
       ┌────────┐ create  ┌──────┴──────┐ unarchive  ┌────────────┐
       │  NONE  │────────→│   ACTIVE    │←───────────│  ARCHIVED  │
       └────────┘         └──────┬──────┘            └────┬───────┘
                                 │                        │
                                 │ delete (soft)          │ permanent delete
                                 ↓                        │ (auto after 30 days)
                            ┌──────────┐                  ↓
                            │ DELETED  │            ┌───────────┐
                            └──────────┘            │  PURGED   │
                                                    └───────────┘
```

### 4.2 Channel Type Matrix

| Feature | Public | Private | DM |
|---|---|---|---|
| Visibility | All workspace members | Members only | Both parties only |
| Join method | Free join | Invite-only | Auto-created by system |
| Search scope | Workspace-wide | Members only | Both parties only |
| Message history | Viewable by all | Members only | Both parties only |
| Member limit | Unlimited | Unlimited | Exactly 2 |
| Create permission | All members | All members | System auto |
| E2EE support | No (contradicts "public") | Yes (mode=e2e) | Yes (mode=e2e) |

### 4.3 DM Creation Flow

```
Client A                  Server                         Client B
   │                         │                               │
   │ ── POST /channels ────→│                               │
   │   { type: "dm",        │                               │
   │     participantIds:    │                               │
   │     [A, B] }           │                               │
   │                         │  1. Check: DM exists?         │
   │                         │     SELECT * FROM channels    │
   │                         │     WHERE type='dm'           │
   │                         │     AND metadata->            │
   │                         │     'dmParticipants'          │
   │                         │     @> '["A","B"]'            │
   │                         │                               │
   │                         │  2. If exists → return id     │
   │                         │  3. If not → create new       │
   │                         │     INSERT channel +          │
   │                         │     INSERT 2 members          │
   │ ←── 200 { id, ... } ───│                               │
   │                         │                               │
   │                         │ ── channel:created ──────────→│
   │                         │   (via user:B room)           │
```

DM channels are identified by their ordered list of participants stored in `metadata.dmParticipants`. The query to find an existing DM:

```sql
SELECT * FROM channels
WHERE type = 'dm'
  AND workspace_id = $1
  AND metadata -> 'dmParticipants' @> '["<userA>","<userB>"]'::jsonb;
```

### 4.4 Member Join/Leave Events

- **Join**: `POST /channels/:id/members` → insert `channel_members` → invalidate Redis `channel:{id}:members` → publish `channel:member_change` on Redis Pub/Sub → emit `member:joined` to channel room.
- **Leave**: `DELETE /channels/:id/members/@me` → delete row → invalidate caches → emit `member:left`.
- **Kick**: Admin/owner removes another member — same mechanics, with role-based authorization check.

### 4.5 E2EE Channel Key Rotation on Member Change

When a channel's `mode = "e2e"` and a member joins or leaves:

1. **Member joins**: All existing members rotate their Sender Keys. New member cannot decrypt messages sent before joining (Pending Join). Server distributes encrypted new Sender Keys to all members.
2. **Member leaves**: All surviving members rotate their Sender Keys. Departed member cannot decrypt new messages. Historical messages remain decryptable by the departed member (this is by design — forward secrecy does not retroactively revoke access to past ciphertext).

The server's role is limited to:
- Storing encrypted Sender Key distribution blobs in `group_sender_keys` table (Phase 2).
- Broadcasting `channel:key_rotation` events to trigger client-side rotation.
- The server never possesses any private key material.

---

## 5. Signal Protocol Key Server

### 5.1 Design Principle: Zero-Knowledge Server

The server stores only **public keys** and forwards only **ciphertext**. It never generates, possesses, or needs to know any private key. All cryptographic operations occur on the client.

### 5.2 PreKeyBundle Upload

```
POST /api/signal/prekeys/bundle

Body:
{
  "deviceId": 1,
  "identityKey": "<base64-encoded Curve25519 public key>",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "<base64>",
    "signature": "<base64 — identity key's ED25519 signature over prekey>"
  },
  "oneTimePreKeys": [
    { "keyId": 1, "publicKey": "<base64>" },
    { "keyId": 2, "publicKey": "<base64>" },
    ...  // up to 100
  ]
}

Server processing:
  1. UPSERT identity_key (by user_id + device_id)
  2. UPSERT signed_pre_key (by user_id + device_id)
  3. INSERT one_time_prekeys (by user_id + device_id + key_id)
     ON CONFLICT DO NOTHING (idempotent upload)
```

### 5.3 PreKeyBundle Fetch

```
GET /api/signal/prekeys/:userId?deviceId=1

Server processing (within a transaction):
  1. SELECT identity_key WHERE user_id = :userId
  2. SELECT signed_pre_key WHERE user_id = :userId AND device_id = :deviceId
       AND is_active = true AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1
  3. SELECT one_time_prekey WHERE user_id = :userId AND device_id = :deviceId
       AND is_used = false LIMIT 1
       FOR UPDATE SKIP LOCKED  -- concurrency-safe consumption
  4. UPDATE one_time_prekey SET is_used = true WHERE id = :selectedId

Response:
{
  "identityKey": "<base64>",
  "signedPreKey": { "keyId": 1, "publicKey": "<base64>", "signature": "<base64>" },
  "oneTimePreKey": { "keyId": 5, "publicKey": "<base64>" } | null
}
```

**Atomic consumption guarantee**: The `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE` within a PostgreSQL transaction ensures two concurrent fetchers never receive the same one-time prekey. If no unused OPK exists, `oneTimePreKey` returns `null` — X3DH falls back to 3 DH computations (slightly weaker but still secure).

### 5.4 PreKey Exhaustion Detection

```typescript
// After consuming a prekey, check remaining count
const remaining = await db
  .select({ count: sql<number>`count(*)` })
  .from(signalOneTimePrekeys)
  .where(and(
    eq(signalOneTimePrekeys.userId, userId),
    eq(signalOneTimePrekeys.deviceId, deviceId),
    eq(signalOneTimePrekeys.isUsed, false),
  ));

if (remaining[0].count < 20) {
  // Push notification to client: "Replenish your one-time prekeys"
  io.to(`user:${userId}`).emit("signal:prekeys_low", {
    remaining: remaining[0].count,
    replenishThreshold: 20,
  });
}
```

### 5.5 Key Expiration Policy

| Key Type | Validity | Refresh Strategy | Server Cleanup |
|---|---|---|---|
| Identity Key | Permanent | Never refreshed (re-register if compromised) | Not overwritten |
| Signed PreKey | 30 days | Client auto-refreshes 7 days before expiry | Old SPK deactivated 7 days after expiry (cron job) |
| One-Time PreKey | Single use | Client replenishes to 100 when remaining < 20 | Used OPKs deleted after 7 days (cron job) |

```typescript
// Daily cron job
cron.schedule('0 3 * * *', async () => {
  // Deactivate expired Signed PreKeys
  await db
    .update(signalPrekeyBundles)
    .set({ /* flag inactive */ })
    .where(lt(signalPrekeyBundles.signedPreKeyExpiresAt,
      new Date(Date.now() - 7 * 86400_000)));

  // Delete used One-Time PreKeys older than 7 days
  await db
    .delete(signalOneTimePrekeys)
    .where(and(
      eq(signalOneTimePrekeys.isUsed, true),
      lt(signalOneTimePrekeys.createdAt,
        new Date(Date.now() - 7 * 86400_000)),
    ));
});
```

### 5.6 Multi-Device Considerations (Phase 2)

Each device is an independent cryptographic endpoint with its own identity key pair, signed prekey, and one-time prekeys. The `deviceId` discriminates entries in all signal tables.

```
Alice has 3 devices: A1, A2, A3
Bob has 2 devices: B1, B2

Encryption: A1 encrypts separately for B1 and B2 → 2 ciphertexts
Server tables contain 3 + 2 = 5 prekey bundles

Group with 10 members × 2 devices = 20 Sender Keys active
```

Phase 1 ships with `deviceId = 1` hardcoded. Phase 2 adds multi-device registration and per-device PreKey management.

---

## 6. Redis Caching Architecture

### 6.1 Cache Layer Diagram

```
┌───────────────────────────────────────────────────────┐
│                    Redis Cache Layers                  │
├───────────────────────────────────────────────────────┤
│  Layer 1: Session & Auth                               │
│  ├── session:{jti}          → JWT metadata (TTL=15m)  │
│  ├── used_token:{jti}       → consumed refresh token   │
│  └── revoked_family:{fid}   → revoked token family     │
│                                                         │
│  Layer 2: Online Presence                               │
│  ├── presence:{userId}      → Hash {status, lastSeen}  │
│  ├── online_users:{wsId}    → Set<userId>              │
│  └── typing:{ch}:{userId}   → TTL 5s typing indicator  │
│                                                         │
│  Layer 3: Channel State                                 │
│  ├── channel:{id}:members   → Set<userId>              │
│  ├── channel:{id}:info      → Hash (name, type, etc.)  │
│  └── user:{id}:channels     → Set<channelId>           │
│                                                         │
│  Layer 4: Message Hot Cache                             │
│  ├── messages:{channelId}   → Sorted Set (last 50)     │
│  │    score = id (UUID v7 time-ordered)                │
│  └── thread:{msgId}         → Sorted Set (last 100)    │
│                                                         │
│  Layer 5: Rate Limiting                                 │
│  ├── ratelimit:{ip}:global  → sliding window counter   │
│  ├── ratelimit:{ip}:auth   → sliding window counter    │
│  └── ws_ratelimit:{uid}:msg → sorted set w/ TTL        │
│                                                         │
│  Layer 6: Pub/Sub Channels                              │
│  ├── message:new             (cross-instance fan-out)   │
│  ├── presence:update         (status propagation)       │
│  └── channel:member_change   (cache invalidation)       │
└───────────────────────────────────────────────────────┘
```

### 6.2 Layer Details

#### Layer 1: Session & Auth

```typescript
// JWT blacklist entry (on logout / token rotation)
await redis.set(`used_token:${jti}`, "1", { EX: ttlSeconds });

// Refresh token family revocation (on replay detection)
await redis.set(`revoked_family:${familyId}`, "1", { EX: 7 * 86400 });
```

#### Layer 2: Online Presence

```typescript
// User online
await redis.hSet(`presence:${userId}`, {
  status: "online",
  lastSeen: Date.now().toString(),
});
await redis.sAdd(`online_users:${workspaceId}`, userId);

// User offline — no TTL; explicit on disconnect
await redis.hSet(`presence:${userId}`, { status: "offline", lastSeen: Date.now().toString() });
await redis.sRem(`online_users:${workspaceId}`, userId);

// Typing indicator — TTL-based auto-expiry
await redis.set(`typing:${channelId}:${userId}`, "1", { EX: 5 });
```

#### Layer 3: Channel State

```typescript
// Lazy-loaded channel members with 5-min TTL
async function getChannelMembers(channelId: string): Promise<string[]> {
  const key = `channel:${channelId}:members`;
  const cached = await redis.sMembers(key);
  if (cached.length > 0) return cached;
  // Cache miss — load from DB
  const members = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));
  const ids = members.map((m) => m.userId);
  if (ids.length > 0) {
    await redis.sAdd(key, ids);
    await redis.expire(key, 300);
  }
  return ids;
}

// Proactive invalidation on member change
async function onMemberChange(channelId: string, userId: string) {
  await redis.del(`channel:${channelId}:members`);
  await redis.del(`user:${userId}:channels`);
}
```

#### Layer 4: Message Hot Cache

```typescript
// Cache on new message — keep last 50 per channel
async function cacheMessage(channelId: string, message: Message) {
  const key = `messages:${channelId}`;
  await redis.zAdd(key, {
    score: parseUUIDv7Timestamp(message.id),  // extract time from UUID v7
    value: JSON.stringify(message),
  });
  await redis.zRemRangeByRank(key, 0, -51);  // retain last 50
  await redis.expire(key, 3600);              // TTL 1 hour
}

// First-hit fast path
async function getRecentMessages(channelId: string, limit = 50) {
  const key = `messages:${channelId}`;
  const rows = await redis.zRange(key, -limit, -1, { rev: true });
  if (rows.length > 0) return rows.map((r) => JSON.parse(r));
  // Cold path — fall back to DB
  return db.select().from(messages)
    .where(eq(messages.channelId, channelId))
    .orderBy(desc(messages.id)).limit(limit);
}
```

#### Layer 5: Rate Limiting

```typescript
// Sliding window counter (Redis-backed, distributed)
async function checkRateLimit(
  key: string, maxRequests: number, windowSec: number
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowSec;
  await redis.zRemRangeByScore(key, 0, windowStart); // prune old entries
  const count = await redis.zCard(key);               // current window count
  if (count >= maxRequests) return false;
  await redis.zAdd(key, { score: now, value: `${now}:${Math.random()}` });
  await redis.expire(key, windowSec + 1);
  return true;
}
```

#### Layer 6: Redis Pub/Sub

| Channel | Publisher | Subscribers | Purpose |
|---|---|---|---|
| `message:new` | Any WS server instance | All WS server instances + Bot webhook workers | Cross-instance message fan-out |
| `presence:update` | WS disconnect handler | All WS instances | Propagate online/offline to other pods |
| `channel:member_change` | Channel service | All WS instances | Invalidate channel member caches across instances |

### 6.3 Cache Invalidation Strategy Summary

| Data | Strategy | TTL | Invalidation Trigger |
|---|---|---|---|
| Session/Token | Proactive | 7d (refresh) / 15m (access) | Logout, password change, token replay |
| Online presence | Explicit set/remove | None | WebSocket connect/disconnect |
| Channel member list | TTL + Proactive | 5 min | Member join/leave/kick |
| Channel info | TTL + Proactive | 10 min | Channel rename, archive, delete |
| Recent messages | LRU capacity + TTL | 1 hour | New message pushes oldest out |
| Message dedup | TTL | 24 hours | Natural expiry |
| Rate limit counters | Fixed window TTL | Window size | Natural expiry |

### 6.4 Cursor Pagination (UUID v7)

```typescript
// UUID v7 is time-ordered — single column cursor
async function getChannelMessages(
  channelId: string,
  cursor?: string,   // message id (UUID v7)
  limit = 50,
) {
  return db
    .select()
    .from(messages)
    .where(and(
      eq(messages.channelId, channelId),
      cursor ? lt(messages.id, cursor) : undefined,
      sql`${messages.deletedAt} IS NULL`,
    ))
    .orderBy(desc(messages.id))
    .limit(limit);
}

interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

UUID v7 eliminates the need for a `(created_at, id)` compound cursor, simplifying both the query and the client-side pagination logic.

---

## 7. Bot Integration Module

### 7.1 Bot Registration Flow

```
POST /api/bots

Headers: Authorization: Bearer <user-JWT>
Body:
{
  "workspaceId": "<uuid>",
  "name": "My CI Bot",
  "permissions": {
    "messagesRead": true,
    "messagesWrite": true,
    "channelsRead": true,
    "channelsManage": false
  },
  "webhookUrl": "https://my-ci.example.com/nexus-chat"  // optional
}

Server processing:
  1. Verify caller is workspace admin/owner
  2. Create bot user record (type = "bot") in users table
  3. Generate bot token: nxbot_v1_<base64url(32-byte-random)>
  4. Store SHA-256(token) in bot_integrations.token_hash
  5. Add bot user to workspace as member
  6. Return token (displayed only once)
```

### 7.2 Bot Token Format

```
Format: nxbot_v1_<base64url-encoded 32-byte random>
Example: nxbot_v1_k3F7xQpLmN9vR2tW8yA4bD6eF0hJ1lC3oM5nP7rS9uB

Verification:
  1. Parse prefix "nxbot_v1_"
  2. SHA-256(client-supplied-token) == stored token_hash
```

```typescript
export function generateBotToken(): { raw: string; hash: string } {
  const raw = `nxbot_v1_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}
```

### 7.3 Permission Scopes

| Permission | Scope | Description |
|---|---|---|
| `messages:read` | Channel-scoped | Read messages in channels the bot has been added to |
| `messages:write` | Channel-scoped | Post messages and reactions |
| `channels:read` | Workspace-scoped | List channels and their metadata |
| `channels:manage` | Workspace-scoped | Create/archive channels, manage members (excluding admin actions) |

### 7.4 Bot Authentication Middleware

```typescript
// Bots authenticate via HTTP header: Authorization: Bearer nxbot_v1_...
// Middleware detects token prefix and routes to bot verification path.

async function authenticateBot(token: string): Promise<BotContext> {
  if (!token.startsWith("nxbot_v1_")) throw new UnauthorizedError();
  const hash = createHash("sha256").update(token).digest("hex");
  const bot = await db.query.botIntegrations.findFirst({
    where: eq(botIntegrations.tokenHash, hash),
  });
  if (!bot) throw new UnauthorizedError();
  return { botId: bot.id, workspaceId: bot.workspaceId,
    botUserId: bot.botUserId, permissions: bot.permissions };
}
```

### 7.5 Channel Membership for Bots

Bots are added to channels like regular members, but with restrictions:
- A bot cannot be a workspace owner or admin.
- A bot cannot kick other members or change channel settings.
- A bot's `message:write` permission is checked per channel (bot must be a channel member).
- Bots cannot initiate DMs (but can respond in DMs they've been added to).

---

## 8. Security Implementation

### 8.1 Password Hashing — Argon2id

```typescript
import * as argon2 from "argon2";

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,    // 64 MiB
  timeCost: 3,          // 3 iterations
  parallelism: 4,       // 4 threads
  hashLength: 32,       // 256-bit output
  saltLength: 16,       // 128-bit salt
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
```

**Optional pepper** (additional defense layer, stored outside DB):

```typescript
function applyPepper(password: string): string {
  return createHmac("sha256", process.env.PASSWORD_PEPPER!).update(password).digest("hex");
}
// Full flow: argon2id(HMAC-SHA256(password, pepper))
```

### 8.2 JWT Signing — RS256 Asymmetric Keys

```typescript
import * as jose from "jose";

// Sign Access Token (15-minute TTL)
export async function signAccessToken(sub: string, username: string) {
  return new jose.SignJWT({ sub, username, type: "access" })
    .setProtectedHeader({ alg: "RS256", kid: "v1" })
    .setIssuedAt()
    .setIssuer("nexus-chat")
    .setAudience("nexus-chat-api")
    .setExpirationTime("15m")
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

// Sign Refresh Token (7-day TTL, with family tracking)
export async function signRefreshToken(sub: string, familyId: string) {
  return new jose.SignJWT({ sub, type: "refresh", familyId })
    .setProtectedHeader({ alg: "RS256", kid: "v1" })
    .setIssuedAt()
    .setIssuer("nexus-chat")
    .setAudience("nexus-chat-api")
    .setExpirationTime("7d")
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}
```

**Refresh token rotation with replay detection:** On each refresh, mark the old token as used (`used_token:{jti}`) in Redis. If a used token is presented again, revoke the entire token family (`revoked_family:{familyId}`) — this indicates token theft.

**Key rotation:** Use JWT `kid` (Key ID) header. During rotation, the old public key is retained for 7 days to validate existing tokens while new tokens are signed with the new key.

### 8.3 Audit Logging

```typescript
export async function auditLog(params: {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  result: "success" | "failure" | "denied";
  error?: string;
}) {
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    ...params,
    createdAt: new Date(),
  });
}
```

**Critical operations that MUST be audited:**
- `user.login` / `user.logout` / `user.password_change`
- `workspace.create` / `workspace.delete` / `workspace.transfer_ownership`
- `channel.create` / `channel.delete` / `channel.member_add` / `channel.member_remove`
- `message.delete` (by admin)
- `bot.create` / `bot.token_regenerate` / `bot.delete`
- `signal.prekey_upload` / `signal.prekey_fetch`

Audit logs are append-only. No UPDATE or DELETE is permitted. Retention: 90 days hot storage, then archive to cold storage.

### 8.4 Database Encryption at Rest

- **PostgreSQL TDE**: Enable Transparent Data Encryption at the PostgreSQL level (available in PostgreSQL 15+ with `pg_tde` extension, or via filesystem-level encryption like LUKS).
- **Connection encryption**: All PostgreSQL connections use TLS with `rejectUnauthorized: true` in production.
- **Sensitive field encryption**: Bot tokens stored as SHA-256 hash (one-way). TOTP secrets and OAuth refresh tokens (future) encrypted with AES-256-GCM using a key injected via environment variable.

```typescript
const client = postgres({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432"),
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: true }
    : false,
  max: 20,
});
```

### 8.5 Multi-Layered Defense Summary

| Layer | Measure | Mechanism |
|---|---|---|
| Transport | TLS 1.3 | All HTTP and WebSocket connections |
| Authentication | RS256 JWT + Argon2id | Access token 15min, refresh token 7d with rotation |
| Authorization | Role-based (owner/admin/member) + Bot scopes | Middleware checks per endpoint |
| Input validation | Zod schemas | All API boundaries (REST + WebSocket events) |
| SQL injection | Drizzle ORM parameterized queries | Zero raw SQL string concatenation |
| XSS | React auto-escaping + DOMPurify + CSP | Defense in depth from render to browser policy |
| CSRF | JWT Bearer auth (no cookies) | Browser does not auto-attach `Authorization` header |
| Rate limiting | Sliding window (Redis) | Multi-tier: global 100/15min, auth 5/15min, message 10/1min |
| Secrets | env vars + Zod validation on startup | No hardcoded keys; `.env` in `.gitignore` |
| Logging | Pino with field redaction | Passwords, tokens, secrets auto-censored |
| Audit trail | Append-only audit_logs table | Who did what to what resource, when, and with what result |

---

## Appendix A: Dependency Summary

| Package | Version | Purpose |
|---|---|---|
| `hono` | ^4.12 | HTTP framework |
| `@hono/zod-validator` | ^0.4 | Request validation |
| `zod` | ^3.23 | Schema validation |
| `drizzle-orm` | ^0.40 | ORM |
| `drizzle-kit` | ^0.30 | Migration tooling |
| `postgres` | ^3.4 | PostgreSQL driver |
| `socket.io` | ^4.8 | WebSocket framework |
| `@socket.io/redis-adapter` | ^8.3 | Socket.IO horizontal scaling |
| `redis` (ioredis) | ^4.7 | Redis client |
| `argon2` | ^0.41 | Password hashing |
| `jose` | ^5.9 | JWT signing/verification |
| `hono-rate-limiter` | ^0.4 | API rate limiting |
| `pino` | ^9.5 | Structured logging |
| `uuid` | ^10 | UUID v7 generation |
| `node-cron` | ^3 | Scheduled key cleanup jobs |
| `helmet` | ^8.1 | HTTP security headers |

---

> This design document synthesizes the research findings from [backend-im-state-machine.md](../research/backend-im-state-machine.md) and [security-defense-e2ee-roadmap.md](../research/security-defense-e2ee-roadmap.md) into an implementable architecture. All decisions are grounded in mid-2026 library versions and community best practices.
