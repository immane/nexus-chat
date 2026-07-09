/**
 * Shared Contracts — Canonical Zod Schemas
 *
 * Single source of truth for all API shapes, event types, and domain models
 * shared between server and client. 40+ Zod schemas enforcing runtime type
 * safety at every I/O boundary.
 *
 * Schema Categories (organized as sub-module re-exports in src/):
 * - API envelope (apiOk, apiFail, pagination)
 * - Auth (user, registration, login, JWT session, refresh)
 * - Workspace and Channel (CRUD, membership, RBAC roles, DM)
 * - Message (content, state machine, send/edit/react/forward)
 * - Attachment (file records, upload sessions, scan status)
 * - Bot (manifest, commands, events, scopes, tokens)
 * - Signal / E2EE (pre-key bundles, disappearing policy, P2P signaling)
 * - WebSocket (client envelope, server events, P2P signaling wrappers)
 *
 * Design Decisions:
 * - All IDs are cuid2 strings (min 8, max 128 chars) - not auto-increment integers
 * - Message content uses discriminated union (text | ciphertext | tombstone)
 * - E2EE content includes readOnce and expiresAt fields inline
 * - P2P signaling schemas live here (not packages/signal) because they are
 *   part of the WS protocol contract between client and server
 * - e2eDisappearingPolicySchema uses superRefine for cross-field validation
 *   (ttl requires ttlSeconds or expiresAt; non-ttl must not have them)
 *
 * Does NOT:
 * - Implement business logic or validation beyond schema parsing
 * - Import from any other monorepo package (zero-dependency layer)
 *
 * Invariants:
 * - Every schema name ending in Schema is a Zod type
 * - Every type is exported alongside its schema via z.infer
 * - Changing a schema here breaks both server and client at compile time
 */
import { z } from "zod";

export const idSchema = z.string().min(8).max(128);
export const emailSchema = z.string().email().max(320);
export const isoDateSchema = z.string().datetime();

export const errorCodeSchema = z.enum([
  "AUTH_INVALID_CREDENTIALS",
  "AUTH_REQUIRED",
  "AUTH_REFRESH_REPLAY",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION_FAILED",
  "CONFLICT",
  "E2E_BOT_NOT_ALLOWED",
  "INTERNAL_ERROR"
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.unknown().optional()
});

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

export const apiMetaSchema = z.object({
  requestId: z.string().optional(),
  nextCursor: z.string().optional()
});

export const apiSuccessSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ ok: z.literal(true), data, meta: apiMetaSchema.optional() });

export const apiFailureSchema = z.object({
  ok: z.literal(false),
  error: apiErrorSchema,
  meta: apiMetaSchema.optional()
});

export const ApiSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
  requestId: z.string().min(1)
});

export const ApiErrorSchema = z.object({
  ok: z.literal(false),
  error: apiErrorSchema,
  requestId: z.string().min(1)
});

export const userSchema = z.object({
  id: idSchema,
  email: emailSchema,
  displayName: z.string().min(1).max(100),
  createdAt: isoDateSchema
});

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(100)
});

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256)
});

export const authTokensSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: z.string().min(20),
  expiresInSeconds: z.number().int().positive()
});

export const authSessionSchema = z.object({
  user: userSchema,
  tokens: authTokensSchema
});

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(20) });

export const workspaceRoleSchema = z.enum(["owner", "admin", "member"]);
export const channelModeSchema = z.enum(["normal", "e2e"]);
export const channelKindSchema = z.enum(["channel", "dm"]);

export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  createdAt: isoDateSchema
});

export const createWorkspaceSchema = z.object({ name: z.string().min(1).max(120) });
export const updateWorkspaceSchema = z.object({ name: z.string().min(1).max(120) });
export const transferWorkspaceOwnershipSchema = z.object({ newOwnerUserId: idSchema });

export const workspaceMemberSchema = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  role: workspaceRoleSchema
});

export const addWorkspaceMemberSchema = z.object({
  userId: idSchema,
  role: workspaceRoleSchema.default("member")
});

export const channelSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  kind: channelKindSchema,
  mode: channelModeSchema,
  isPrivate: z.boolean(),
  createdById: idSchema.optional(),
  archivedAt: isoDateSchema.optional(),
  deletedAt: isoDateSchema.optional(),
  createdAt: isoDateSchema
});

export const createChannelSchema = z.object({
  name: z.string().min(1).max(120),
  mode: channelModeSchema.default("normal"),
  isPrivate: z.boolean().default(false)
});

export const createDmSchema = z.object({
  peerUserId: idSchema,
  mode: channelModeSchema.default("normal")
});

export const addChannelMemberSchema = z.object({ userId: idSchema });

/**
 * Attachment reference used within message content.
 *
 * .strict() is applied — the server rejects unknown fields like `url` to
 * prevent clients from smuggling unauthorized data through the attachment
 * payload. All URLs are generated server-side via download sessions.
 */
export const attachmentRefSchema = z.object({
  fileId: idSchema,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  scanStatus: z.enum(["pending", "clean", "blocked", "skipped"]),
  thumbnailFileId: idSchema.optional()
}).strict();

export const AttachmentRefSchema = attachmentRefSchema;

export const e2eDisappearingPolicySchema = z
  .object({
    mode: z.enum(["none", "read_once", "ttl"]),
    ttlSeconds: z.number().int().min(30).max(604800).optional(),
    expiresAt: isoDateSchema.optional()
  })
  .superRefine((value, ctx) => {
    if (value.mode === "ttl" && value.ttlSeconds === undefined && value.expiresAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ttl policy requires ttlSeconds or expiresAt", path: ["ttlSeconds"] });
    }
    if (value.mode !== "ttl" && (value.ttlSeconds !== undefined || value.expiresAt !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ttl metadata is only valid for ttl mode", path: ["mode"] });
    }
  });

export const E2eDisappearingPolicySchema = e2eDisappearingPolicySchema;

// Message content is a discriminated union on the "type" field — Zod narrows
// to normalMessageContentSchema, e2eMessageContentSchema, or tombstoneContentSchema
// based on the literal value. This avoids a shared optional-fields nightmare
// where every field must be checked for undefined.
export const normalMessageContentSchema = z.object({
  type: z.literal("text"),
  text: z.string().min(1).max(8000),
  attachments: z.array(attachmentRefSchema).default([])
});

export const e2eMessageContentSchema = z.object({
  type: z.literal("ciphertext"),
  ciphertext: z.string().min(1),
  algorithm: z.enum(["signal-v1", "aes-256-gcm-v1"]),
  senderDeviceId: idSchema,
  readOnce: z.boolean().default(false),
  expiresAt: isoDateSchema.optional(),
  attachments: z.array(attachmentRefSchema).default([])
});

export const tombstoneMessageContentSchema = z.object({
  type: z.literal("tombstone"),
  reason: z.enum(["deleted", "expired", "read_once_consumed"])
});

export const messageContentSchema = z.discriminatedUnion("type", [
  normalMessageContentSchema,
  e2eMessageContentSchema,
  tombstoneMessageContentSchema
]);

export const messageStateSchema = z.enum(["sent", "delivered", "read", "deleted"]);

export const messageSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  channelId: idSchema,
  senderId: idSchema,
  clientMsgId: z.string().min(1).max(128),
  content: messageContentSchema,
  state: messageStateSchema,
  replyToMessageId: idSchema.optional(),
  originalMessageId: idSchema.optional(),
  originalSenderId: idSchema.optional(),
  originalCreatedAt: isoDateSchema.optional(),
  createdAt: isoDateSchema,
  editedAt: isoDateSchema.optional(),
  deletedAt: isoDateSchema.optional()
});

export const sendMessageSchema = z.object({
  workspaceId: idSchema,
  channelId: idSchema,
  clientMsgId: z.string().min(1).max(128),
  content: messageContentSchema,
  replyToMessageId: idSchema.optional()
});

export const editMessageSchema = z.object({ text: z.string().min(1).max(8000) });
export const reactMessageSchema = z.object({ emoji: z.string().min(1).max(32) });
export const forwardMessageSchema = z.object({ targetChannelId: idSchema, clientMsgId: z.string().min(1).max(128) });

export const messageAckPayloadSchema = z.object({ messageId: idSchema });
export const typingPayloadSchema = z.object({ workspaceId: idSchema, channelId: idSchema });
export const presenceUpdatePayloadSchema = z.object({ status: z.enum(["online", "away", "offline"]) });

export const wsClientEventSchema = z.enum([
  "message.send",
  "message.ack",
  "typing.start",
  "typing.stop",
  "presence.update",
  "bot.command.invoke"
]);

export const wsServerEventSchema = z.enum([
  "message.created",
  "message.updated",
  "message.deleted",
  "message.reaction",
  "message.read",
  "presence.updated",
  "typing.updated",
  "channel.created",
  "channel.pin_changed",
  "dm.created",
  "bot.response",
  "error",
  "p2p.offer",
  "p2p.answer",
  "p2p.ice-candidate",
  "p2p.hangup",
  "p2p.status"
]);

export const wsEnvelopeSchema = z.object({
  type: z.union([wsClientEventSchema, wsServerEventSchema]),
  seq: z.number().int().nonnegative().optional(),
  ack: z.string().optional(),
  workspaceId: idSchema.optional(),
  channelId: idSchema.optional(),
  payload: z.unknown(),
  timestamp: isoDateSchema,
  encrypted: z.boolean().default(false)
});

export const botScopeSchema = z.enum([
  "messages:read",
  "messages:write",
  "channels:read",
  "commands:handle",
  "attachments:read"
]);

export const botManifestSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  commands: z.array(
    z.object({
      name: z.string().regex(/^\/[a-z0-9_-]+$/),
      description: z.string().max(300)
    })
  ),
  scopes: z.array(botScopeSchema)
});

export const botCommandInvokeSchema = z.object({
  command: z.string().regex(/^\/[a-z0-9_-]+$/),
  args: z.string().max(2000).default(""),
  workspaceId: idSchema,
  channelId: idSchema,
  userId: idSchema
});

export const BotCommandInvokeSchema = z.object({
  type: z.literal("bot.command.invoke"),
  workspaceId: idSchema,
  channelId: idSchema,
  botName: z.string().min(1).max(50),
  command: z.string().min(0).max(50),
  args: z.array(z.string()).max(100),
  triggerId: z.string().optional()
});

export const botEventSchema = z.object({
  id: idSchema,
  type: z.enum(["message.created", "bot.command.invoke", "workspace.member_added"]),
  workspaceId: idSchema,
  channelId: idSchema.optional(),
  payload: z.unknown(),
  createdAt: isoDateSchema
});

export const uploadSessionCreateSchema = z.object({
  workspaceId: idSchema,
  channelId: idSchema.optional(),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  encrypted: z.boolean().default(false)
});

export const fileSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  channelId: idSchema.optional(),
  ownerId: idSchema,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  objectKey: z.string().min(1),
  encrypted: z.boolean(),
  scanStatus: z.enum(["pending", "clean", "blocked", "skipped"]),
  createdAt: isoDateSchema
});

export const signalPreKeyBundleSchema = z.object({
  userId: idSchema,
  deviceId: idSchema,
  identityKey: z.string().min(1),
  signedPreKeyId: z.number().int().nonnegative(),
  signedPreKey: z.string().min(1),
  signedPreKeySignature: z.string().min(1),
  oneTimePreKeys: z.array(z.object({ keyId: z.number().int().nonnegative(), publicKey: z.string().min(1) })).optional(),
  oneTimePreKeyId: z.number().int().nonnegative().optional(),
  oneTimePreKey: z.string().min(1).optional()
});

// Ws*Envelope schemas extend wsEnvelopeSchema with typed payloads.
// The base envelope carries { type, payload } as unknown — these narrow
// the payload to a specific schema via .extend(). This pattern enables
// the WS gateway to parse a generic envelope first, then dispatch to
// the correct handler with a fully typed payload.
export const WsMessageSendEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("message.send"),
  payload: sendMessageSchema
});

export const WsBotCommandInvokeEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("bot.command.invoke"),
  payload: BotCommandInvokeSchema
});

export const WsTypingEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.union([z.literal("typing.start"), z.literal("typing.stop")]),
  payload: typingPayloadSchema
});

export const WsPresenceUpdateEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("presence.update"),
  payload: presenceUpdatePayloadSchema
});

export const WsMessageAckEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("message.ack"),
  payload: messageAckPayloadSchema
});

// ── P2P Signaling Schemas ──

export const p2pTargetSchema = z.object({
  targetUserId: idSchema,
  targetDeviceId: idSchema.optional()
});

export const p2pOfferSchema = p2pTargetSchema.extend({
  sdp: z.string().min(1)
});

export const p2pAnswerSchema = p2pTargetSchema.extend({
  sdp: z.string().min(1)
});

export const p2pIceCandidateSchema = p2pTargetSchema.extend({
  candidate: z.object({
    candidate: z.string().min(1),
    sdpMid: z.string().nullable(),
    sdpMLineIndex: z.number().int().nonnegative().nullable()
  })
});

export const p2pHangupSchema = p2pTargetSchema;

export const p2pStatusSchema = p2pTargetSchema.extend({
  status: z.enum(["connected", "disconnected", "failed"]),
  reason: z.string().optional()
});

export const WsP2pOfferEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.offer"),
  payload: p2pOfferSchema
});

export const WsP2pAnswerEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.answer"),
  payload: p2pAnswerSchema
});

export const WsP2pIceCandidateEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.ice-candidate"),
  payload: p2pIceCandidateSchema
});

export const WsP2pHangupEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.hangup"),
  payload: p2pHangupSchema
});

export const WsP2pStatusEnvelopeSchema = wsEnvelopeSchema.extend({
  type: z.literal("p2p.status"),
  payload: p2pStatusSchema
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiSuccessEnvelope = z.infer<typeof ApiSuccessSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorSchema>;
export type User = z.infer<typeof userSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type ChannelMode = z.infer<typeof channelModeSchema>;
export type Message = z.infer<typeof messageSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type E2eDisappearingPolicy = z.infer<typeof e2eDisappearingPolicySchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;
export type BotManifest = z.infer<typeof botManifestSchema>;
export type BotEvent = z.infer<typeof botEventSchema>;
export type BotCommandInvoke = z.infer<typeof botCommandInvokeSchema>;
export type BotCommandInvokeEnvelope = z.infer<typeof BotCommandInvokeSchema>;
export type FileRecord = z.infer<typeof fileSchema>;
export type SignalPreKeyBundle = z.infer<typeof signalPreKeyBundleSchema>;
export type P2pOffer = z.infer<typeof p2pOfferSchema>;
export type P2pAnswer = z.infer<typeof p2pAnswerSchema>;
export type P2pIceCandidate = z.infer<typeof p2pIceCandidateSchema>;
export type P2pHangup = z.infer<typeof p2pHangupSchema>;
export type P2pStatus = z.infer<typeof p2pStatusSchema>;

export const nowIso = () => new Date().toISOString();

export const apiOk = <T>(data: T, meta?: z.infer<typeof apiMetaSchema>) => ({ ok: true as const, data, meta });

export const apiFail = (code: ErrorCode, message: string, details?: unknown) => ({
  ok: false as const,
  error: { code, message, details }
});
