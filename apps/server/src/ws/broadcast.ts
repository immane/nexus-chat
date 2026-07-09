/**
 * WebSocket Broadcast Helpers
 *
 * Thin wrappers around Socket.IO's room-based emit that decouple the domain
 * services from the WS layer. Called by HTTP route handlers after mutations
 * to notify connected clients.
 *
 * Design Decision:
 * We use a module-level _io reference (set by setIO) rather than passing
 * the io instance through every route handler. This avoids threading the
 * server instance through the entire middleware/service chain.
 *
 * Room Naming Convention:
 * - channel:<channelId> — all members of a channel
 * - workspace:<workspaceId> — all members of a workspace
 *
 * Does NOT:
 * - Handle user-specific rooms (managed by socket.ts on connection)
 * - Validate room membership (caller must ensure proper access control)
 */
import type { Server } from "socket.io";

let _io: Server | undefined;

export const setIO = (io: Server) => { _io = io; };

export const broadcastToChannel = (channelId: string, event: unknown) => {
  if (_io) _io.to(`channel:${channelId}`).emit("event", event);
};

export const broadcastToWorkspace = (workspaceId: string, event: unknown) => {
  if (_io) _io.to(`workspace:${workspaceId}`).emit("event", event);
};
