import type { BotManifest, Channel, Message, User, Workspace } from "@nexus-chat/shared";
import { useAuthStore, useBotStore, useChannelStore, useMessageStore, useWorkspaceStore } from "../stores/domain.js";

export const demoUser: User = {
  id: "user-demo-1",
  email: "demo@nexus.local",
  displayName: "Demo User",
  createdAt: "2026-07-05T00:00:00.000Z"
};

export const demoWorkspace: Workspace = {
  id: "workspace-demo-1",
  name: "Nexus HQ",
  createdAt: "2026-07-05T00:00:00.000Z"
};

export const demoChannels: Channel[] = [
  {
    id: "channel-general-1",
    workspaceId: demoWorkspace.id,
    name: "general",
    kind: "channel",
    mode: "normal",
    isPrivate: false,
    createdById: demoUser.id,
    createdAt: "2026-07-05T00:00:00.000Z"
  },
  {
    id: "channel-dm-e2e-1",
    workspaceId: demoWorkspace.id,
    name: "encrypted-dm",
    kind: "dm",
    mode: "e2e",
    isPrivate: true,
    createdById: demoUser.id,
    createdAt: "2026-07-05T00:00:00.000Z"
  }
];

export const demoManifests: BotManifest[] = [
  {
    id: "bot-help-1",
    name: "help",
    description: "Lists available commands.",
    commands: [{ name: "/help", description: "Show command help." }],
    scopes: ["commands:handle", "messages:write"]
  },
  {
    id: "bot-notification-1",
    name: "notification",
    description: "Sends generic workspace announcements.",
    commands: [{ name: "/announce", description: "Send an announcement." }],
    scopes: ["commands:handle", "messages:write"]
  }
];

export const demoMessages: Message[] = [
  {
    id: "message-welcome-1",
    workspaceId: demoWorkspace.id,
    channelId: "channel-general-1",
    senderId: "bot-welcome",
    clientMsgId: "seed-welcome-1",
    content: { type: "text", text: "Welcome to Nexus Chat. Try /help or switch to the encrypted DM.", attachments: [] },
    state: "sent",
    createdAt: "2026-07-05T00:00:00.000Z"
  },
  {
    id: "message-expired-1",
    workspaceId: demoWorkspace.id,
    channelId: "channel-dm-e2e-1",
    senderId: "peer-user-1",
    clientMsgId: "seed-expired-1",
    content: { type: "tombstone", reason: "expired" },
    state: "deleted",
    createdAt: "2026-07-05T00:01:00.000Z"
  }
];

export const seedDemoSession = () => {
  useAuthStore.getState().setSession({
    user: demoUser,
    tokens: { accessToken: "demo-access-token", refreshToken: "demo-refresh-token", expiresInSeconds: 900 }
  });
  useWorkspaceStore.getState().setWorkspaces([demoWorkspace]);
  useWorkspaceStore.getState().setActive(demoWorkspace.id);
  useChannelStore.getState().setChannels(demoChannels);
  useChannelStore.getState().setActive(demoChannels[0]?.id ?? "");
  useMessageStore.getState().clear();
  demoMessages.forEach((message) => useMessageStore.getState().upsert(message));
  useBotStore.getState().setManifests(demoManifests);
  useBotStore.getState().registerInputAction({
    id: "announcement-template",
    label: "Announcement",
    description: "Insert a generic bot command template.",
    command: "/announce "
  });
};
