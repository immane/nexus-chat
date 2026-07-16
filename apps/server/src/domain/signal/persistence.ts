/**
 * Signal / E2EE Persistence
 *
 * Owns pre-key bundle, one-time pre-key, and opaque session metadata storage.
 *
 * Responsibilities:
 * - Store and retrieve public pre-key bundles per user/device
 * - Allocate one-time pre-keys atomically with row locking
 * - Track one-time pre-key consumption state
 * - Persist opaque Signal session metadata
 *
 * Does NOT:
 * - Perform any cryptographic operations (client-side only)
 * - Validate key material beyond existence checks
 * - Manage token-based authentication or authorization
 *
 * Invariants:
 * - One-time pre-key allocation uses FOR UPDATE SKIP LOCKED in PostgreSQL
 *   to guarantee no two concurrent fetches consume the same key
 * - All methods are async for both backends
 * - Session metadata is stored as opaque JSON (server does not interpret)
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI
 *
 * Future Evolution:
 * - Add signed pre-key expiry and automatic deactivation
 * - Add multi-device session relay tables
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { signalOneTimePreKeys, signalPreKeyBundles, signalSessions } from "../../db/schema.js";
import { store, type SignalSessionRecord } from "../store.js";
import type { SignalPreKeyBundle } from "@nexus-chat/shared";

const key = (u: string, d: string) => `${u}:${d}`;

export interface SignalPersistence {
  /**
   * Uploads a pre-key bundle and optional one-time pre-keys.
   * In PostgreSQL, bundles are upserted and one-time keys are inserted or reactivated.
   */
  upload(
    bundle: SignalPreKeyBundle,
    keys?: Array<{ keyId: number; publicKey: string }>
  ): Promise<void>;
  /**
   * Fetches a bundle and atomically consumes one available one-time pre-key if present.
   * Returns the bundle with optional oneTimePreKeyId / oneTimePreKey fields.
   */
  takeBundle(userId: string, deviceId: string): Promise<SignalPreKeyBundle | undefined>;
  consume(
    userId: string,
    deviceId: string,
    keyId: number
  ): Promise<"missing" | "used" | "consumed">;
  count(userId: string, deviceId: string): Promise<number>;
  createSession(s: SignalSessionRecord): Promise<void>;
  session(id: string): Promise<SignalSessionRecord | undefined>;
  sessions(user: string): Promise<SignalSessionRecord[]>;
}

export class InMemorySignalPersistence implements SignalPersistence {
  async upload(b: SignalPreKeyBundle, ks?: Array<{ keyId: number; publicKey: string }>) {
    store.signalBundles.set(key(b.userId, b.deviceId), b);
    for (const p of ks ?? [])
      store.oneTimePreKeys.set(`${key(b.userId, b.deviceId)}:${p.keyId}`, {
        ...p,
        userId: b.userId,
        deviceId: b.deviceId
      });
  }
  async takeBundle(u: string, d: string) {
    const b = store.signalBundles.get(key(u, d));
    if (!b) return;
    const p = [...store.oneTimePreKeys.values()].find(
      (v) => v.userId === u && v.deviceId === d && !v.consumedAt
    );
    if (p) {
      p.consumedAt = new Date().toISOString();
      return { ...b, oneTimePreKeyId: p.keyId, oneTimePreKey: p.publicKey };
    }
    return b;
  }
  async consume(u: string, d: string, i: number) {
    const p = store.oneTimePreKeys.get(`${key(u, d)}:${i}`);
    if (!p) return "missing";
    if (p.consumedAt) return "used";
    p.consumedAt = new Date().toISOString();
    return "consumed";
  }
  async count(u: string, d: string) {
    return [...store.oneTimePreKeys.values()].filter(
      (p) => p.userId === u && p.deviceId === d && !p.consumedAt
    ).length;
  }
  async createSession(s: SignalSessionRecord) {
    store.signalSessions.set(s.id, s);
  }
  async session(i: string) {
    return store.signalSessions.get(i);
  }
  async sessions(u: string) {
    return [...store.signalSessions.values()].filter(
      (s) => s.ownerUserId === u || s.peerUserId === u
    );
  }
}

export class DrizzleSignalPersistence implements SignalPersistence {
  constructor(private readonly db: Database) {}
  async upload(
    b: SignalPreKeyBundle,
    ks?: Array<{ keyId: number; publicKey: string }>
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(signalPreKeyBundles)
        .values({ ...b, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: [signalPreKeyBundles.userId, signalPreKeyBundles.deviceId],
          set: {
            identityKey: b.identityKey,
            signedPreKeyId: b.signedPreKeyId,
            signedPreKey: b.signedPreKey,
            signedPreKeySignature: b.signedPreKeySignature,
            updatedAt: new Date()
          }
        });
      if (ks?.length)
        await tx
          .insert(signalOneTimePreKeys)
          .values(ks.map((p) => ({ ...p, userId: b.userId, deviceId: b.deviceId })))
          .onConflictDoUpdate({
            target: [
              signalOneTimePreKeys.userId,
              signalOneTimePreKeys.deviceId,
              signalOneTimePreKeys.keyId
            ],
            set: { publicKey: sql`excluded.public_key`, consumedAt: null }
          });
    });
  }
  async takeBundle(u: string, d: string) {
    return this.db.transaction(async (tx) => {
      const [b] = await tx
        .select()
        .from(signalPreKeyBundles)
        .where(
          and(eq(signalPreKeyBundles.userId, u), eq(signalPreKeyBundles.deviceId, d))
        );
      if (!b) return;
      // FOR UPDATE SKIP LOCKED ensures no two concurrent callers consume the same key.
      const result = await tx.execute(sql`
        WITH picked AS (
          SELECT key_id FROM signal_one_time_prekeys
          WHERE user_id=${u} AND device_id=${d} AND consumed_at IS NULL
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE signal_one_time_prekeys p SET consumed_at=now()
        FROM picked
        WHERE p.user_id=${u} AND p.device_id=${d} AND p.key_id=picked.key_id
        RETURNING p.key_id, p.public_key
      `);
      const p = result.rows[0] as { key_id: number; public_key: string } | undefined;
      const bundle = {
        userId: b.userId,
        deviceId: b.deviceId,
        identityKey: b.identityKey,
        signedPreKeyId: b.signedPreKeyId,
        signedPreKey: b.signedPreKey,
        signedPreKeySignature: b.signedPreKeySignature
      };
      return p
        ? { ...bundle, oneTimePreKeyId: p.key_id, oneTimePreKey: p.public_key }
        : bundle;
    });
  }
  async consume(u: string, d: string, i: number) {
    const [consumed] = await this.db
      .update(signalOneTimePreKeys)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(signalOneTimePreKeys.userId, u),
          eq(signalOneTimePreKeys.deviceId, d),
          eq(signalOneTimePreKeys.keyId, i),
          isNull(signalOneTimePreKeys.consumedAt)
        )
      )
      .returning({ keyId: signalOneTimePreKeys.keyId });
    if (consumed) return "consumed";

    const [existing] = await this.db
      .select({ consumedAt: signalOneTimePreKeys.consumedAt })
      .from(signalOneTimePreKeys)
      .where(
        and(
          eq(signalOneTimePreKeys.userId, u),
          eq(signalOneTimePreKeys.deviceId, d),
          eq(signalOneTimePreKeys.keyId, i)
        )
      );
    return existing ? "used" : "missing";
  }
  async count(u: string, d: string) {
    const [r] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(signalOneTimePreKeys)
      .where(
        and(
          eq(signalOneTimePreKeys.userId, u),
          eq(signalOneTimePreKeys.deviceId, d),
          isNull(signalOneTimePreKeys.consumedAt)
        )
      );
    return r?.count ?? 0;
  }
  async createSession(s: SignalSessionRecord) {
    await this.db.insert(signalSessions).values({ ...s, updatedAt: new Date(s.updatedAt) });
  }
  async session(i: string) {
    const [row] = await this.db
      .select()
      .from(signalSessions)
      .where(eq(signalSessions.id, i));
    return row && { ...row, updatedAt: row.updatedAt.toISOString() } as SignalSessionRecord;
  }
  async sessions(u: string) {
    return (await this.db
      .select()
      .from(signalSessions)
      .where(
        eq(signalSessions.ownerUserId, u)
      )).map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() } as SignalSessionRecord));
  }
}

let p: SignalPersistence | undefined;

/**
 * Selects InMemorySignalPersistence or DrizzleSignalPersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getSignalPersistence() {
  if (p) return p;
  if ((await import("../../config/env.js")).env.PERSISTENCE === "memory")
    return (p = new InMemorySignalPersistence());
  return (p = new DrizzleSignalPersistence(await getDb()));
}
