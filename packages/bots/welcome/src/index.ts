import { NexusBotClient } from "@nexus-chat/bot-sdk";
import type { BotManifest } from "@nexus-chat/shared";

export const manifest: BotManifest = {
  id: "bot_welcome",
  name: "WelcomeBot",
  description: "Sends onboarding messages when members join a workspace.",
  commands: [],
  scopes: ["messages:write", "channels:read"]
};

export const welcomeMessage = (displayName: string) => `Welcome to Nexus Chat, ${displayName}. Start in #general or open a DM.`;

export const createWelcomeBot = (options: { baseUrl: string; token: string }) => {
  const bot = new NexusBotClient({ ...options, manifest });

  bot.onEvent("workspace.member_added", async (event) => {
    const member = event.payload as { userId?: string; displayName?: string };
    const channelId = event.channelId ?? "";
    if (member.displayName && channelId) {
      await bot.sendMessage({
        workspaceId: event.workspaceId,
        channelId,
        clientMsgId: `welcome-${member.userId}-${Date.now()}`,
        content: { type: "text", text: welcomeMessage(member.displayName), attachments: [] }
      });
    }
  });

  return bot;
};
