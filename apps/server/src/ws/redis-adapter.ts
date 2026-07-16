/**
 * Socket.IO Redis Adapter
 *
 * The adapter distributes Socket.IO room broadcasts across server instances.
 * It is intentionally opt-in so local development does not require Redis.
 */
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import type { Server } from "socket.io";
import { env } from "../config/env.js";
import { logger } from "../observability/logger.js";

export type SocketIoAdapterCleanup = () => Promise<void>;

export async function configureSocketIoAdapter(io: Server, mode = env.SOCKET_IO_ADAPTER): Promise<SocketIoAdapterCleanup> {
  if (mode === "memory") return async () => {};

  const pubClient = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const subClient = pubClient.duplicate();

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Socket.IO Redis adapter enabled");
  } catch (error) {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    throw error;
  }

  return async () => {
    await Promise.allSettled([pubClient.quit(), subClient.quit()]);
  };
}
