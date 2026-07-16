/**
 * Database Client
 *
 * Responsibilities:
 * - Lazily creates a PostgreSQL connection pool and Drizzle ORM instance
 * - Exposes database readiness, migration, and shutdown lifecycle methods
 *
 * Does NOT:
 * - Create a pool when PERSISTENCE=memory
 *
 * Invariants:
 * - Schema import must be kept in sync with table definitions in schema.ts
 * - No pool is allocated unless PostgreSQL persistence is selected
 *
 * Related Modules:
 * - schema.ts: table definitions passed to drizzle()
 * - seed.ts: uses db directly for test data insertion
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pool: pg.Pool | undefined;
let db: Database | undefined;

function requirePostgres(): void {
  if (env.PERSISTENCE !== "postgres") throw new Error("PostgreSQL persistence is not enabled");
}

function getPool(): pg.Pool {
  requirePostgres();
  pool ??= new pg.Pool({ connectionString: env.DATABASE_URL });
  return pool;
}

export async function getDb(): Promise<Database> {
  db ??= drizzle(getPool(), { schema });
  return db;
}

export async function pingDb(): Promise<void> {
  await getPool().query("SELECT 1");
}

export async function runMigrations(): Promise<void> {
  const database = await getDb();
  await migrate(database, { migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle") });
}

export async function closeDb(): Promise<void> {
  const currentPool = pool;
  pool = undefined;
  db = undefined;
  await currentPool?.end();
}
