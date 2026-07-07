import type { Server } from "socket.io";

let _io: Server | undefined;

export const setIO = (io: Server) => { _io = io; };

export const broadcastToChannel = (channelId: string, event: unknown) => {
  if (_io) _io.to(`channel:${channelId}`).emit("event", event);
};
