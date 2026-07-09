/**
 * Bot Engine Service
 *
 * Responsibilities:
 * - Bot installation with opaque nxbot_v1_... token generation (SHA-256 hashed in store)
 * - Token validation against stored hash
 * - Channel membership management (bots cannot join E2E channels)
 * - Event subscription management (per-bot event type allow-list)
 * - Command invocation dispatch (/help built-in handler, event publication)
 * - Bot message sending (scoped to channels where the bot is a member)
 * - Event polling for bot WebSocket connections
 *
 * Key Design Decisions:
 * - Built-in /help is handled inline in invokeCommand rather than as a separate bot
 *   because it's the only command that needs to work even before any bot is installed.
 * - Bot tokens use "nxbot_v1_" prefix for easy identification in logs and debugging.
 * - Events are delivered via polling (pendingEvents queue) rather than push, because
 *   the WebSocket connection may not be established at the time the event fires.
 * - Bots are explicitly excluded from E2E channels — they see only normal channels.
 *
 * Does NOT:
 * - Parse or execute bot command arguments (returns raw args to bot)
 * - Handle WebSocket connections (owned by ws/socket.ts)
 * - Rate-limit bot event dispatch (owned by ws gateway)
 */
import { createHash, randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { apiFail, botEventSchema, nowIso, type BotEvent, type BotManifest, type Message, type SendMessageInput } from "@nexus-chat/shared";
import { store } from "../store.js";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export type BotMessageResult = Message | ReturnType<typeof apiFail>;

export const botService = {
  install(actorId: string, workspaceId: string, manifest: BotManifest) {
    const token = `nxbot_v1_${randomBytes(32).toString("base64url")}`;
    const bot = { id: manifest.id, workspaceId, manifest, tokenHash: hashToken(token), channelIds: new Set<string>(), subscribedEvents: new Set<string>(), pendingEvents: [] };
    store.bots.set(bot.id, bot);
    store.auditLogs.push({ id: createId(), actorUserId: actorId, workspaceId, action: "bot.installed", metadata: { botId: bot.id }, createdAt: nowIso() });
    return { bot, token };
  },

  validateToken(token: string) {
    const tokenHash = hashToken(token);
    return [...store.bots.values()].find((bot) => bot.tokenHash === tokenHash);
  },

  addToChannel(botId: string, channelId: string) {
    const bot = store.bots.get(botId);
    const channel = store.channels.get(channelId);
    if (!bot || !channel) return apiFail("NOT_FOUND", "Bot or channel not found");
    if (channel.mode === "e2e") return apiFail("E2E_BOT_NOT_ALLOWED", "Bots cannot join E2E channels");
    bot.channelIds.add(channelId);
    return { botId, channelId };
  },

  removeFromChannel(botId: string, channelId: string) {
    const bot = store.bots.get(botId);
    if (!bot || !store.channels.has(channelId)) return apiFail("NOT_FOUND", "Bot or channel not found");
    if (!bot.channelIds.has(channelId)) return apiFail("NOT_FOUND", "Bot is not a member of this channel");
    bot.channelIds.delete(channelId);
    return { botId, channelId };
  },

  subscribe(botId: string, eventType: string) {
    const bot = store.bots.get(botId);
    if (!bot) return apiFail("NOT_FOUND", "Bot not found");
    bot.subscribedEvents.add(eventType);
    return { botId, subscribed: true };
  },

  unsubscribe(botId: string, eventType: string) {
    const bot = store.bots.get(botId);
    if (!bot) return apiFail("NOT_FOUND", "Bot not found");
    bot.subscribedEvents.delete(eventType);
    return { botId, unsubscribed: true };
  },

  getSubscriptions(botId: string): string[] {
    const bot = store.bots.get(botId);
    return bot ? [...bot.subscribedEvents] : [];
  },

  invokeCommand(input: { workspaceId: string; channelId: string; userId: string; command: string; args: string }) {
    const channel = store.channels.get(input.channelId);
    if (!channel || channel.mode === "e2e") return apiFail("E2E_BOT_NOT_ALLOWED", "Bot commands are disabled in E2E channels");
    const event = this.publishEvent({ type: "bot.command.invoke", workspaceId: input.workspaceId, channelId: input.channelId, payload: input });

    // Handle built-in /help command inline
    if (input.command === "/help" || input.command === "help") {
      const helpBot = [...store.bots.values()].find((b) => b.workspaceId === input.workspaceId && b.manifest.commands.some((c) => c.name === "/help"));
      if (helpBot) {
        const botMsgId = createId();
        const commands = helpBot.manifest.commands.map((c) => `${c.name} — ${c.description}`).join("\n");
        store.messages.set(botMsgId, {
          id: botMsgId, workspaceId: input.workspaceId, channelId: input.channelId,
          senderId: helpBot.id, clientMsgId: `bot-${botMsgId}`,
          content: { type: "text", text: `Available commands:\n${commands}`, attachments: [] },
          state: "sent", createdAt: nowIso()
        });
        return { type: "bot.response", payload: { botId: helpBot.id, messageId: botMsgId, text: `Available commands:\n${commands}` } };
      }
    }

    return event;
  },

  publishEvent(input: Omit<BotEvent, "id" | "createdAt">): BotEvent {
    const event = botEventSchema.parse({ ...input, id: createId(), createdAt: nowIso() });
    this.dispatchToBots(event);
    return event;
  },

  dispatchToBots(event: BotEvent): void {
    for (const bot of store.bots.values()) {
      if (bot.subscribedEvents.has(event.type) && bot.channelIds.has(event.channelId ?? "")) {
        bot.pendingEvents.push(event);
      }
    }
  },

  pollEvents(botId: string, limit = 50): BotEvent[] {
    const bot = store.bots.get(botId);
    if (!bot) return [];
    const events = bot.pendingEvents.splice(0, limit);
    return events;
  },

  canBotWriteToChannel(botId: string, channelId: string): boolean {
    const bot = store.bots.get(botId);
    if (!bot) return false;
    const manifest = bot.manifest as BotManifest;
    if (!manifest.scopes.includes("messages:write")) return false;
    return bot.channelIds.has(channelId);
  },

  sendBotMessage(botId: string, input: SendMessageInput): BotMessageResult {
    const bot = store.bots.get(botId);
    if (!bot) return apiFail("NOT_FOUND", "Bot not found");
    const channel = store.channels.get(input.channelId);
    if (!channel) return apiFail("NOT_FOUND", "Channel not found");
    if (channel.mode === "e2e") return apiFail("E2E_BOT_NOT_ALLOWED", "Bots cannot send messages in E2E channels");
    if (!this.canBotWriteToChannel(botId, input.channelId)) return apiFail("FORBIDDEN", "Bot lacks write scope or channel membership for this channel");
    const message = {
      id: createId(),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      senderId: botId,
      clientMsgId: input.clientMsgId,
      content: input.content,
      state: "sent" as const,
      createdAt: nowIso()
    };
    store.messages.set(message.id, message);
    store.messagesByClientId.set(`${botId}:${input.clientMsgId}`, message.id);
    return message;
  }
};
