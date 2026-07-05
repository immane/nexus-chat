import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { env } from "./config/env.js";
import { createHttpApp } from "./http/routes.js";
import { logger } from "./observability/logger.js";
import { attachSocketServer } from "./ws/socket.js";

const app = createHttpApp();
const httpServer = serve({ fetch: app.fetch, port: env.PORT }, () => {
  logger.info({ port: env.PORT }, "Nexus Chat server started");
});

attachSocketServer(httpServer as unknown as HttpServer);
