/**
 * Workspace Persistence
 *
 * Owns workspace, membership, channel, and mute persistence.
 *
 * Responsibilities:
 * - Create workspaces and channels in a single transaction
 * - Manage workspace membership and RBAC roles
 * - Manage channel membership lifecycle
 * - Persist per-user channel mute preferences
 * - Resolve deterministic DM channels by composite uniqueness
 *
 * Does NOT:
 * - Enforce access-control rules (delegated to persistence-service.ts)
 * - Handle message data (separate MessagePersistence)
 * - Broadcast real-time events (delegated to WebSocket gateway)
 *
 * Invariants:
 * - Workspace creation is atomic: workspace + owner membership + general channel + channel membership
 * - DM names are deterministic: sorted user IDs ensure idempotent lookup
 * - Row mappers translate PostgreSQL timestamps to ISO 8601 strings
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI, messages
 *
 * Future Evolution:
 * - Add workspace slug uniqueness enforcement at DB level
 * - Add channel member invite metadata (inviter, timestamp)
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Channel, Workspace, WorkspaceMember, WorkspaceRole } from "@nexus-chat/shared";
import { getDb, type Database } from "../../db/client.js";
import { channelMembers, channels, users, workspaceMembers, workspaces } from "../../db/schema.js";
import { store } from "../store.js";

const memberKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;
const channelMemberKey = (channelId: string, userId: string) => `${channelId}:${userId}`;
const mapWorkspace = (row: typeof workspaces.$inferSelect): Workspace => ({ id: row.id, name: row.name, createdAt: row.createdAt.toISOString() });
const mapChannel = (row: typeof channels.$inferSelect): Channel => ({ id: row.id, workspaceId: row.workspaceId, name: row.name, description: row.description ?? undefined, kind: row.kind, mode: row.mode, isPrivate: row.isPrivate, createdById: row.createdById ?? undefined, archivedAt: row.archivedAt?.toISOString(), deletedAt: row.deletedAt?.toISOString(), createdAt: row.createdAt.toISOString() });

export interface WorkspacePersistence {
  /**
   * Creates workspace, owner membership, and default general channel atomically.
   */
  createWorkspace(input: { workspace: Workspace; owner: WorkspaceMember; channel: Channel }): Promise<void>;
  findWorkspace(id: string): Promise<Workspace | undefined>;
  listWorkspaces(userId: string): Promise<Workspace[]>;
  getRole(userId: string, workspaceId: string): Promise<WorkspaceRole | undefined>;
  updateWorkspace(id: string, name: string): Promise<Workspace | undefined>;
  upsertMember(member: WorkspaceMember): Promise<void>;
  /**
   * Deletes workspace member and all related channel memberships atomically.
   */
  deleteMemberAndChannelMemberships(workspaceId: string, userId: string): Promise<boolean>;
  listMembers(workspaceId: string): Promise<Array<WorkspaceMember & { email: string; displayName: string }>>;
  updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMember | undefined>;
  findChannel(id: string): Promise<Channel | undefined>;
  listChannels(workspaceId: string): Promise<Channel[]>;
  /**
   * Creates a channel and adds initial members. Returns undefined on name conflict.
   */
  createChannel(channel: Channel, memberIds: string[]): Promise<Channel | undefined>;
  /**
   * Creates a DM or returns the existing one by workspace + name uniqueness.
   * Guarantees both members exist after completion.
   */
  createOrGetDm(channel: Channel, memberIds: string[]): Promise<Channel>;
  upsertChannelMember(channelId: string, userId: string): Promise<void>;
  deleteChannelMember(channelId: string, userId: string): Promise<boolean>;
  listChannelMembers(channelId: string): Promise<Array<{ channelId: string; userId: string }>>;
  updateChannel(channel: Channel): Promise<Channel>;
  isMuted(userId: string, channelId: string): Promise<boolean>;
  setMuted(userId: string, channelId: string, muted: boolean): Promise<void>;
}

export class InMemoryWorkspacePersistence implements WorkspacePersistence {
  async createWorkspace({ workspace, owner, channel }: { workspace: Workspace; owner: WorkspaceMember; channel: Channel }): Promise<void> { store.workspaces.set(workspace.id, workspace); store.workspaceMembers.set(memberKey(owner.workspaceId, owner.userId), owner); store.channels.set(channel.id, channel); store.channelMembers.set(channelMemberKey(channel.id, owner.userId), { channelId: channel.id, userId: owner.userId }); }
  async findWorkspace(id: string) { return store.workspaces.get(id); }
  async listWorkspaces(userId: string) { return [...store.workspaceMembers.values()].filter((member) => member.userId === userId).flatMap((member) => store.workspaces.get(member.workspaceId) ?? []); }
  async getRole(userId: string, workspaceId: string) { return store.workspaceMembers.get(memberKey(workspaceId, userId))?.role; }
  async updateWorkspace(id: string, name: string) { const workspace = store.workspaces.get(id); if (!workspace) return undefined; const updated = { ...workspace, name }; store.workspaces.set(id, updated); return updated; }
  async upsertMember(member: WorkspaceMember) { store.workspaceMembers.set(memberKey(member.workspaceId, member.userId), member); }
  async deleteMemberAndChannelMemberships(workspaceId: string, userId: string) { for (const [key, member] of store.channelMembers) if (member.userId === userId && store.channels.get(member.channelId)?.workspaceId === workspaceId) store.channelMembers.delete(key); return store.workspaceMembers.delete(memberKey(workspaceId, userId)); }
  async listMembers(workspaceId: string) { return [...store.workspaceMembers.values()].filter((member) => member.workspaceId === workspaceId).map((member) => ({ ...member, email: store.users.get(member.userId)?.email ?? "", displayName: store.users.get(member.userId)?.displayName ?? "" })); }
  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole) { const member = store.workspaceMembers.get(memberKey(workspaceId, userId)); if (!member) return undefined; const updated = { ...member, role }; store.workspaceMembers.set(memberKey(workspaceId, userId), updated); return updated; }
  async findChannel(id: string) { return store.channels.get(id); }
  async listChannels(workspaceId: string) { return [...store.channels.values()].filter((channel) => channel.workspaceId === workspaceId); }
  async createChannel(channel: Channel, memberIds: string[]) { if ([...store.channels.values()].some((item) => item.workspaceId === channel.workspaceId && item.name === channel.name)) return undefined; store.channels.set(channel.id, channel); for (const userId of memberIds) store.channelMembers.set(channelMemberKey(channel.id, userId), { channelId: channel.id, userId }); return channel; }
  async createOrGetDm(channel: Channel, memberIds: string[]) { const existing = [...store.channels.values()].find((item) => item.workspaceId === channel.workspaceId && item.name === channel.name); if (existing) return existing; store.channels.set(channel.id, channel); for (const userId of memberIds) store.channelMembers.set(channelMemberKey(channel.id, userId), { channelId: channel.id, userId }); return channel; }
  async upsertChannelMember(channelId: string, userId: string) { store.channelMembers.set(channelMemberKey(channelId, userId), { channelId, userId }); }
  async deleteChannelMember(channelId: string, userId: string) { return store.channelMembers.delete(channelMemberKey(channelId, userId)); }
  async listChannelMembers(channelId: string) { return [...store.channelMembers.values()].filter((member) => member.channelId === channelId); }
  async updateChannel(channel: Channel) { store.channels.set(channel.id, channel); return channel; }
  async isMuted(userId: string, channelId: string) { return store.channelMutes.get(userId)?.has(channelId) ?? false; }
  async setMuted(userId: string, channelId: string, muted: boolean) { const mutes = store.channelMutes.get(userId) ?? new Set<string>(); if (muted) mutes.add(channelId); else mutes.delete(channelId); store.channelMutes.set(userId, mutes); }
}

export class DrizzleWorkspacePersistence implements WorkspacePersistence {
  constructor(private readonly database: Database) {}
  async createWorkspace({ workspace, owner, channel }: { workspace: Workspace; owner: WorkspaceMember; channel: Channel }): Promise<void> { await this.database.transaction(async (tx) => { await tx.insert(workspaces).values({ ...workspace, createdAt: new Date(workspace.createdAt) }); await tx.insert(workspaceMembers).values(owner); await tx.insert(channels).values({ ...channel, description: channel.description ?? null, createdById: channel.createdById ?? null, archivedAt: null, deletedAt: null, createdAt: new Date(channel.createdAt) }); await tx.insert(channelMembers).values({ channelId: channel.id, userId: owner.userId }); }); }
  async findWorkspace(id: string) { const [row] = await this.database.select().from(workspaces).where(eq(workspaces.id, id)); return row && mapWorkspace(row); }
  async listWorkspaces(userId: string) { return (await this.database.select({ workspace: workspaces }).from(workspaceMembers).innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id)).where(eq(workspaceMembers.userId, userId))).map(({ workspace }) => mapWorkspace(workspace)); }
  async getRole(userId: string, workspaceId: string) { const [row] = await this.database.select({ role: workspaceMembers.role }).from(workspaceMembers).where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId))); return row?.role; }
  async updateWorkspace(id: string, name: string) { const [row] = await this.database.update(workspaces).set({ name }).where(eq(workspaces.id, id)).returning(); return row && mapWorkspace(row); }
  async upsertMember(member: WorkspaceMember) { await this.database.insert(workspaceMembers).values(member).onConflictDoUpdate({ target: [workspaceMembers.workspaceId, workspaceMembers.userId], set: { role: member.role } }); }
  async deleteMemberAndChannelMemberships(workspaceId: string, userId: string) { return this.database.transaction(async (tx) => { const workspaceChannels = await tx.select({ id: channels.id }).from(channels).where(eq(channels.workspaceId, workspaceId)); if (workspaceChannels.length) await tx.delete(channelMembers).where(and(eq(channelMembers.userId, userId), inArray(channelMembers.channelId, workspaceChannels.map((channel) => channel.id)))); const result = await tx.delete(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).returning(); return result.length > 0; }); }
  async listMembers(workspaceId: string) { return this.database.select({ workspaceId: workspaceMembers.workspaceId, userId: workspaceMembers.userId, role: workspaceMembers.role, email: users.email, displayName: users.displayName }).from(workspaceMembers).innerJoin(users, eq(workspaceMembers.userId, users.id)).where(eq(workspaceMembers.workspaceId, workspaceId)); }
  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole) { const [row] = await this.database.update(workspaceMembers).set({ role }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId))).returning(); return row; }
  async findChannel(id: string) { const [row] = await this.database.select().from(channels).where(eq(channels.id, id)); return row && mapChannel(row); }
  async listChannels(workspaceId: string) { return (await this.database.select().from(channels).where(eq(channels.workspaceId, workspaceId))).map(mapChannel); }
  async createChannel(channel: Channel, memberIds: string[]) { return this.database.transaction(async (tx) => { const [row] = await tx.insert(channels).values({ ...channel, description: channel.description ?? null, createdById: channel.createdById ?? null, archivedAt: channel.archivedAt ? new Date(channel.archivedAt) : null, deletedAt: channel.deletedAt ? new Date(channel.deletedAt) : null, createdAt: new Date(channel.createdAt) }).onConflictDoNothing().returning(); if (!row) return undefined; if (memberIds.length) await tx.insert(channelMembers).values(memberIds.map((userId) => ({ channelId: channel.id, userId }))).onConflictDoNothing(); return mapChannel(row); }); }
  async createOrGetDm(channel: Channel, memberIds: string[]) {
    return this.database.transaction(async (tx) => {
      const [created] = await tx
        .insert(channels)
        .values({
          ...channel,
          description: channel.description ?? null,
          createdById: channel.createdById ?? null,
          archivedAt: channel.archivedAt ? new Date(channel.archivedAt) : null,
          deletedAt: channel.deletedAt ? new Date(channel.deletedAt) : null,
          createdAt: new Date(channel.createdAt)
        })
        .onConflictDoNothing()
        .returning();
      const existing = created ?? (await tx
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, channel.workspaceId), eq(channels.name, channel.name))))[0];
      if (!existing) throw new Error("DM conflict did not return an existing channel");
      await tx
        .insert(channelMembers)
        .values(memberIds.map((userId) => ({ channelId: existing.id, userId })))
        .onConflictDoNothing();
      return mapChannel(existing);
    });
  }
  async upsertChannelMember(channelId: string, userId: string) { await this.database.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing(); }
  async deleteChannelMember(channelId: string, userId: string) { return (await this.database.delete(channelMembers).where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId))).returning()).length > 0; }
  async listChannelMembers(channelId: string) { return this.database.select({ channelId: channelMembers.channelId, userId: channelMembers.userId }).from(channelMembers).where(eq(channelMembers.channelId, channelId)); }
  async updateChannel(channel: Channel) { const [row] = await this.database.update(channels).set({ name: channel.name, description: channel.description ?? null, archivedAt: channel.archivedAt ? new Date(channel.archivedAt) : null, deletedAt: channel.deletedAt ? new Date(channel.deletedAt) : null }).where(eq(channels.id, channel.id)).returning(); return mapChannel(row!); }
  async isMuted(userId: string, channelId: string) { const { channelMutes } = await import("../../db/schema.js"); return (await this.database.select().from(channelMutes).where(and(eq(channelMutes.userId, userId), eq(channelMutes.channelId, channelId))).limit(1)).length > 0; }
  async setMuted(userId: string, channelId: string, muted: boolean) { const { channelMutes } = await import("../../db/schema.js"); if (muted) await this.database.insert(channelMutes).values({ userId, channelId }).onConflictDoNothing(); else await this.database.delete(channelMutes).where(and(eq(channelMutes.userId, userId), eq(channelMutes.channelId, channelId))); }
}

let persistence: WorkspacePersistence | undefined;

/**
 * Selects InMemoryWorkspacePersistence or DrizzleWorkspacePersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getWorkspacePersistence(): Promise<WorkspacePersistence> { if (persistence) return persistence; if ((await import("../../config/env.js")).env.PERSISTENCE === "memory") return (persistence = new InMemoryWorkspacePersistence()); return (persistence = new DrizzleWorkspacePersistence(await getDb())); }
