/**
 * HTTP REST Routes (Hono)
 *
 * Phase 1 monolith — 60+ endpoints organized by domain:
 * - /healthz, /metrics (observability)
 * - /api/v1/auth/* (registration, login, refresh, logout, me, user lookup)
 * - /api/v1/workspaces/* (CRUD, membership, channel management, DMs)
 * - /api/v1/channels/* (CRUD, members, pins, mute, archive, reactions)
 * - /api/v1/messages/* (send, edit, delete, forward, save, reactions, read)
 * - /api/v1/attachments/* (upload sessions, file retrieval, download URLs)
 * - /api/v1/signal/* (pre-key bundles, sessions — E2EE)
 * - /api/v1/bots/* (install, commands, channels, subscriptions)
 * - /dev-upload, /dev-download (in-memory dev file storage)
 *
 * Architecture:
 * - app.use("*") for cross-cutting middleware (requestContext, securityHeaders, cors)
 * - authRequired middleware on every API route
 * - zValidator for Zod-based input validation at route boundaries
 * - Some mutation routes broadcast via WebSocket (broadcastToChannel / broadcastToWorkspace)
 *   to notify connected clients in real time.
 *
 * Does NOT:
 * - Handle WebSocket connections (owned by ws/)
 * - Run domain logic (delegated to domain services)
 * - Directly access persistence adapters (delegated to domain services)
 */
import { URL } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  addChannelMemberSchema,
  addWorkspaceMemberSchema,
  apiFail,
  apiOk,
  botCommandInvokeSchema,
  botManifestSchema,
  createChannelSchema,
  createDmSchema,
  createWorkspaceSchema,
  editMessageSchema,
  forwardMessageSchema,
  idSchema,
  loginRequestSchema,
  paginationSchema,
  reactMessageSchema,
  refreshRequestSchema,
  registerRequestSchema,
  sendMessageSchema,
  signalPreKeyBundleSchema,
  transferWorkspaceOwnershipSchema,
  updateWorkspaceSchema,
  uploadSessionCreateSchema,
  type Message
} from "@nexus-chat/shared";
import { env } from "../config/env.js";
import { attachmentService } from "../domain/attachments/service.js";
import { authService } from "../domain/auth/service.js";
import { botService } from "../domain/bots/service.js";
import { messageService } from "../domain/messages/service.js";
import { store } from "../domain/store.js";
import { pingDb } from "../db/client.js";
import { pingSessionStore } from "../domain/auth/session-store.js";
import { broadcastToChannel, broadcastToWorkspace } from "../ws/broadcast.js";
import { signalService } from "../domain/signal/service.js";
import { workspacePersistenceService } from "../domain/workspaces/persistence-service.js";
import { registry } from "../observability/metrics.js";
import { authRateLimiter, clientIpFromHeaders } from "./auth-rate-limit.js";
import { authRequired, requestContext, securityHeaders, type AppVariables } from "./middleware.js";

/**
 * Type-narrows an unknown value to an apiFail (error) return type.
 *
 * Used by toResponse() to distinguish domain-layer errors from valid results.
 * Domain services return either a business object (Message, Channel, etc.) or
 * an apiFail() result — this guard detects the error case via the `ok: false` shape.
 */
const isError = (value: unknown): value is ReturnType<typeof apiFail> => typeof value === "object" && value !== null && "ok" in value && value.ok === false;

/**
 * Wraps domain service return values into the API response envelope.
 *
 * If the service returned an error (detected by isError), pass it through
 * unchanged. Otherwise, wrap the raw value in apiOk() so every HTTP response
 * has the same { ok, data/error } shape.
 */
const toResponse = (value: unknown) => (isError(value) ? value : apiOk(value));

const requiredParam = (value: string | undefined) => value ?? "";

/**
 * CORS origin validation.
 *
 * Compares protocol and hostname only — intentionally ignores port differences
 * so that localhost with any port (e.g. localhost:5173, localhost:9999) is
 * allowed, but lookalike hosts (localhost.evil.com) are blocked.
 */
const isAllowedOrigin = (origin: string) => {
  if (env.WEB_ORIGIN === "*") return true;
  try {
    const requestOrigin = new URL(origin);
    const allowedOrigin = new URL(env.WEB_ORIGIN);
    return requestOrigin.protocol === allowedOrigin.protocol && requestOrigin.hostname === allowedOrigin.hostname;
  } catch {
    return false;
  }
};

export const createHttpApp = () => {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", requestContext);
  app.use("*", securityHeaders);
  app.use("*", cors({ origin: (origin) => (isAllowedOrigin(origin) ? origin : env.WEB_ORIGIN === "*" ? origin : env.WEB_ORIGIN), credentials: true }));

  app.get("/healthz", (c) => c.json(apiOk({ status: "ok" })));
  app.get("/readyz", async (c) => {
    try {
      if (env.PERSISTENCE === "postgres") await pingDb();
      await pingSessionStore();
      return c.json(apiOk({ status: "ready" }));
    } catch {
      return c.json(apiFail("INTERNAL_ERROR", "Configured dependency is unavailable"), 503);
    }
  });
  app.get("/metrics", async (c) => c.text(await registry.metrics(), 200, { "content-type": registry.contentType }));

  app.post("/api/v1/auth/register", zValidator("json", registerRequestSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await authService.register(input.email, input.password, input.displayName);
    return c.json(result.ok ? apiOk(result.session) : result.error, result.ok ? 201 : 400);
  });

  app.post("/api/v1/auth/login", zValidator("json", loginRequestSchema), async (c) => {
    const input = c.req.valid("json");
    const clientIp = clientIpFromHeaders(c.req.raw.headers);
    const decision = authRateLimiter.check(clientIp, input.email);
    if (decision.limited) {
      c.header("retry-after", String(decision.retryAfterSeconds ?? 60));
      return c.json(apiFail("RATE_LIMITED", "Too many login attempts"), 429);
    }
    const result = await authService.login(input.email, input.password);
    if (!result.ok) authRateLimiter.recordFailure(clientIp, input.email);
    return c.json(result.ok ? apiOk(result.session) : result.error, result.ok ? 200 : 401);
  });

  app.post("/api/v1/auth/refresh", zValidator("json", refreshRequestSchema), async (c) => {
    const result = await authService.refresh(c.req.valid("json").refreshToken);
    return c.json(result.ok ? apiOk(result.session) : result.error, result.ok ? 200 : 401);
  });

  app.post("/api/v1/auth/logout", zValidator("json", refreshRequestSchema), async (c) => {
    await authService.logout(c.req.valid("json").refreshToken);
    return c.json(apiOk({ loggedOut: true }));
  });

  app.get("/api/v1/auth/me", authRequired, async (c) => {
    const user = await authService.me(c.get("userId"));
    return user ? c.json(apiOk(user)) : c.json(apiFail("AUTH_REQUIRED", "User not found"), 401);
  });

  app.get("/api/v1/users/by-email", authRequired, async (c) => {
    const email = c.req.query("email");
    if (!email) return c.json(apiFail("VALIDATION_FAILED", "email query parameter is required"), 400);
    const user = await authService.lookupByEmail(email);
    return user ? c.json(apiOk(user)) : c.json(apiFail("NOT_FOUND", "User not found"), 404);
  });

  app.post("/api/v1/workspaces", authRequired, zValidator("json", createWorkspaceSchema), async (c) => c.json(apiOk(await workspacePersistenceService.createWorkspace(c.get("userId"), c.req.valid("json").name)), 201));
  app.get("/api/v1/workspaces", authRequired, async (c) => c.json(apiOk(await workspacePersistenceService.listWorkspaces(c.get("userId")))));
  app.get("/api/v1/workspaces/:id", authRequired, async (c) => {
    const workspace = await workspacePersistenceService.getWorkspace(c.get("userId"), requiredParam(c.req.param("id")));
    return workspace ? c.json(apiOk(workspace)) : c.json(apiFail("NOT_FOUND", "Workspace not found"), 404);
  });
  app.patch("/api/v1/workspaces/:id", authRequired, zValidator("json", updateWorkspaceSchema), async (c) => c.json(toResponse(await workspacePersistenceService.updateWorkspace(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").name))));
  app.post("/api/v1/workspaces/:id/members", authRequired, zValidator("json", addWorkspaceMemberSchema), async (c) => c.json(toResponse(await workspacePersistenceService.addMember(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").userId, c.req.valid("json").role))));
  app.post("/api/v1/workspaces/:id/transfer-ownership", authRequired, zValidator("json", transferWorkspaceOwnershipSchema), async (c) => c.json(toResponse(await workspacePersistenceService.transferOwnership(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").newOwnerUserId))));
  app.delete("/api/v1/workspaces/:id/members/:userId", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.removeMember(c.get("userId"), requiredParam(c.req.param("id")), requiredParam(c.req.param("userId"))))));
  app.get("/api/v1/workspaces/:id/members", authRequired, async (c) => c.json(apiOk(await workspacePersistenceService.listMembers(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/workspaces/:id/channels", authRequired, zValidator("json", createChannelSchema), async (c) => {
    const input = c.req.valid("json");
    const result = await workspacePersistenceService.createChannel(c.get("userId"), requiredParam(c.req.param("id")), input.name, input.mode, input.isPrivate);
    if ("ok" in result) return c.json(toResponse(result));
    broadcastToWorkspace(result.workspaceId, { type: "channel.created", payload: result, timestamp: new Date().toISOString() });
    return c.json(toResponse(result), 201);
  });
  app.get("/api/v1/workspaces/:id/channels", authRequired, async (c) => {
    const userId = c.get("userId");
    const channels = await workspacePersistenceService.listChannels(userId, requiredParam(c.req.param("id")));
    return c.json(apiOk(await Promise.all(channels.map(async (ch) => ({ ...ch, muted: await workspacePersistenceService.isChannelMuted(userId, ch.id) })) )));
  });
  app.get("/api/v1/workspaces/:id/unread-counts", authRequired, async (c) => c.json(apiOk(await messageService.getUnreadCounts(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/channels/:id/mark-read", authRequired, async (c) => c.json(toResponse(await messageService.markRead(c.get("userId"), requiredParam(c.req.param("id"))))));
  // Channel PATCH — inline update rather than delegating to workspaceService because
  // the description field was added late (Task #24) and the service layer doesn't expose
  // a generalized channel-update method yet. Bounds name to 120 chars, description to 500.
  app.patch("/api/v1/channels/:id", authRequired, async (c) => {
    const body = await c.req.json() as { name?: string; description?: string };
    const channelId = requiredParam(c.req.param("id"));
    const existing = await workspacePersistenceService.updateChannel(c.get("userId"), channelId, { ...(body.name !== undefined ? { name: body.name.trim().slice(0, 120) } : {}), ...(body.description !== undefined ? { description: body.description.trim().slice(0, 500) || undefined } : {}) });
    return c.json(toResponse(existing));
  });
  app.post("/api/v1/channels/:id/mute", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.muteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.delete("/api/v1/channels/:id/mute", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.unmuteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.get("/api/v1/channels/:id/mute-status", authRequired, async (c) => c.json(apiOk({ muted: await workspacePersistenceService.isChannelMuted(c.get("userId"), requiredParam(c.req.param("id"))) })));
  app.post("/api/v1/channels/:id/members", authRequired, zValidator("json", addChannelMemberSchema), async (c) => c.json(toResponse(await workspacePersistenceService.addChannelMember(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").userId))));
  app.delete("/api/v1/channels/:id/members/:userId", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.removeChannelMember(c.get("userId"), requiredParam(c.req.param("id")), requiredParam(c.req.param("userId"))))));
  app.get("/api/v1/channels/:id/members", authRequired, async (c) => c.json(apiOk(await workspacePersistenceService.listChannelMembers(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/channels/:id/archive", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.archiveChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.delete("/api/v1/channels/:id", authRequired, async (c) => c.json(toResponse(await workspacePersistenceService.deleteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/dms", authRequired, zValidator("json", createDmSchema), async (c) => {
    const input = c.req.valid("json");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json(apiFail("VALIDATION_FAILED", "workspaceId query parameter is required"), 400);
    const result = await workspacePersistenceService.createOrGetDm(c.get("userId"), workspaceId, input.peerUserId, input.mode);
    if ("ok" in result) return c.json(toResponse(result));
    broadcastToWorkspace(result.workspaceId, { type: "dm.created", payload: result, timestamp: new Date().toISOString() });
    return c.json(toResponse(result), 201);
  });

  app.post("/api/v1/messages", authRequired, zValidator("json", sendMessageSchema), async (c) => c.json(toResponse(await messageService.send(c.get("userId"), c.req.valid("json"))), 201));
  app.get("/api/v1/channels/:id/messages", authRequired, zValidator("query", paginationSchema), async (c) => {
    const page = c.req.valid("query");
    return c.json(apiOk(await messageService.list(c.get("userId"), requiredParam(c.req.param("id")), page.cursor, page.limit)));
  });
  app.patch("/api/v1/messages/:id", authRequired, zValidator("json", editMessageSchema), async (c) => {
    const result = await messageService.edit(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").text);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    const msg = result as Message;
    broadcastToChannel(msg.channelId, { type: "message.updated", payload: msg, timestamp: new Date().toISOString() });
    return c.json(apiOk(msg));
  });
  app.delete("/api/v1/messages/:id", authRequired, async (c) => {
    const result = await messageService.softDelete(c.get("userId"), requiredParam(c.req.param("id")));
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    const msg = result as Message;
    broadcastToChannel(msg.channelId, { type: "message.deleted", payload: msg, timestamp: new Date().toISOString() });
    return c.json(apiOk(msg));
  });
  app.post("/api/v1/messages/:id/reactions", authRequired, zValidator("json", reactMessageSchema), async (c) => {
    const actorUserId = c.get("userId");
    const result = await messageService.react(actorUserId, requiredParam(c.req.param("id")), c.req.valid("json").emoji);
    if ("error" in result && !result.ok) return c.json(toResponse(result));
    const msg = await messageService.getMessage(requiredParam(c.req.param("id")));
    if (msg) broadcastToChannel(msg.channelId, { type: "message.reaction", payload: { ...result, actorUserId }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.delete("/api/v1/messages/:id/reactions", authRequired, zValidator("json", reactMessageSchema), async (c) => {
    const actorUserId = c.get("userId");
    const result = await messageService.react(actorUserId, requiredParam(c.req.param("id")), c.req.valid("json").emoji, "remove");
    if ("error" in result && !result.ok) return c.json(toResponse(result));
    const msg = await messageService.getMessage(requiredParam(c.req.param("id")));
    if (msg) broadcastToChannel(msg.channelId, { type: "message.reaction", payload: { ...result, actorUserId }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.get("/api/v1/channels/:id/reactions", authRequired, async (c) => c.json(apiOk(await messageService.getReactions(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/messages/:id/forward", authRequired, zValidator("json", forwardMessageSchema), async (c) => {
    const input = c.req.valid("json");
    return c.json(toResponse(await messageService.forward(c.get("userId"), requiredParam(c.req.param("id")), input.targetChannelId, input.clientMsgId)));
  });
  app.post("/api/v1/messages/:id/save", authRequired, async (c) => c.json(toResponse(await messageService.save(c.get("userId"), requiredParam(c.req.param("id"))))));

  // Pin routes
  app.post("/api/v1/channels/:id/pins", authRequired, zValidator("json", z.object({ messageId: idSchema })), async (c) => {
    const { messageId } = c.req.valid("json");
    const channelId = requiredParam(c.req.param("id"));
    const result = await messageService.pinMessage(c.get("userId"), channelId, messageId);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    broadcastToChannel(channelId, { type: "channel.pin_changed", payload: { channelId, messageId, pinned: true }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.delete("/api/v1/channels/:id/pins/:messageId", authRequired, async (c) => {
    const channelId = requiredParam(c.req.param("id"));
    const messageId = requiredParam(c.req.param("messageId"));
    const result = await messageService.unpinMessage(c.get("userId"), channelId, messageId);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    broadcastToChannel(channelId, { type: "channel.pin_changed", payload: { channelId, messageId, pinned: false }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.get("/api/v1/channels/:id/pins", authRequired, async (c) => c.json(toResponse(await messageService.listPins(c.get("userId"), requiredParam(c.req.param("id"))))));

  app.post("/api/v1/attachments/upload-sessions", authRequired, zValidator("json", uploadSessionCreateSchema), async (c) => c.json(toResponse(await attachmentService.createUploadSession(c.get("userId"), c.req.valid("json"))), 201));
  app.post("/api/v1/attachments/upload-sessions/:id/complete", authRequired, async (c) => c.json(toResponse(await attachmentService.completeUpload(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.get("/api/v1/attachments/:fileId", authRequired, async (c) => c.json(toResponse(await attachmentService.getFile(c.get("userId"), requiredParam(c.req.param("fileId"))))));
  app.post("/api/v1/attachments/:fileId/download-url", authRequired, async (c) => c.json(toResponse(await attachmentService.createDownloadUrl(c.get("userId"), requiredParam(c.req.param("fileId"))))));

  if (env.NODE_ENV !== "production") {
    // Development file bytes intentionally stay process-local. Production uses object storage.
    app.put("/dev-upload/:fileId", authRequired, async (c) => {
      const fileId = requiredParam(c.req.param("fileId"));
      if (!await attachmentService.canUploadFile(c.get("userId"), fileId)) return c.json(apiFail("FORBIDDEN", "Upload session access denied"), 403);
      const body = await c.req.arrayBuffer();
      const file = await attachmentService.getFile(c.get("userId"), fileId);
      if ("ok" in file) return c.json(file, 404);
      await attachmentService.updateDevUpload(fileId, body.byteLength);
      store.devFileContent = store.devFileContent ?? new Map();
      store.devFileContent.set(fileId, body);
      return c.json({ ok: true, data: {} });
    });

    app.get("/dev-download/:fileId", authRequired, async (c) => {
      const fileId = requiredParam(c.req.param("fileId"));
      const file = await attachmentService.getFile(c.get("userId"), fileId);
      const content = store.devFileContent?.get(fileId);
      if ("ok" in file || !content) return c.notFound();
      c.header("content-type", file.contentType ?? "application/octet-stream");
      return c.body(new Uint8Array(content));
    });
  }

  app.post("/api/v1/signal/prekey-bundles", authRequired, zValidator("json", signalPreKeyBundleSchema), async (c) => {
    const { oneTimePreKeys, ...bundle } = c.req.valid("json");
    return c.json(toResponse(await signalService.uploadBundle(c.get("userId"), bundle, oneTimePreKeys)));
  });
  app.get("/api/v1/signal/prekey-bundles/:userId/:deviceId", authRequired, async (c) => c.json(toResponse(await signalService.fetchBundle(c.get("userId"), requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId"))))));
  app.post("/api/v1/signal/prekey-bundles/:userId/:deviceId/consume", authRequired, async (c) => {
    const keyId = Number(c.req.query("keyId"));
    if (Number.isNaN(keyId)) return c.json(apiFail("VALIDATION_FAILED", "keyId query parameter is required"), 400);
    return c.json(toResponse(await signalService.consumeOneTimePreKey(requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId")), keyId)));
  });
  app.get("/api/v1/signal/prekey-bundles/:userId/:deviceId/count", authRequired, async (c) => c.json(apiOk({ remaining: await signalService.getRemainingPreKeyCount(requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId"))) })));
  app.post("/api/v1/signal/sessions", authRequired, async (c) => {
    const peerUserId = c.req.query("peerUserId");
    const deviceId = c.req.query("deviceId") ?? "default";
    if (!peerUserId) return c.json(apiFail("VALIDATION_FAILED", "peerUserId query parameter is required"), 400);
    return c.json(apiOk(await signalService.storeSession(c.get("userId"), peerUserId, deviceId)), 201);
  });
  app.get("/api/v1/signal/sessions", authRequired, async (c) => c.json(apiOk(await signalService.listUserSessions(c.get("userId")))));
  app.get("/api/v1/signal/sessions/:id", authRequired, async (c) => c.json(toResponse(await signalService.getSession(requiredParam(c.req.param("id"))))));

  app.post("/api/v1/bots/install", authRequired, zValidator("json", botManifestSchema), async (c) => c.json(apiOk(await botService.install(c.get("userId"), c.req.query("workspaceId") ?? "", c.req.valid("json"))), 201));
  app.post("/api/v1/bots/commands", authRequired, zValidator("json", botCommandInvokeSchema), async (c) => c.json(toResponse(await botService.invokeCommand(c.req.valid("json")))));
  app.post("/api/v1/bots/:botId/channels/:channelId", authRequired, async (c) => c.json(toResponse(await botService.addToChannel(requiredParam(c.req.param("botId")), requiredParam(c.req.param("channelId"))))));
  app.delete("/api/v1/bots/:botId/channels/:channelId", authRequired, async (c) => c.json(toResponse(await botService.removeFromChannel(requiredParam(c.req.param("botId")), requiredParam(c.req.param("channelId"))))));
  app.post("/api/v1/bots/subscriptions", authRequired, async (c) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "") ?? "";
    const bot = await botService.validateToken(token);
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    const eventType = c.req.query("eventType");
    if (!eventType) return c.json(apiFail("VALIDATION_FAILED", "eventType query parameter is required"), 400);
    return c.json(apiOk(await botService.subscribe(bot.id, eventType)));
  });
  app.delete("/api/v1/bots/subscriptions", authRequired, async (c) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "") ?? "";
    const bot = await botService.validateToken(token);
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    const eventType = c.req.query("eventType");
    if (!eventType) return c.json(apiFail("VALIDATION_FAILED", "eventType query parameter is required"), 400);
    return c.json(apiOk(await botService.unsubscribe(bot.id, eventType)));
  });
  app.get("/api/v1/bots/:botId/subscriptions", authRequired, async (c) => c.json(apiOk(await botService.getSubscriptions(requiredParam(c.req.param("botId"))))));
  app.post("/api/v1/bots/messages", authRequired, zValidator("json", sendMessageSchema), async (c) => {
    const bot = await botService.validateToken(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    return c.json(toResponse(await botService.sendBotMessage(bot.id, c.req.valid("json"))));
  });

  return app;
};
