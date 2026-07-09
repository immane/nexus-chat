/**
 * NotificationBot — /announce command handler
 *
 * Responds to "/announce <text>" by posting a formatted announcement
 * to the channel where the command was invoked.
 *
 * Related Modules:
 * - packages/bot-sdk: NexusBotClient base class
 * - packages/bots/help: similar command-based bot pattern
 */
import { NexusBotClient } from "@nexus-chat/bot-sdk";
import type { BotManifest } from "@nexus-chat/shared";

export const manifest: BotManifest = {
  id: "bot_notification",
  name: "NotificationBot",
  description: "Posts admin-authorized workspace announcements.",
  commands: [],
  scopes: ["messages:write", "channels:read"]
};

export const announcement = (text: string) => `[Announcement] ${text}`;

export const createNotificationBot = (options: { baseUrl: string; token: string }) => {
  const bot = new NexusBotClient({ ...options, manifest });

  bot.onEvent("bot.command.invoke", async (event) => {
    const payload = event.payload as { command?: string; args?: string; userId?: string; channelId?: string } | undefined;
    const isAnnounce = payload?.command === "/announce";
    const text = payload?.args?.trim();
    if (isAnnounce && text && payload?.channelId) {
      await bot.sendMessage({
        workspaceId: event.workspaceId,
        channelId: payload.channelId,
        clientMsgId: `announce-${Date.now()}`,
        content: { type: "text", text: announcement(text), attachments: [] }
      });
    }
  });

  return bot;
};
