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
  type Channel,
  type Message
} from "@nexus-chat/shared";
import { env } from "../config/env.js";
import { attachmentService } from "../domain/attachments/service.js";
import { authService } from "../domain/auth/service.js";
import { botService } from "../domain/bots/service.js";
import { messageService } from "../domain/messages/service.js";
import { store } from "../domain/store.js";
import { broadcastToChannel, broadcastToWorkspace } from "../ws/broadcast.js";
import { signalService } from "../domain/signal/service.js";
import { workspaceService } from "../domain/workspaces/service.js";
import { registry } from "../observability/metrics.js";
import { authRateLimiter, clientIpFromHeaders } from "./auth-rate-limit.js";
import { authRequired, requestContext, securityHeaders, type AppVariables } from "./middleware.js";

const isError = (value: unknown): value is ReturnType<typeof apiFail> => typeof value === "object" && value !== null && "ok" in value && value.ok === false;
const toResponse = (value: unknown) => (isError(value) ? value : apiOk(value));
const requiredParam = (value: string | undefined) => value ?? "";
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

  app.get("/api/v1/auth/me", authRequired, (c) => {
    const user = authService.me(c.get("userId"));
    return user ? c.json(apiOk(user)) : c.json(apiFail("AUTH_REQUIRED", "User not found"), 401);
  });

  app.get("/api/v1/users/by-email", authRequired, (c) => {
    const email = c.req.query("email");
    if (!email) return c.json(apiFail("VALIDATION_FAILED", "email query parameter is required"), 400);
    const user = authService.lookupByEmail(email);
    return user ? c.json(apiOk(user)) : c.json(apiFail("NOT_FOUND", "User not found"), 404);
  });

  app.post("/api/v1/workspaces", authRequired, zValidator("json", createWorkspaceSchema), (c) => c.json(apiOk(workspaceService.createWorkspace(c.get("userId"), c.req.valid("json").name)), 201));
  app.get("/api/v1/workspaces", authRequired, (c) => c.json(apiOk(workspaceService.listWorkspaces(c.get("userId")))));
  app.get("/api/v1/workspaces/:id", authRequired, (c) => {
    const workspace = workspaceService.getWorkspace(c.get("userId"), requiredParam(c.req.param("id")));
    return workspace ? c.json(apiOk(workspace)) : c.json(apiFail("NOT_FOUND", "Workspace not found"), 404);
  });
  app.patch("/api/v1/workspaces/:id", authRequired, zValidator("json", updateWorkspaceSchema), (c) => c.json(toResponse(workspaceService.updateWorkspace(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").name))));
  app.post("/api/v1/workspaces/:id/members", authRequired, zValidator("json", addWorkspaceMemberSchema), (c) => c.json(toResponse(workspaceService.addMember(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").userId, c.req.valid("json").role))));
  app.post("/api/v1/workspaces/:id/transfer-ownership", authRequired, zValidator("json", transferWorkspaceOwnershipSchema), (c) => c.json(toResponse(workspaceService.transferOwnership(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").newOwnerUserId))));
  app.delete("/api/v1/workspaces/:id/members/:userId", authRequired, (c) => c.json(toResponse(workspaceService.removeMember(c.get("userId"), requiredParam(c.req.param("id")), requiredParam(c.req.param("userId"))))));
  app.get("/api/v1/workspaces/:id/members", authRequired, (c) => c.json(apiOk(workspaceService.listMembers(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/workspaces/:id/channels", authRequired, zValidator("json", createChannelSchema), (c) => {
    const input = c.req.valid("json");
    const result = workspaceService.createChannel(c.get("userId"), requiredParam(c.req.param("id")), input.name, input.mode, input.isPrivate);
    if ("ok" in result) return c.json(toResponse(result));
    broadcastToWorkspace(result.workspaceId, { type: "channel.created", payload: result, timestamp: new Date().toISOString() });
    return c.json(toResponse(result), 201);
  });
  app.get("/api/v1/workspaces/:id/channels", authRequired, (c) => {
    const userId = c.get("userId");
    const channels = workspaceService.listChannels(userId, requiredParam(c.req.param("id")));
    return c.json(apiOk(channels.map((ch) => ({ ...ch, muted: workspaceService.isChannelMuted(userId, ch.id) }))));
  });
  app.get("/api/v1/workspaces/:id/unread-counts", authRequired, (c) => c.json(apiOk(messageService.getUnreadCounts(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/channels/:id/mark-read", authRequired, (c) => c.json(toResponse(messageService.markRead(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.patch("/api/v1/channels/:id", authRequired, async (c) => {
    const body = await c.req.json() as { name?: string; description?: string };
    const channelId = requiredParam(c.req.param("id"));
    const channel = store.channels.get(channelId);
    if (!channel) return c.json(apiFail("NOT_FOUND", "Channel not found"), 404);
    if (!workspaceService.canManageChannel(c.get("userId"), channelId)) return c.json(apiFail("FORBIDDEN", "Only admins and channel creators can update channels"), 403);
    const updates: Partial<Channel> = {};
    if (body.name !== undefined) updates.name = body.name.trim().slice(0, 120);
    if (body.description !== undefined) updates.description = body.description.trim().slice(0, 500) || undefined;
    const updated = { ...channel, ...updates };
    store.channels.set(channelId, updated);
    return c.json(apiOk(updated));
  });
  app.post("/api/v1/channels/:id/mute", authRequired, (c) => c.json(toResponse(workspaceService.muteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.delete("/api/v1/channels/:id/mute", authRequired, (c) => c.json(toResponse(workspaceService.unmuteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.get("/api/v1/channels/:id/mute-status", authRequired, (c) => c.json(apiOk({ muted: workspaceService.isChannelMuted(c.get("userId"), requiredParam(c.req.param("id"))) })));
  app.post("/api/v1/channels/:id/members", authRequired, zValidator("json", addChannelMemberSchema), (c) => c.json(toResponse(workspaceService.addChannelMember(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").userId))));
  app.delete("/api/v1/channels/:id/members/:userId", authRequired, (c) => c.json(toResponse(workspaceService.removeChannelMember(c.get("userId"), requiredParam(c.req.param("id")), requiredParam(c.req.param("userId"))))));
  app.get("/api/v1/channels/:id/members", authRequired, (c) => c.json(apiOk(workspaceService.listChannelMembers(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/channels/:id/archive", authRequired, (c) => c.json(toResponse(workspaceService.archiveChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.delete("/api/v1/channels/:id", authRequired, (c) => c.json(toResponse(workspaceService.deleteChannel(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/dms", authRequired, zValidator("json", createDmSchema), (c) => {
    const input = c.req.valid("json");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json(apiFail("VALIDATION_FAILED", "workspaceId query parameter is required"), 400);
    const result = workspaceService.createOrGetDm(c.get("userId"), workspaceId, input.peerUserId, input.mode);
    if ("ok" in result) return c.json(toResponse(result));
    broadcastToWorkspace(result.workspaceId, { type: "dm.created", payload: result, timestamp: new Date().toISOString() });
    return c.json(toResponse(result), 201);
  });

  app.post("/api/v1/messages", authRequired, zValidator("json", sendMessageSchema), (c) => c.json(toResponse(messageService.send(c.get("userId"), c.req.valid("json"))), 201));
  app.get("/api/v1/channels/:id/messages", authRequired, zValidator("query", paginationSchema), (c) => {
    const page = c.req.valid("query");
    return c.json(apiOk(messageService.list(c.get("userId"), requiredParam(c.req.param("id")), page.cursor, page.limit)));
  });
  app.patch("/api/v1/messages/:id", authRequired, zValidator("json", editMessageSchema), (c) => {
    const result = messageService.edit(c.get("userId"), requiredParam(c.req.param("id")), c.req.valid("json").text);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    const msg = result as Message;
    broadcastToChannel(msg.channelId, { type: "message.updated", payload: msg, timestamp: new Date().toISOString() });
    return c.json(apiOk(msg));
  });
  app.delete("/api/v1/messages/:id", authRequired, (c) => {
    const result = messageService.softDelete(c.get("userId"), requiredParam(c.req.param("id")));
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    const msg = result as Message;
    broadcastToChannel(msg.channelId, { type: "message.deleted", payload: msg, timestamp: new Date().toISOString() });
    return c.json(apiOk(msg));
  });
  app.post("/api/v1/messages/:id/reactions", authRequired, zValidator("json", reactMessageSchema), (c) => {
    const actorUserId = c.get("userId");
    const result = messageService.react(actorUserId, requiredParam(c.req.param("id")), c.req.valid("json").emoji);
    if ("error" in result && !result.ok) return c.json(toResponse(result));
    const msg = store.messages.get(requiredParam(c.req.param("id")));
    if (msg) broadcastToChannel(msg.channelId, { type: "message.reaction", payload: { ...result, actorUserId }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.delete("/api/v1/messages/:id/reactions", authRequired, zValidator("json", reactMessageSchema), (c) => {
    const actorUserId = c.get("userId");
    const result = messageService.react(actorUserId, requiredParam(c.req.param("id")), c.req.valid("json").emoji, "remove");
    if ("error" in result && !result.ok) return c.json(toResponse(result));
    const msg = store.messages.get(requiredParam(c.req.param("id")));
    if (msg) broadcastToChannel(msg.channelId, { type: "message.reaction", payload: { ...result, actorUserId }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.get("/api/v1/channels/:id/reactions", authRequired, (c) => c.json(apiOk(messageService.getReactions(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.post("/api/v1/messages/:id/forward", authRequired, zValidator("json", forwardMessageSchema), (c) => {
    const input = c.req.valid("json");
    return c.json(toResponse(messageService.forward(c.get("userId"), requiredParam(c.req.param("id")), input.targetChannelId, input.clientMsgId)));
  });
  app.post("/api/v1/messages/:id/save", authRequired, (c) => c.json(toResponse(messageService.save(c.get("userId"), requiredParam(c.req.param("id"))))));

  // Pin routes
  app.post("/api/v1/channels/:id/pins", authRequired, zValidator("json", z.object({ messageId: idSchema })), (c) => {
    const { messageId } = c.req.valid("json");
    const channelId = requiredParam(c.req.param("id"));
    const result = messageService.pinMessage(c.get("userId"), channelId, messageId);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    broadcastToChannel(channelId, { type: "channel.pin_changed", payload: { channelId, messageId, pinned: true }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.delete("/api/v1/channels/:id/pins/:messageId", authRequired, (c) => {
    const channelId = requiredParam(c.req.param("id"));
    const messageId = requiredParam(c.req.param("messageId"));
    const result = messageService.unpinMessage(c.get("userId"), channelId, messageId);
    if ("error" in result && !result.ok) return c.json(toResponse(result as ReturnType<typeof apiFail>));
    broadcastToChannel(channelId, { type: "channel.pin_changed", payload: { channelId, messageId, pinned: false }, timestamp: new Date().toISOString() });
    return c.json(apiOk(result));
  });
  app.get("/api/v1/channels/:id/pins", authRequired, (c) => c.json(toResponse(messageService.listPins(c.get("userId"), requiredParam(c.req.param("id"))))));

  app.post("/api/v1/attachments/upload-sessions", authRequired, zValidator("json", uploadSessionCreateSchema), (c) => c.json(toResponse(attachmentService.createUploadSession(c.get("userId"), c.req.valid("json"))), 201));
  app.post("/api/v1/attachments/upload-sessions/:id/complete", authRequired, (c) => c.json(toResponse(attachmentService.completeUpload(c.get("userId"), requiredParam(c.req.param("id"))))));
  app.get("/api/v1/attachments/:fileId", authRequired, (c) => c.json(toResponse(attachmentService.getFile(c.get("userId"), requiredParam(c.req.param("fileId"))))));
  app.post("/api/v1/attachments/:fileId/download-url", authRequired, (c) => c.json(toResponse(attachmentService.createDownloadUrl(c.get("userId"), requiredParam(c.req.param("fileId"))))));

  app.put("/dev-upload/:fileId", authRequired, async (c) => {
    const fileId = requiredParam(c.req.param("fileId"));
    const uploadSession = [...store.uploadSessions.values()].find((session) => session.fileId === fileId && session.userId === c.get("userId"));
    if (!uploadSession) return c.json(apiFail("FORBIDDEN", "Upload session access denied"), 403);
    const body = await c.req.arrayBuffer();
    const file = store.files.get(fileId);
    if (!file) return c.json({ ok: false, error: { code: "NOT_FOUND", message: "File not found" } }, 404);
    store.files.set(fileId, { ...file, objectKey: `dev-uploaded-${fileId}`, scanStatus: "clean" as const, sizeBytes: body.byteLength });
    store.devFileContent = store.devFileContent ?? new Map();
    store.devFileContent.set(fileId, body);
    return c.json({ ok: true, data: {} });
  });

  app.get("/dev-download/:fileId", authRequired, (c) => {
    const fileId = requiredParam(c.req.param("fileId"));
    const file = store.files.get(fileId);
    const content = store.devFileContent?.get(fileId);
    if (!file || !content) return c.notFound();
    if (!workspaceService.canAccessWorkspace(c.get("userId"), file.workspaceId)) return c.json(apiFail("FORBIDDEN", "File access denied"), 403);
    c.header("content-type", file.contentType ?? "application/octet-stream");
    return c.body(new Uint8Array(content));
  });

  app.post("/api/v1/signal/prekey-bundles", authRequired, zValidator("json", signalPreKeyBundleSchema), (c) => {
    const { oneTimePreKeys, ...bundle } = c.req.valid("json");
    return c.json(toResponse(signalService.uploadBundle(c.get("userId"), bundle, oneTimePreKeys)));
  });
  app.get("/api/v1/signal/prekey-bundles/:userId/:deviceId", authRequired, (c) => c.json(toResponse(signalService.fetchBundle(c.get("userId"), requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId"))))));
  app.post("/api/v1/signal/prekey-bundles/:userId/:deviceId/consume", authRequired, (c) => {
    const keyId = Number(c.req.query("keyId"));
    if (Number.isNaN(keyId)) return c.json(apiFail("VALIDATION_FAILED", "keyId query parameter is required"), 400);
    return c.json(toResponse(signalService.consumeOneTimePreKey(requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId")), keyId)));
  });
  app.get("/api/v1/signal/prekey-bundles/:userId/:deviceId/count", authRequired, (c) => c.json(apiOk({ remaining: signalService.getRemainingPreKeyCount(requiredParam(c.req.param("userId")), requiredParam(c.req.param("deviceId"))) })));
  app.post("/api/v1/signal/sessions", authRequired, (c) => {
    const peerUserId = c.req.query("peerUserId");
    const deviceId = c.req.query("deviceId") ?? "default";
    if (!peerUserId) return c.json(apiFail("VALIDATION_FAILED", "peerUserId query parameter is required"), 400);
    return c.json(apiOk(signalService.storeSession(c.get("userId"), peerUserId, deviceId)), 201);
  });
  app.get("/api/v1/signal/sessions", authRequired, (c) => c.json(apiOk(signalService.listUserSessions(c.get("userId")))));
  app.get("/api/v1/signal/sessions/:id", authRequired, (c) => c.json(toResponse(signalService.getSession(requiredParam(c.req.param("id"))))));

  app.post("/api/v1/bots/install", authRequired, zValidator("json", botManifestSchema), (c) => c.json(apiOk(botService.install(c.get("userId"), c.req.query("workspaceId") ?? "", c.req.valid("json"))), 201));
  app.post("/api/v1/bots/commands", authRequired, zValidator("json", botCommandInvokeSchema), (c) => c.json(toResponse(botService.invokeCommand(c.req.valid("json")))));
  app.post("/api/v1/bots/:botId/channels/:channelId", authRequired, (c) => c.json(toResponse(botService.addToChannel(requiredParam(c.req.param("botId")), requiredParam(c.req.param("channelId"))))));
  app.delete("/api/v1/bots/:botId/channels/:channelId", authRequired, (c) => c.json(toResponse(botService.removeFromChannel(requiredParam(c.req.param("botId")), requiredParam(c.req.param("channelId"))))));
  app.post("/api/v1/bots/subscriptions", authRequired, (c) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "") ?? "";
    const bot = botService.validateToken(token);
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    const eventType = c.req.query("eventType");
    if (!eventType) return c.json(apiFail("VALIDATION_FAILED", "eventType query parameter is required"), 400);
    return c.json(apiOk(botService.subscribe(bot.id, eventType)));
  });
  app.delete("/api/v1/bots/subscriptions", authRequired, (c) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "") ?? "";
    const bot = botService.validateToken(token);
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    const eventType = c.req.query("eventType");
    if (!eventType) return c.json(apiFail("VALIDATION_FAILED", "eventType query parameter is required"), 400);
    return c.json(apiOk(botService.unsubscribe(bot.id, eventType)));
  });
  app.get("/api/v1/bots/:botId/subscriptions", authRequired, (c) => c.json(apiOk(botService.getSubscriptions(requiredParam(c.req.param("botId"))))));
  app.post("/api/v1/bots/messages", authRequired, zValidator("json", sendMessageSchema), (c) => {
    const bot = botService.validateToken(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (!bot) return c.json(apiFail("AUTH_REQUIRED", "Invalid bot token"), 401);
    return c.json(toResponse(botService.sendBotMessage(bot.id, c.req.valid("json"))));
  });

  return app;
};
