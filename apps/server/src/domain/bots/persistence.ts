/**
 * Bot Persistence
 *
 * Owns bot integration, channel membership, and event subscription storage.
 *
 * Responsibilities:
 * - Persist bot installations with SHA-256 token hashes
 * - Manage bot channel membership (excluding E2E channels)
 * - Track per-bot event type subscriptions
 * - Query bots by channel + event type for dispatch targeting
 *
 * Does NOT:
 * - Store pending event delivery queues (process-local transient state)
 * - Enforce E2E channel restrictions (delegated to bot service)
 * - Handle token generation or hashing (delegated to bot service)
 *
 * Invariants:
 * - Bot installation provisions a non-login users row to satisfy
 *   the message sender foreign key (bot IDs are sender_id values)
 * - Token hashes are stored in bot_integrations.token_hash
 * - Channel memberships are idempotent via ON CONFLICT DO NOTHING
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI, messages
 *
 * Future Evolution:
 * - Add bot permission scope storage (currently in manifest.scopes)
 * - Add bot webhook URL routing for non-WebSocket delivery
 */
import { and, eq } from "drizzle-orm";
import type { BotManifest } from "@nexus-chat/shared";
import { getDb, type Database } from "../../db/client.js";
import {
  botChannelMemberships,
  botEventSubscriptions,
  botIntegrations,
  users
} from "../../db/schema.js";
import { store } from "../store.js";

export type DurableBot = {
  id: string;
  workspaceId: string;
  manifest: BotManifest;
  tokenHash: string;
  createdAt?: string;
};

export interface BotPersistence {
  create(bot: DurableBot): Promise<void>;
  find(id: string): Promise<DurableBot | undefined>;
  findByTokenHash(tokenHash: string): Promise<DurableBot | undefined>;
  addChannel(botId: string, channelId: string): Promise<void>;
  removeChannel(botId: string, channelId: string): Promise<boolean>;
  hasChannel(botId: string, channelId: string): Promise<boolean>;
  subscribe(botId: string, eventType: string): Promise<void>;
  unsubscribe(botId: string, eventType: string): Promise<boolean>;
  subscriptions(botId: string): Promise<string[]>;
  /**
   * Finds bots that are channel members and subscribed to the given event type.
   * Used by event dispatch.
   */
  matchingBots(channelId: string, eventType: string): Promise<DurableBot[]>;
  listByWorkspace(workspaceId: string): Promise<DurableBot[]>;
}

export class InMemoryBotPersistence implements BotPersistence {
  async create(bot: DurableBot) {
    store.bots.set(bot.id, {
      ...bot,
      channelIds: new Set(),
      subscribedEvents: new Set(),
      pendingEvents: []
    });
  }
  async find(id: string) {
    const bot = store.bots.get(id);
    return (
      bot && {
        id: bot.id,
        workspaceId: bot.workspaceId,
        manifest: bot.manifest,
        tokenHash: bot.tokenHash
      }
    );
  }
  async findByTokenHash(tokenHash: string) {
    const bot = [...store.bots.values()].find(
      (item) => item.tokenHash === tokenHash
    );
    return (
      bot && {
        id: bot.id,
        workspaceId: bot.workspaceId,
        manifest: bot.manifest,
        tokenHash: bot.tokenHash
      }
    );
  }
  async addChannel(botId: string, channelId: string) {
    store.bots.get(botId)?.channelIds.add(channelId);
  }
  async removeChannel(botId: string, channelId: string) {
    return store.bots.get(botId)?.channelIds.delete(channelId) ?? false;
  }
  async hasChannel(botId: string, channelId: string) {
    return store.bots.get(botId)?.channelIds.has(channelId) ?? false;
  }
  async subscribe(botId: string, eventType: string) {
    store.bots.get(botId)?.subscribedEvents.add(eventType);
  }
  async unsubscribe(botId: string, eventType: string) {
    return store.bots.get(botId)?.subscribedEvents.delete(eventType) ?? false;
  }
  async subscriptions(botId: string) {
    return [...(store.bots.get(botId)?.subscribedEvents ?? [])];
  }
  async matchingBots(channelId: string, eventType: string) {
    return [...store.bots.values()]
      .filter(
        (bot) =>
          bot.channelIds.has(channelId) && bot.subscribedEvents.has(eventType)
      )
      .map((bot) => ({
        id: bot.id,
        workspaceId: bot.workspaceId,
        manifest: bot.manifest,
        tokenHash: bot.tokenHash
      }));
  }
  async listByWorkspace(workspaceId: string) {
    return [...store.bots.values()]
      .filter((bot) => bot.workspaceId === workspaceId)
      .map((bot) => ({
        id: bot.id,
        workspaceId: bot.workspaceId,
        manifest: bot.manifest,
        tokenHash: bot.tokenHash
      }));
  }
}

export class DrizzleBotPersistence implements BotPersistence {
  constructor(private readonly database: Database) {}
  async create(bot: DurableBot) {
    await this.database.transaction(async (tx) => {
      // Bot IDs also serve as message sender_id values, therefore we must
      // provision a non-login users row so the message shelf FK is satisfied.
      await tx
        .insert(users)
        .values({
          id: bot.id,
          email: `bot+${bot.id}@nexus.invalid`,
          displayName: bot.manifest.name,
          passwordHash: "bot-identity-not-login-capable"
        })
        .onConflictDoNothing();
      await tx.insert(botIntegrations).values({
        id: bot.id,
        workspaceId: bot.workspaceId,
        manifest: bot.manifest,
        scopes: bot.manifest.scopes,
        tokenHash: bot.tokenHash
      });
    });
  }
  async find(id: string) {
    const [row] = await this.database
      .select()
      .from(botIntegrations)
      .where(eq(botIntegrations.id, id));
    return (
      row && {
        id: row.id,
        workspaceId: row.workspaceId,
        manifest: row.manifest as BotManifest,
        tokenHash: row.tokenHash,
        createdAt: row.createdAt.toISOString()
      }
    );
  }
  async findByTokenHash(tokenHash: string) {
    const [row] = await this.database
      .select()
      .from(botIntegrations)
      .where(eq(botIntegrations.tokenHash, tokenHash));
    return (
      row && {
        id: row.id,
        workspaceId: row.workspaceId,
        manifest: row.manifest as BotManifest,
        tokenHash: row.tokenHash,
        createdAt: row.createdAt.toISOString()
      }
    );
  }
  async addChannel(botId: string, channelId: string) {
    await this.database
      .insert(botChannelMemberships)
      .values({ botId, channelId })
      .onConflictDoNothing();
  }
  async removeChannel(botId: string, channelId: string) {
    return (
      (
        await this.database
          .delete(botChannelMemberships)
          .where(
            and(
              eq(botChannelMemberships.botId, botId),
              eq(botChannelMemberships.channelId, channelId)
            )
          )
          .returning()
      ).length > 0
    );
  }
  async hasChannel(botId: string, channelId: string) {
    return (
      (
        await this.database
          .select()
          .from(botChannelMemberships)
          .where(
            and(
              eq(botChannelMemberships.botId, botId),
              eq(botChannelMemberships.channelId, channelId)
            )
          )
          .limit(1)
      ).length > 0
    );
  }
  async subscribe(botId: string, eventType: string) {
    const existing = await this.database
      .select()
      .from(botEventSubscriptions)
      .where(
        and(
          eq(botEventSubscriptions.botId, botId),
          eq(botEventSubscriptions.eventType, eventType)
        )
      )
      .limit(1);
    if (!existing.length)
      await this.database
        .insert(botEventSubscriptions)
        .values({ id: `${botId}:${eventType}`, botId, eventType });
  }
  async unsubscribe(botId: string, eventType: string) {
    return (
      (
        await this.database
          .delete(botEventSubscriptions)
          .where(
            and(
              eq(botEventSubscriptions.botId, botId),
              eq(botEventSubscriptions.eventType, eventType)
            )
          )
          .returning()
      ).length > 0
    );
  }
  async subscriptions(botId: string) {
    return (
      await this.database
        .select({ eventType: botEventSubscriptions.eventType })
        .from(botEventSubscriptions)
        .where(eq(botEventSubscriptions.botId, botId))
    ).map((row) => row.eventType);
  }
  async matchingBots(channelId: string, eventType: string) {
    const rows = await this.database
      .select({ bot: botIntegrations })
      .from(botChannelMemberships)
      .innerJoin(
        botIntegrations,
        eq(botChannelMemberships.botId, botIntegrations.id)
      )
      .innerJoin(
        botEventSubscriptions,
        eq(botIntegrations.id, botEventSubscriptions.botId)
      )
      .where(
        and(
          eq(botChannelMemberships.channelId, channelId),
          eq(botEventSubscriptions.eventType, eventType)
        )
      );
    return rows.map(({ bot }) => ({
      id: bot.id,
      workspaceId: bot.workspaceId,
      manifest: bot.manifest as BotManifest,
      tokenHash: bot.tokenHash,
      createdAt: bot.createdAt.toISOString()
    }));
  }
  async listByWorkspace(workspaceId: string) {
    return (
      await this.database
        .select()
        .from(botIntegrations)
        .where(eq(botIntegrations.workspaceId, workspaceId))
    ).map((bot) => ({
      id: bot.id,
      workspaceId: bot.workspaceId,
      manifest: bot.manifest as BotManifest,
      tokenHash: bot.tokenHash,
      createdAt: bot.createdAt.toISOString()
    }));
  }
}

let persistence: BotPersistence | undefined;

/**
 * Selects InMemoryBotPersistence or DrizzleBotPersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getBotPersistence(): Promise<BotPersistence> {
  if (persistence) return persistence;
  if ((await import("../../config/env.js")).env.PERSISTENCE === "memory")
    return (persistence = new InMemoryBotPersistence());
  return (persistence = new DrizzleBotPersistence(await getDb()));
}
