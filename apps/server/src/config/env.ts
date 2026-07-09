/**
 * Environment Configuration
 *
 * Validates and exposes all runtime environment variables via a single Zod schema.
 * Every external dependency (DB, Redis, JWT) is configured here.
 *
 * Responsibilities:
 * - Parse and validate process.env at startup
 * - Provide typed access to configuration values
 *
 * Invariants:
 * - env is immutable after initialization
 * - All optional vars have sensible defaults for local development
 * - SESSION_STORE controls Redis vs in-memory session backend
 * - JWT keys default to auto-generated local RSA keypair when PEM vars are empty
 */
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_BASE: z.string().default("http://127.0.0.1:4000"),
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
