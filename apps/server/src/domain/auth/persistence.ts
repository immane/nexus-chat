/**
 * Auth Persistence
 *
 * Owns durable user identity and audit-log storage.
 *
 * Responsibilities:
 * - Create user records with email-uniqueness enforcement
 * - Find users by id or email
 * - Append append-only audit entries
 *
 * Does NOT:
 * - Handle session tokens (delegated to session-store.ts)
 * - Perform password hashing or verification
 * - Authorize access to workspaces or channels
 *
 * Invariants:
 * - Email is unique across all users
 * - All methods are async for both in-memory and PostgreSQL backends
 * - Row mappers translate PostgreSQL timestamps to ISO 8601 strings
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI
 *
 * Future Evolution:
 * - Add updatedAt timestamps for user profile changes
 */
import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { auditLogs, users } from "../../db/schema.js";
import { store, type StoredUser } from "../store.js";

export type NewUser = StoredUser;

export interface UserPersistence {
  findByEmail(email: string): Promise<StoredUser | undefined>;
  findById(id: string): Promise<StoredUser | undefined>;
  /**
   * Inserts a user. Returns false when the email already exists.
   * Does NOT hash passwords — the service owns Argon2id.
   */
  create(user: NewUser): Promise<boolean>;
  /**
   * Appends an append-only audit entry.
   * Side Effect: writes to audit_logs table or store.auditLogs.
   */
  recordAudit(entry: { id: string; actorUserId?: string; action: string; metadata: unknown; createdAt: string }): Promise<void>;
}

export class InMemoryUserPersistence implements UserPersistence {
  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const id = store.usersByEmail.get(email);
    return id ? store.users.get(id) : undefined;
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    return store.users.get(id);
  }

  async create(user: NewUser): Promise<boolean> {
    if (store.usersByEmail.has(user.email)) return false;
    store.users.set(user.id, user);
    store.usersByEmail.set(user.email, user.id);
    return true;
  }

  async recordAudit(entry: { id: string; actorUserId?: string; action: string; metadata: unknown; createdAt: string }): Promise<void> {
    store.auditLogs.push(entry);
  }
}

const mapUser = (row: typeof users.$inferSelect): StoredUser => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  passwordHash: row.passwordHash,
  createdAt: row.createdAt.toISOString()
});

export class DrizzleUserPersistence implements UserPersistence {
  constructor(private readonly database: Database) {}

  async findByEmail(email: string): Promise<StoredUser | undefined> {
    const [row] = await this.database.select().from(users).where(eq(users.email, email)).limit(1);
    return row ? mapUser(row) : undefined;
  }

  async findById(id: string): Promise<StoredUser | undefined> {
    const [row] = await this.database.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? mapUser(row) : undefined;
  }

  async create(user: NewUser): Promise<boolean> {
    const result = await this.database.insert(users).values({ ...user, createdAt: new Date(user.createdAt), updatedAt: new Date(user.createdAt) }).onConflictDoNothing().returning({ id: users.id });
    return result.length === 1;
  }

  async recordAudit(entry: { id: string; actorUserId?: string; action: string; metadata: unknown; createdAt: string }): Promise<void> {
    await this.database.insert(auditLogs).values({ ...entry, actorUserId: entry.actorUserId ?? null, workspaceId: null, createdAt: new Date(entry.createdAt) });
  }
}

let persistence: UserPersistence | undefined;

/**
 * Selects InMemoryUserPersistence or DrizzleUserPersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getUserPersistence(): Promise<UserPersistence> {
  if (persistence) return persistence;
  if ((await import("../../config/env.js")).env.PERSISTENCE === "memory") return (persistence = new InMemoryUserPersistence());
  return (persistence = new DrizzleUserPersistence(await getDb()));
}
