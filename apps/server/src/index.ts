/**
 * Server Entry Point (Phase 1 Monolith)
 *
 * Responsibilities:
 * - Creates the HTTP app (REST API via Hono)
 * - Attaches the Socket.IO WebSocket server
 * - Binds to the configured host and port
 *
 * Does NOT:
 * - Run database migrations in production
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
import { closeDb, pingDb, runMigrations } from "./db/client.js";
import { createHttpApp } from "./http/routes.js";
import { logger } from "./observability/logger.js";
import { attachSocketServer } from "./ws/socket.js";

async function start(): Promise<void> {
  if (env.PERSISTENCE === "postgres") {
    if (env.DB_MIGRATE_ON_BOOT) await runMigrations();
    await pingDb();
  }

  const app = createHttpApp();
  const httpServer = serve({ fetch: app.fetch, hostname: env.HOST, port: env.PORT }, () => {
    logger.info({ host: env.HOST, port: env.PORT }, "Nexus Chat server started");
  });

  attachSocketServer(httpServer as unknown as HttpServer);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    httpServer.close((error) => {
      void closeDb().finally(() => process.exit(error ? 1 : 0));
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void start().catch((error: unknown) => {
  logger.error({ err: error }, "Nexus Chat server failed to start");
  void closeDb().finally(() => process.exit(1));
});
