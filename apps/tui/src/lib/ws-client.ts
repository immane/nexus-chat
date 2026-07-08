import { io, type Socket } from "socket.io-client";
import type { Message, SendMessageInput, Channel } from "@nexus-chat/shared";
import { getAccessToken, apiBase } from "./api.js";

type WsEvent = { type: string; payload: unknown; timestamp: string };

export type WsEventHandlers = {
  onMessageCreated?: (message: Message) => void;
  onMessageUpdated?: (message: Message) => void;
  onMessageDeleted?: (message: Message) => void;
  onReaction?: (payload: { messageId: string; emoji: string; count: number; reacted: boolean; actorUserId?: string }) => void;
  onRead?: (payload: { messageId: string; readCount: number }) => void;
  onTyping?: (payload: { userId: string; channelId: string; typing: boolean }) => void;
  onPresence?: (payload: { userId: string; status: string }) => void;
  onChannelCreated?: (channel: Channel) => void;
  onDmCreated?: (channel: Channel) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onConnectError?: (err: Error) => void;
};

export const createSocket = (): Socket => {
  const socket = io(apiBase, {
    transports: ["websocket"],
    auth: { token: getAccessToken() },
    autoConnect: false
  });
  return socket;
};

export const sendMessage = (socket: Socket, input: SendMessageInput): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> =>
  new Promise((resolve) => {
    socket.emit(
      "event",
      {
        type: "message.send",
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        payload: input,
        timestamp: new Date().toISOString(),
        encrypted: false
      },
      (response: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => resolve(response)
    );
  });

export const sendTypingEvent = (socket: Socket, workspaceId: string, channelId: string, typing: boolean) => {
  if (!socket.connected) return;
  socket.emit("event", {
    type: typing ? "typing.start" : "typing.stop",
    workspaceId,
    channelId,
    payload: { workspaceId, channelId },
    timestamp: new Date().toISOString()
  });
};

export const sendBotCommand = (
  socket: Socket,
  workspaceId: string,
  channelId: string,
  command: string,
  args: string[]
): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> =>
  new Promise((resolve) => {
    socket.emit(
      "event",
      {
        type: "bot.command.invoke",
        workspaceId,
        channelId,
        payload: { type: "bot.command.invoke", botName: command.replace("/", ""), command, workspaceId, channelId, args },
        timestamp: new Date().toISOString(),
        encrypted: false
      },
      (response: { ok: boolean; data?: unknown; error?: { code: string; message: string } }) => resolve(response)
    );
  });

export const listenForAllEvents = (socket: Socket, handlers: WsEventHandlers) => {
  socket.on("event", (event: WsEvent) => {
    switch (event.type) {
      case "message.created":
        if (event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
          handlers.onMessageCreated?.(event.payload as Message);
        }
        break;
      case "message.updated":
        if (event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
          handlers.onMessageUpdated?.(event.payload as Message);
        }
        break;
      case "message.deleted":
        if (event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
          handlers.onMessageDeleted?.(event.payload as Message);
        }
        break;
      case "message.reaction":
        handlers.onReaction?.(event.payload as { messageId: string; emoji: string; count: number; reacted: boolean; actorUserId?: string });
        break;
      case "message.read":
        handlers.onRead?.(event.payload as { messageId: string; readCount: number });
        break;
      case "typing.updated":
        handlers.onTyping?.(event.payload as { userId: string; channelId: string; typing: boolean });
        break;
      case "presence.updated":
        handlers.onPresence?.(event.payload as { userId: string; status: string });
        break;
      case "channel.created":
        if (event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
          handlers.onChannelCreated?.(event.payload as Channel);
        }
        break;
      case "dm.created":
        if (event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
          handlers.onDmCreated?.(event.payload as Channel);
        }
        break;
    }
  });

  socket.on("connect", () => handlers.onConnect?.());
  socket.on("disconnect", () => handlers.onDisconnect?.());
  socket.on("connect_error", (err) => handlers.onConnectError?.(err));
};

export const listenForMessages = (socket: Socket, onMessage: (message: Message) => void) => {
  listenForAllEvents(socket, { onMessageCreated: onMessage });
};

export const sendPresenceUpdate = (socket: Socket, status: "online" | "away" | "offline") => {
  if (!socket.connected) return;
  socket.emit("event", {
    type: "presence.update",
    payload: { status },
    timestamp: new Date().toISOString()
  });
};
