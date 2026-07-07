import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default("http://localhost"),
  DATABASE_URL: z.string().default("postgres://nexus:nexus@localhost:5432/nexus_chat"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SESSION_STORE: z.enum(["memory", "redis"]).default("memory"),
  JWT_ISSUER: z.string().default("nexus-chat"),
  JWT_AUDIENCE: z.string().default("nexus-chat-clients"),
  JWT_PRIVATE_KEY_PEM: z.string().default(""),
  JWT_PUBLIC_KEY_PEM: z.string().default(""),
  JWT_KID: z.string().default("local-dev")
});

export const env = envSchema.parse(process.env);
