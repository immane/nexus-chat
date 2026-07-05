import { io, type Socket } from "socket.io-client";
import type { Message, SendMessageInput } from "@nexus-chat/shared";
import { getAccessToken, apiBase } from "./api.js";

type WsEvent = { type: string; payload: unknown; timestamp: string };

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

export const listenForMessages = (socket: Socket, onMessage: (message: Message) => void) => {
  socket.on("event", (event: WsEvent) => {
    if (event.type === "message.created" && event.payload && typeof event.payload === "object" && "id" in (event.payload as Record<string, unknown>)) {
      onMessage(event.payload as Message);
    }
  });
};
