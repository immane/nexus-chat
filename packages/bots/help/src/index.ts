import { NexusBotClient } from "@nexus-chat/bot-sdk";
import type { BotManifest } from "@nexus-chat/shared";

export const manifest: BotManifest = {
  id: "bot_help",
  name: "HelpBot",
  description: "Responds to /help with supported commands.",
  commands: [{ name: "/help", description: "Show available Nexus Chat commands." }],
  scopes: ["commands:handle", "messages:write"]
};

export const helpText = () => "Available commands: /help. Bots are disabled in E2EE channels.";

export const createHelpBot = (options: { baseUrl: string; token: string }) => {
  const bot = new NexusBotClient({ ...options, manifest });

  bot.onCommand("/help", async (event) => {
    const payload = event.payload as { userId?: string; channelId?: string } | undefined;
    if (payload?.channelId) {
      await bot.sendMessage({
        workspaceId: event.workspaceId,
        channelId: payload.channelId,
        clientMsgId: `help-${Date.now()}`,
        content: { type: "text", text: helpText(), attachments: [] }
      });
    }
  });

  return bot;
};
