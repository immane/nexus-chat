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
 * - SOCKET_IO_ADAPTER controls local vs Redis-backed Socket.IO room broadcasts
 * - PERSISTENCE controls in-memory vs PostgreSQL persistence backend
 * - Production forces PERSISTENCE=postgres and requires DATABASE_URL
 * - Production forbids DB_MIGRATE_ON_BOOT (migrations run via CI/deployment job)
 * - JWT keys default to auto-generated local RSA keypair when PEM vars are empty
 */
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(4000),
    API_PUBLIC_BASE: z.string().default("http://127.0.0.1:4000"),
    WEB_ORIGIN: z.string().default("http://localhost"),
    DATABASE_URL: z.string().trim().url().optional(),
    REDIS_URL: z.string().default("redis://localhost:6379"),
    PERSISTENCE: z.enum(["memory", "postgres"]).optional(),
    DB_MIGRATE_ON_BOOT: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    SESSION_STORE: z.enum(["memory", "redis"]).default("memory"),
    SOCKET_IO_ADAPTER: z.enum(["memory", "redis"]).default("memory"),
    JWT_ISSUER: z.string().default("nexus-chat"),
    JWT_AUDIENCE: z.string().default("nexus-chat-clients"),
    JWT_PRIVATE_KEY_PEM: z.string().default(""),
    JWT_PUBLIC_KEY_PEM: z.string().default(""),
    JWT_KID: z.string().default("local-dev")
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && value.PERSISTENCE !== "postgres") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PERSISTENCE"], message: "PERSISTENCE=postgres is required in production" });
    }
    if (value.PERSISTENCE === "postgres" && !value.DATABASE_URL) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DATABASE_URL"], message: "DATABASE_URL is required when PERSISTENCE=postgres" });
    }
    if (value.NODE_ENV === "production" && value.DB_MIGRATE_ON_BOOT) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DB_MIGRATE_ON_BOOT"], message: "DB_MIGRATE_ON_BOOT must be false in production" });
    }
  })
  .transform((value) => ({
    ...value,
    DATABASE_URL: value.DATABASE_URL ?? "postgres://nexus:nexus@localhost:5432/nexus_chat",
    PERSISTENCE: value.PERSISTENCE ?? "memory"
  }));

export const env = envSchema.parse(process.env);
