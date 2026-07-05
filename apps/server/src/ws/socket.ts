import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../domain/auth/service.js";
import { botService } from "../domain/bots/service.js";
import { store } from "../domain/store.js";
import { workspaceService } from "../domain/workspaces/service.js";
import { logger } from "../observability/logger.js";
import { wsConnections } from "../observability/metrics.js";
import { handleClientEnvelope } from "./gateway.js";

const createBroadcaster = (io: Server) => ({
  toChannel: (channelId: string, event: unknown) => io.to(`channel:${channelId}`).emit("event", event),
  toUser: (targetUserId: string, event: unknown) => io.to(`user:${targetUserId}`).emit("event", event)
});

export const attachSocketServer = (httpServer: HttpServer) => {
  const io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
    transports: ["websocket"],
    pingInterval: 30000,
    pingTimeout: 10000
  });

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
    socket.join(`user:${userId}`);
    for (const channel of store.channels.values()) {
      if (workspaceService.canAccessChannel(userId, channel.id)) socket.join(`channel:${channel.id}`);
    }
    logger.info({ userId, socketId: socket.id }, "WebSocket connected");

    socket.on("event", (raw, callback: (response: unknown) => void) => {
      return callback(handleClientEnvelope(userId, raw, createBroadcaster(io)));
    });

    socket.on("disconnect", () => {
      wsConnections.dec();
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
