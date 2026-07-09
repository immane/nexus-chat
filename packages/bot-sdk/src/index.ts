/**
 * Bot SDK — NexusBotClient Reference Implementation
 *
 * Provides a WebSocket + REST hybrid client for Nexus Chat bots.
 * Bots connect to the server's /bots Socket.IO namespace for event delivery,
 * and use REST endpoints for message sending and channel queries.
 *
 * Key Features:
 * - Automatic reconnection with exponential backoff (max 10 retries, 30s cap)
 * - Middleware pipeline for cross-cutting concerns (logging, rate limiting)
 * - Command-specific and event-type handler registration
 * - Token redaction utility for safe logging
 *
 * Event Flow:
 * 1. Bot calls connect() → WebSocket connects to /bots namespace
 * 2. Server pushes events via "bot.event" messages as they occur
 * 3. Client dispatches through middleware chain → matching handler
 * 4. Bot responds via sendMessage() (REST POST /api/v1/bots/messages)
 * 5. On disconnect, reconnect manager schedules retry with backoff
 *
 * Does NOT:
 * - Handle message encryption (bots are excluded from E2E channels)
 * - Provide rate-limit handling beyond the retry-after header
 * - Manage bot installation or token lifecycle
 *
 * Related Modules:
 * - Server: ws/socket.ts (/bots namespace), domain/bots/service.ts
 * - packages/bots/help, notification, welcome: example bot implementations
 *
 * @see docs/design/03_bot-engine-microservices.md
 */
import { io, type Socket } from "socket.io-client";
import type { BotEvent, BotManifest, SendMessageInput } from "@nexus-chat/shared";

export type BotClientOptions = { baseUrl: string; token: string; manifest: BotManifest };
export type BotCommandHandler = (event: BotEvent) => Promise<void> | void;
export type BotEventHandler = (event: BotEvent) => Promise<void> | void;
export type BotMiddleware = (event: BotEvent, next: () => Promise<void>) => Promise<void>;

/**
 * Exponential backoff reconnect manager.
 *
 * Formula: min(baseDelayMs * 2^attempt, maxDelayMs) + random(0, 500)ms jitter.
 * Jitter prevents thundering herd when multiple bots reconnect simultaneously.
 * Returns null when maxRetries is exhausted — the caller should stop retrying.
 */
export const createReconnectManager = (options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {}) => {
  const maxRetries = options.maxRetries ?? 10;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  let attempt = 0;

  return {
    nextDelay(): number | null {
      if (attempt >= maxRetries) return null;
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      attempt += 1;
      return delay + Math.floor(Math.random() * 500);
    },
    reset() { attempt = 0; },
    get attempt() { return attempt; }
  };
};

export class NexusBotClient {
  private socket?: Socket;
  private commandHandlers = new Map<string, BotCommandHandler>();
  private eventHandlers = new Map<string, BotEventHandler>();
  private middlewares: BotMiddleware[] = [];
  private reconnectManager = createReconnectManager();

  constructor(private readonly options: BotClientOptions) {}

  connect() {
    this.attachSocket();
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket?.removeAllListeners();
  }

  /**
   * Generic event registration with "slash_command" alias.
   *
   * The "slash_command" string maps to the "bot.command.invoke" event type
   * internally — this is the canonical event for bot command invocation.
   * Both on() and onEvent() can be used to listen for this and other events.
   */
  on(event: string, handler: BotEventHandler | BotCommandHandler) {
    if (typeof handler === "function") {
      if (event === "slash_command") {
        this.eventHandlers.set("bot.command.invoke", handler);
      } else {
        this.eventHandlers.set(event, handler);
      }
    }
  }

  onCommand(command: string, handler: BotCommandHandler) {
    this.commandHandlers.set(command, handler);
  }

  onEvent(eventType: string, handler: BotEventHandler) {
    this.eventHandlers.set(eventType, handler);
  }

  use(middleware: BotMiddleware) {
    this.middlewares.push(middleware);
  }

  async sendMessage(input: SendMessageInput) {
    const response = await fetch(`${this.options.baseUrl}/api/v1/bots/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` },
      body: JSON.stringify(input)
    });
    if (response.status === 429) throw new Error(`Rate limited, retry after ${response.headers.get("retry-after") ?? "unknown"}`);
    return response.json();
  }

  async getChannelInfo(workspaceId: string, channelId: string) {
    const response = await fetch(`${this.options.baseUrl}/api/v1/workspaces/${workspaceId}/channels`, {
      headers: { authorization: `Bearer ${this.options.token}` }
    });
    const data = (await response.json()) as { ok: boolean; data: Array<{ id: string }> };
    if (data.ok) return data.data.find((ch) => ch.id === channelId) ?? null;
    return null;
  }

  async subscribe(eventType: string) {
    await fetch(`${this.options.baseUrl}/api/v1/bots/subscriptions?eventType=${encodeURIComponent(eventType)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` }
    });
  }

  async unsubscribe(eventType: string) {
    await fetch(`${this.options.baseUrl}/api/v1/bots/subscriptions?eventType=${encodeURIComponent(eventType)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}` }
    });
  }

  private attachSocket() {
    this.socket = io(`${this.options.baseUrl}/bots`, {
      transports: ["websocket"],
      auth: { token: this.options.token },
      reconnection: false
    });

    this.socket.on("bot.event", (event: BotEvent) => void this.dispatch(event));

    this.socket.on("connect", () => {
      this.reconnectManager.reset();
    });

    this.socket.on("disconnect", () => {
      const delay = this.reconnectManager.nextDelay();
      if (delay !== null) setTimeout(() => this.attachSocket(), delay);
    });
  }

  /**
   * Middleware chain dispatcher.
   *
   * Command handlers (registered via onCommand) take priority over generic
   * event handlers (registered via onEvent/on). If a command matches, the
   * event-type handler is not called — only the most specific handler fires.
   *
   * Middleware is invoked as a recursive chain: each middleware calls next()
   * to pass control to the next one, with the final handler at the leaf.
   */
  private async dispatch(event: BotEvent) {
    const command = (event.payload as { command?: string }).command;
    const commandHandler = command ? this.commandHandlers.get(command) : undefined;
    const eventHandler = this.eventHandlers.get(event.type);
    const handler = commandHandler ?? eventHandler;
    if (!handler) return;
    let index = -1;
    const run = async (): Promise<void> => {
      index += 1;
      const middleware = this.middlewares[index];
      if (middleware) return middleware(event, run);
      await handler(event);
    };
    await run();
  }
}

/**
 * Strips nxbot_v1_ tokens from log output.
 *
 * Bot tokens (prefix "nxbot_v1_") are opaque random strings that should never
 * appear in plaintext logs. This helper replaces them with a [REDACTED] marker.
 * Use before piping any bot output to a log file or console.
 */
export const redactToken = (message: string) => message.replace(/nxbot_v1_[A-Za-z0-9_-]+/g, "nxbot_v1_[REDACTED]");
