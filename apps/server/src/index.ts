/**
 * Server Entry Point (Phase 1 Monolith)
 *
 * Responsibilities:
 * - Creates the HTTP app (REST API via Hono)
 * - Attaches the Socket.IO WebSocket server
 * - Binds to the configured host and port
 *
 * Does NOT:
 * - Run database migrations (handled separately via drizzle-kit)
 * - Start background workers or bot polling
 * - Initialize Redis (lazy connect from session-store)
 *
 * Invariants:
 * - Single HTTP server serves both REST and WebSocket on the same port
 * - WebSocket upgrades are handled by Socket.IO after the Hono app is ready
 */
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { env } from "./config/env.js";
import { createHttpApp } from "./http/routes.js";
import { logger } from "./observability/logger.js";
import { attachSocketServer } from "./ws/socket.js";

const app = createHttpApp();
const httpServer = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, () => {
  logger.info({ host: env.HOST, port: env.PORT }, "Nexus Chat server started");
});

attachSocketServer(httpServer as unknown as HttpServer);
