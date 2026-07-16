/**
 * Database Seed Script
 *
 * Creates sample data for local development:
 * - 2 users (Ada Lovelace, Grace Hopper) with a known password
 * - 1 workspace ("Nexus Local")
 * - 1 normal channel ("general")
 * - 1 E2E DM between the two users
 *
 * Run via: pnpm --filter @nexus-chat/server seed
 *
 * Invariants:
 * - Uses onConflictDoNothing so it is safe to re-run
 * - Argon2id parameters match auth service defaults (memoryCost=65536, timeCost=3)
 */
import { createId } from "@paralleldrive/cuid2";
import { hash } from "@node-rs/argon2";
import { closeDb, getDb } from "./client.js";
import { channelMembers, channels, users, workspaceMembers, workspaces } from "./schema.js";

const db = await getDb();
const passwordHash = await hash("Password12345!", { memoryCost: 65536, timeCost: 3, parallelism: 4 });
const workspaceId = createId();
const adaId = createId();
const graceId = createId();
const channelId = createId();
const dmId = createId();

await db.insert(users).values([
  { id: adaId, email: "ada@example.com", displayName: "Ada Lovelace", passwordHash },
  { id: graceId, email: "grace@example.com", displayName: "Grace Hopper", passwordHash }
]).onConflictDoNothing();

await db.insert(workspaces).values({ id: workspaceId, name: "Nexus Local" }).onConflictDoNothing();
await db.insert(workspaceMembers).values([
  { workspaceId, userId: adaId, role: "owner" },
  { workspaceId, userId: graceId, role: "member" }
]).onConflictDoNothing();
await db.insert(channels).values([
  { id: channelId, workspaceId, name: "general", kind: "channel", mode: "normal", isPrivate: false },
  { id: dmId, workspaceId, name: `dm:${adaId}:${graceId}`, kind: "dm", mode: "e2e", isPrivate: true }
]).onConflictDoNothing();
await db.insert(channelMembers).values([
  { channelId, userId: adaId },
  { channelId, userId: graceId },
  { channelId: dmId, userId: adaId },
  { channelId: dmId, userId: graceId }
]).onConflictDoNothing();

await closeDb();
