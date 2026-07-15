/**
 * Bot Engine Service
 *
 * Owns bot installation, token validation, command routing, and event dispatch.
 *
 * Responsibilities:
 * - Install bots with opaque nxbot_v1_ token issuance and SHA-256 hash storage
 * - Validate bot tokens for WebSocket and HTTP authentication
 * - Manage bot channel membership (excluding E2E channels)
 * - Route slash commands and publish domain events to subscribed bots
 * - Handle built-in /help command with inline response
 * - Persist bot-authored messages through MessagePersistence
 *
 * Does NOT:
 * - Store pending event delivery queues (process-local Map, future Redis Streams)
 * - Handle WebSocket connections directly (delegated to ws/socket.ts)
 * - Parse or execute bot command arguments beyond dispatch
 * - Own message lifecycle-critical data
 *
 * Invariants:
 * - Bots are excluded from E2E channels at the service boundary
 * - Bot tokens use "nxbot_v1_" prefix for auditability
 * - /help matching searches by manifest.commands, not by bot name
 * - Bot-authored messages are persisted via MessagePersistence to satisfy
 *   the message sender foreign key (bots provision a users row at install)
 *
 * Dependencies:
 * - BotPersistence (in-memory or PostgreSQL)
 * - MessagePersistence (for bot-authored messages)
 * - workspacePersistenceService (channel/membership access checks)
 *
 * Related Modules:
 * - persistence.ts: BotPersistence interface and adapters
 * - ws/socket.ts: WebSocket connection lifecycle and /bots namespace
 */
import { createHash, randomBytes } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import {
  apiFail,
  botEventSchema,
  nowIso,
  type BotEvent,
  type BotManifest,
  type Message,
  type SendMessageInput
} from "@nexus-chat/shared";
import { workspacePersistenceService } from "../workspaces/persistence-service.js";
import { getMessagePersistence } from "../messages/persistence.js";
import { getBotPersistence, type DurableBot } from "./persistence.js";

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const pendingEvents = new Map<string, BotEvent[]>();
const enqueue = (botId: string, event: BotEvent) =>
  pendingEvents.set(botId, [...(pendingEvents.get(botId) ?? []), event]);

export const botService = {
  async install(_actorId: string, workspaceId: string, manifest: BotManifest) {
    const token = `nxbot_v1_${randomBytes(32).toString("base64url")}`;
    const bot: DurableBot = {
      id: manifest.id,
      workspaceId,
      manifest,
      tokenHash: hashToken(token)
    };
    await (await getBotPersistence()).create(bot);
    return { bot, token };
  },
  async validateToken(token: string) {
    return (await getBotPersistence()).findByTokenHash(hashToken(token));
  },
  async addToChannel(botId: string, channelId: string) {
    const persistence = await getBotPersistence();
    const bot = await persistence.find(botId);
    const channel = await workspacePersistenceService.getChannel(channelId);
    if (!bot || !channel)
      return apiFail("NOT_FOUND", "Bot or channel not found");
    if (channel.mode === "e2e")
      return apiFail("E2E_BOT_NOT_ALLOWED", "Bots cannot join E2E channels");
    await persistence.addChannel(botId, channelId);
    return { botId, channelId };
  },
  async removeFromChannel(botId: string, channelId: string) {
    const persistence = await getBotPersistence();
    if (
      !(await persistence.find(botId)) ||
      !(await workspacePersistenceService.getChannel(channelId))
    )
      return apiFail("NOT_FOUND", "Bot or channel not found");
    return (await persistence.removeChannel(botId, channelId))
      ? { botId, channelId }
      : apiFail("NOT_FOUND", "Bot is not a member of this channel");
  },
  async subscribe(botId: string, eventType: string) {
    const persistence = await getBotPersistence();
    if (!(await persistence.find(botId)))
      return apiFail("NOT_FOUND", "Bot not found");
    await persistence.subscribe(botId, eventType);
    return { botId, subscribed: true };
  },
  async unsubscribe(botId: string, eventType: string) {
    const persistence = await getBotPersistence();
    if (!(await persistence.find(botId)))
      return apiFail("NOT_FOUND", "Bot not found");
    await persistence.unsubscribe(botId, eventType);
    return { botId, unsubscribed: true };
  },
  async getSubscriptions(botId: string) {
    return (await getBotPersistence()).subscriptions(botId);
  },
  async invokeCommand(input: {
    workspaceId: string;
    channelId: string;
    userId: string;
    command: string;
    args: string;
  }) {
    const channel = await workspacePersistenceService.getChannel(
      input.channelId
    );
    if (!channel || channel.mode === "e2e")
      return apiFail(
        "E2E_BOT_NOT_ALLOWED",
        "Bot commands are disabled in E2E channels"
      );
    const event = await this.publishEvent({
      type: "bot.command.invoke",
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      payload: input
    });
    if (input.command === "/help" || input.command === "help") {
      const helpBot = (
        await (await getBotPersistence()).listByWorkspace(input.workspaceId)
      ).find((bot) =>
        bot.manifest.commands.some((command) => command.name === "/help")
      );
      if (helpBot) {
        const id = createId(),
          text = `Available commands:\n${helpBot.manifest.commands.map((command) => `${command.name} - ${command.description}`).join("\n")}`;
        const message = {
          id,
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          senderId: helpBot.id,
          clientMsgId: `bot-${id}`,
          content: { type: "text" as const, text, attachments: [] },
          state: "sent" as const,
          createdAt: nowIso()
        };
        await (await getMessagePersistence()).create(message, []);
        return {
          type: "bot.response",
          payload: { botId: helpBot.id, messageId: id, text }
        };
      }
    }
    return event;
  },
  async publishEvent(input: Omit<BotEvent, "id" | "createdAt">) {
    const event = botEventSchema.parse({
      ...input,
      id: createId(),
      createdAt: nowIso()
    });
    for (const bot of await (
      await getBotPersistence()
    ).matchingBots(event.channelId ?? "", event.type))
      enqueue(bot.id, event);
    return event;
  },
  pollEvents(botId: string, limit = 50) {
    const events = pendingEvents.get(botId) ?? [];
    const result = events.slice(0, limit);
    pendingEvents.set(botId, events.slice(limit));
    return result;
  },
  async canBotWriteToChannel(botId: string, channelId: string) {
    const bot = await (await getBotPersistence()).find(botId);
    return Boolean(
      bot?.manifest.scopes.includes("messages:write") &&
      (await (await getBotPersistence()).hasChannel(botId, channelId))
    );
  },
  async sendBotMessage(
    botId: string,
    input: SendMessageInput
  ): Promise<Message | ReturnType<typeof apiFail>> {
    const bot = await (await getBotPersistence()).find(botId),
      channel = await workspacePersistenceService.getChannel(input.channelId);
    if (!bot || !channel)
      return apiFail("NOT_FOUND", "Bot or channel not found");
    if (channel.mode === "e2e")
      return apiFail(
        "E2E_BOT_NOT_ALLOWED",
        "Bots cannot send messages in E2E channels"
      );
    if (!(await this.canBotWriteToChannel(botId, input.channelId)))
      return apiFail(
        "FORBIDDEN",
        "Bot lacks write scope or channel membership for this channel"
      );
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
    return (await getMessagePersistence()).create(message, []);
  }
};
