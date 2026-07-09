/**
 * Socket.IO Server Setup (Layer 2 — Long Connection Gateway)
 *
 * Responsibilities:
 * - Creates Socket.IO server attached to the HTTP server
 * - Manages CORS origin validation (same as HTTP middleware)
 * - Authenticates user connections via Bearer JWT in handshake auth
 * - Authenticates bot connections via nxbot_v1_ tokens on the /bots namespace
 * - Joins sockets to user, workspace, and channel rooms for targeted broadcasts
 * - Tracks online presence (connection count, first-connect/offline broadcast)
 * - Delegates event processing to handleClientEnvelope (gateway.ts)
 * - Bot event polling via setInterval (500ms) on dedicated /bots namespace
 *
 * Key Design Decisions:
 * - WebSocket authentication happens in the io.use middleware — unauthenticated
 *   connections are rejected before reaching the connection handler.
 * - Presence uses a reference counter (onlineConnections Map) to handle multiple
 *   tabs/devices: offline broadcast only fires when count reaches 0.
 * - Rooms are joined eagerly on connection based on current workspace/channel
 *   membership, avoiding per-event access control checks in the broadcast path.
 * - Bot namespace (/bots) is separate from user namespace to avoid token confusion
 *   and to enable different rate limiting and event formats.
 * - Bot events are polled rather than pushed because bots may reconnect and
 *   would miss events sent during disconnection.
 *
 * Transport:
 * - websocket only (no long-polling fallback) — reduces server load for IM use case
 * - pingInterval 30s, pingTimeout 10s — detects silent disconnects
 */
import type { Server as HttpServer } from "node:http";
import { URL } from "node:url";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../domain/auth/service.js";
import { botService } from "../domain/bots/service.js";
import { store } from "../domain/store.js";
import { workspaceService } from "../domain/workspaces/service.js";
import { logger } from "../observability/logger.js";
import { wsConnections } from "../observability/metrics.js";
import { handleClientEnvelope } from "./gateway.js";
import { setIO } from "./broadcast.js";

const isAllowedOrigin = (origin: string | undefined) => {
  if (!origin) return false;
  if (env.WEB_ORIGIN === "*") return true;
  try {
    const requestOrigin = new URL(origin);
    const allowedOrigin = new URL(env.WEB_ORIGIN);
    return requestOrigin.protocol === allowedOrigin.protocol && requestOrigin.hostname === allowedOrigin.hostname;
  } catch {
    return false;
  }
};

const createBroadcaster = (io: Server) => ({
  toChannel: (channelId: string, event: unknown) => io.to(`channel:${channelId}`).emit("event", event),
  toUser: (targetUserId: string, event: unknown) => io.to(`user:${targetUserId}`).emit("event", event),
  toWorkspace: (workspaceId: string, event: unknown) => io.to(`workspace:${workspaceId}`).emit("event", event),
  relayP2pToUser: (targetUserId: string, envelope: unknown) => io.to(`user:${targetUserId}`).emit("event", envelope)
});

export const attachSocketServer = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => { callback(null, isAllowedOrigin(origin)); }, credentials: true },
    transports: ["websocket"],
    pingInterval: 30000,
    pingTimeout: 10000
  });
  setIO(io);

  io.use((socket, next) => {
    if (socket.nsp?.name === "/bots") return next();
    const token = typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : undefined;
    const userId = token ? verifyAccessToken(token) : null;
    if (!userId) return next(new Error("AUTH_REQUIRED"));
    socket.data.userId = userId;
    return next();
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    wsConnections.inc();
    // Reference counting for multi-tab/device support: only broadcast "online"
    // when the user's first connection arrives (wasOffline), and "offline" only
    // when the last connection drops (count <= 0).
    const wasOffline = !store.onlineConnections.has(userId);
    store.onlineConnections.set(userId, (store.onlineConnections.get(userId) ?? 0) + 1);
    // Join the user to their personal room and all authorized workspace/channel rooms.
    // Room membership is determined eagerly at connection time — this avoids
    // per-event access control checks in the broadcast path.
    socket.join(`user:${userId}`);
    for (const workspace of store.workspaces.values()) {
      if (workspaceService.canAccessWorkspace(userId, workspace.id)) socket.join(`workspace:${workspace.id}`);
    }
    for (const channel of store.channels.values()) {
      if (workspaceService.canAccessChannel(userId, channel.id)) socket.join(`channel:${channel.id}`);
    }
    logger.info({ userId, socketId: socket.id }, "WebSocket connected");

    // Send existing online users to the connecting client
    for (const [uid] of store.onlineConnections) {
      if (uid !== userId) {
        socket.emit("event", { type: "presence.updated", payload: { userId: uid, status: "online" }, timestamp: new Date().toISOString() });
      }
    }

    // Broadcast this user's online status only if they were offline (first connection)
    if (wasOffline) {
      const onlineEvent = { type: "presence.updated", payload: { userId, status: "online" }, timestamp: new Date().toISOString() };
      for (const workspace of store.workspaces.values()) {
        if (workspaceService.canAccessWorkspace(userId, workspace.id)) {
          io.to(`workspace:${workspace.id}`).emit("event", onlineEvent);
        }
      }
    }

    socket.on("event", (raw, callback?: (response: unknown) => void) => {
      const result = handleClientEnvelope(userId, raw, createBroadcaster(io));
      if (typeof callback === "function") callback(result);
    });

    socket.on("disconnect", () => {
      wsConnections.dec();
      const count = (store.onlineConnections.get(userId) ?? 1) - 1;
      if (count <= 0) {
        store.onlineConnections.delete(userId);
        const presenceEvent = { type: "presence.updated", payload: { userId, status: "offline" }, timestamp: new Date().toISOString() };
        for (const ws of workspaceService.listWorkspaces(userId)) {
          io.to(`workspace:${ws.id}`).emit("event", presenceEvent);
        }
      } else {
        store.onlineConnections.set(userId, count);
      }
      logger.info({ userId, socketId: socket.id }, "WebSocket disconnected");
    });
  });

  const botsNamespace = io.of("/bots");
  botsNamespace.use((socket, next) => {
    const token = typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : undefined;
    if (!token) return next(new Error("AUTH_REQUIRED"));
    const bot = botService.validateToken(token);
    if (!bot) return next(new Error("AUTH_REQUIRED"));
    socket.data.botId = bot.id;
    socket.data.workspaceId = bot.workspaceId;
    return next();
  });

  botsNamespace.on("connection", (socket) => {
    const botId = socket.data.botId as string;
    logger.info({ botId, socketId: socket.id }, "Bot WebSocket connected");

    const pollInterval = setInterval(() => {
      const events = botService.pollEvents(botId, 20);
      for (const event of events) socket.emit("bot.event", event);
    }, 500);

    socket.on("disconnect", () => {
      clearInterval(pollInterval);
      logger.info({ botId, socketId: socket.id }, "Bot WebSocket disconnected");
    });
  });

  return io;
};
