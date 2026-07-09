/**
 * Prometheus Metrics
 *
 * Defines and registers all application-level metrics. Exposed at GET /metrics
 * via the registry and consumed by the HTTP routes module.
 *
 * Metrics:
 * - nexus_http_requests_total (counter, labels: method, route, status)
 * - nexus_ws_connections_active (gauge — current WS connection count)
 * - nexus_message_sends_total (counter, labels: mode — normal/e2e)
 * - nexus_auth_failures_total (counter, labels: reason)
 * - nexus_bot_event_queue_depth (gauge — pending bot events)
 * - nexus_redis_errors_total (counter — Redis operation failures)
 *
 * Default metrics (process, CPU, memory, GC, event loop lag) are collected
 * automatically via collectDefaultMetrics.
 */
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequests = new client.Counter({
  name: "nexus_http_requests_total",
  help: "HTTP requests by method, route, and status",
  labelNames: ["method", "route", "status"]
});

export const wsConnections = new client.Gauge({
  name: "nexus_ws_connections_active",
  help: "Active WebSocket connections"
});

export const messageSends = new client.Counter({
  name: "nexus_message_sends_total",
  help: "Messages accepted by mode",
  labelNames: ["mode"]
});

export const authFailures = new client.Counter({
  name: "nexus_auth_failures_total",
  help: "Authentication failures by reason",
  labelNames: ["reason"]
});

export const botEventQueueDepth = new client.Gauge({
  name: "nexus_bot_event_queue_depth",
  help: "Bot event queue depth"
});

export const redisErrors = new client.Counter({
  name: "nexus_redis_errors_total",
  help: "Redis operation errors"
});

registry.registerMetric(httpRequests);
registry.registerMetric(wsConnections);
registry.registerMetric(messageSends);
registry.registerMetric(authFailures);
registry.registerMetric(botEventQueueDepth);
registry.registerMetric(redisErrors);
