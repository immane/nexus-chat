import { describe, expect, it } from "vitest";
import type { BotManifest, Message } from "@nexus-chat/shared";
import { createOptimisticMessage, getCommandSuggestions, getPolicyLabel, selectChannelMessages, useMessageStore } from "./domain.js";

const baseMessage: Message = {
  id: "message-test-1",
  workspaceId: "workspace-test-1",
  channelId: "channel-test-1",
  senderId: "user-test-1",
  clientMsgId: "client-test-1",
  content: { type: "text", text: "hello", attachments: [] },
  state: "sent",
  createdAt: "2026-07-05T00:00:00.000Z"
};

describe("web domain stores", () => {
  it("normalizes messages by id and preserves insertion order", () => {
    useMessageStore.getState().clear();
    useMessageStore.getState().upsert(baseMessage);
    useMessageStore.getState().upsert({ ...baseMessage, content: { type: "text", text: "edited", attachments: [] } });

    const state = useMessageStore.getState();
    expect(state.order).toEqual([baseMessage.id]);
    expect(state.messages.get(baseMessage.id)?.content).toEqual({ type: "text", text: "edited", attachments: [] });
  });

  it("selects messages for the active channel only", () => {
    const otherMessage: Message = { ...baseMessage, id: "message-test-2", channelId: "channel-other-1", clientMsgId: "client-test-2" };
    const messages = new Map<string, Message>([
      [baseMessage.id, baseMessage],
      [otherMessage.id, otherMessage]
    ]);

    expect(selectChannelMessages(messages, [baseMessage.id, otherMessage.id], baseMessage.channelId)).toEqual([baseMessage]);
  });

  it("creates optimistic E2E metadata for read-once and TTL messages", () => {
    const readOnce = createOptimisticMessage({ workspaceId: "workspace-test-1", channelId: "channel-test-1", senderId: "user-test-1", text: "secret", policy: { mode: "read_once" } });
    const ttl = createOptimisticMessage({ workspaceId: "workspace-test-1", channelId: "channel-test-1", senderId: "user-test-1", text: "secret", policy: { mode: "ttl", ttlSeconds: 300 } });

    expect(readOnce.content.type).toBe("ciphertext");
    expect(readOnce.content.type === "ciphertext" ? readOnce.content.readOnce : false).toBe(true);
    expect(ttl.content.type === "ciphertext" ? ttl.content.expiresAt : undefined).toBeDefined();
    expect(getPolicyLabel({ mode: "ttl", ttlSeconds: 300 })).toBe("Expires after 5 min");
  });
});

describe("bot command autocomplete", () => {
  it("builds slash command suggestions from bot manifests", () => {
    const manifests: BotManifest[] = [
      {
        id: "bot-help-1",
        name: "help",
        description: "Help bot",
        commands: [{ name: "/help", description: "Show help" }],
        scopes: ["commands:handle"]
      },
      {
        id: "bot-notify-1",
        name: "notification",
        description: "Notification bot",
        commands: [{ name: "/announce", description: "Announce" }],
        scopes: ["commands:handle"]
      }
    ];

    expect(getCommandSuggestions(manifests, "/h")).toEqual([{ name: "/help", description: "Show help", botName: "help", botId: "bot-help-1" }]);
    expect(getCommandSuggestions(manifests, "hello")).toEqual([]);
  });
});
