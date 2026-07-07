import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Channel, Message } from "@nexus-chat/shared";
import { ChannelList, MessageRow } from "./App.js";

const noop = vi.fn();
const noopAsync = vi.fn().mockResolvedValue(undefined);

const channels: Channel[] = [
  {
    id: "channel-general-1",
    workspaceId: "workspace-test-1",
    name: "general",
    kind: "channel",
    mode: "normal",
    isPrivate: false,
    createdAt: "2026-07-05T00:00:00.000Z"
  },
  {
    id: "channel-secret-1",
    workspaceId: "workspace-test-1",
    name: "secret-dm",
    kind: "dm",
    mode: "e2e",
    isPrivate: true,
    createdAt: "2026-07-05T00:00:00.000Z"
  }
];

describe("ChannelList", () => {
  it("renders channels, DMs, unread counts, and E2E badges", () => {
    const html = renderToStaticMarkup(<ChannelList channels={channels} activeChannelId="channel-general-1" unreadCounts={{ "channel-general-1": 3 }} onSelect={vi.fn()} />);

    expect(html).toContain("#general");
    expect(html).toContain("@secret-dm");
    expect(html).toContain("E2E");
    expect(html).toContain("3");
  });
});

const rowProps = { onReply: noop, onForward: noop, onEdit: noopAsync, onDelete: noop, onCopy: noop, onReact: noop, decryptedText: undefined as string | undefined, readCount: undefined as number | undefined, senderName: undefined as string | undefined };

describe("MessageRow", () => {
  it("renders normal text messages with optimistic send status", () => {
    const message: Message = {
      id: "message-test-1",
      workspaceId: "workspace-test-1",
      channelId: "channel-general-1",
      senderId: "user-test-1",
      clientMsgId: "client-test-1",
      content: { type: "text", text: "hello", attachments: [] },
      state: "sent",
      createdAt: "2026-07-05T00:00:00.000Z"
    };

    const html = renderToStaticMarkup(<MessageRow message={message} status="sending" {...rowProps} />);

    expect(html).toContain("hello");
    expect(html).toContain("sending");
  });

  it("renders expired-message tombstones", () => {
    const message: Message = {
      id: "message-test-2",
      workspaceId: "workspace-test-1",
      channelId: "channel-secret-1",
      senderId: "user-test-1",
      clientMsgId: "client-test-2",
      content: { type: "tombstone", reason: "expired" },
      state: "deleted",
      createdAt: "2026-07-05T00:00:00.000Z"
    };

    expect(renderToStaticMarkup(<MessageRow message={message} status={undefined} {...rowProps} />)).toContain("Message expired");
  });
});
