/**
 * Database Client
 *
 * Responsibilities:
 * - Creates a PostgreSQL connection pool via pg
 * - Exposes a Drizzle ORM instance with the full schema
 *
 * Does NOT:
 * - Handle connection lifecycle (pg.Pool manages this internally)
 * - Run migrations (handled via drizzle-kit CLI or seed script)
 *
 * Invariants:
 * - Schema import must be kept in sync with table definitions in schema.ts
 * - Pool is lazily initialized — first query triggers connection
 *
 * Related Modules:
 * - schema.ts: table definitions passed to drizzle()
 * - seed.ts: uses db directly for test data insertion
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool, { schema });
