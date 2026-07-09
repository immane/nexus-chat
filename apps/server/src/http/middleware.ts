/**
 * HTTP Middleware Stack
 *
 * Three middleware functions applied (via app.use) to every request:
 *
 * requestContext:
 *   - Generates or preserves x-request-id for traceability
 *   - Logs incoming requests
 *   - Increments Prometheus HTTP counter on response
 *
 * securityHeaders:
 *   - Sets nosniff, DENY frame-options, no-referrer, and strict CSP
 *   - CSP allows 'self' and websocket connections (ws: wss:) for Socket.IO
 *
 * authRequired:
 *   - Guards routes by validating Bearer JWT access tokens
 *   - Sets userId on the Hono context for downstream handlers
 *   - Returns 401 AUTH_REQUIRED when token is missing or invalid
 *
 * Dependencies:
 * - jwt (imported from domain/auth/service.ts for verifyAccessToken)
 * - prom-client (for httpRequests counter)
 *
 * Forbidden Dependencies:
 * - Domain service logic (middleware should never call business logic)
 */
import type { Context, Next } from "hono";
import { createId } from "@paralleldrive/cuid2";
import { apiFail } from "@nexus-chat/shared";
import { logger } from "../observability/logger.js";
import { httpRequests } from "../observability/metrics.js";
import { verifyAccessToken } from "../domain/auth/service.js";

export type AppVariables = { userId: string; requestId: string };

export const requestContext = async (c: Context, next: Next) => {
  const requestId = c.req.header("x-request-id") ?? createId();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);
  logger.info({ requestId, method: c.req.method, path: c.req.path }, "request arrived");
  await next();
  httpRequests.inc({ method: c.req.method, route: c.req.routePath || c.req.path, status: String(c.res.status) });
};

export const securityHeaders = async (c: Context, next: Next) => {
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "no-referrer");
  c.header("content-security-policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  await next();
};

export const authRequired = async (c: Context<{ Variables: AppVariables }>, next: Next) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const userId = token ? verifyAccessToken(token) : null;
  if (!userId) return c.json(apiFail("AUTH_REQUIRED", "Authentication required"), 401);
  c.set("userId", userId);
  await next();
};
