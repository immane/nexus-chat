import { createId } from "@paralleldrive/cuid2";
import { apiFail, nowIso, type Channel, type ChannelMode, type Workspace, type WorkspaceMember, type WorkspaceRole } from "@nexus-chat/shared";
import { store } from "../store.js";

const memberKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;
const channelMemberKey = (channelId: string, userId: string) => `${channelId}:${userId}`;

export const workspaceService = {
  createWorkspace(actorId: string, name: string): Workspace {
    const workspace = { id: createId(), name, createdAt: nowIso() };
    store.workspaces.set(workspace.id, workspace);
    store.workspaceMembers.set(memberKey(workspace.id, actorId), { workspaceId: workspace.id, userId: actorId, role: "owner" });
    const defaultChannel = { id: createId(), workspaceId: workspace.id, name: "general", kind: "channel" as const, mode: "normal" as const, isPrivate: false, createdById: actorId, createdAt: nowIso() };
    store.channels.set(defaultChannel.id, defaultChannel);
    store.channelMembers.set(channelMemberKey(defaultChannel.id, actorId), { channelId: defaultChannel.id, userId: actorId });
    return workspace;
  },
  updateWorkspace(actorId: string, workspaceId: string, name: string): Workspace | ReturnType<typeof apiFail> {
    const role = this.getRole(actorId, workspaceId);
    if (role !== "owner" && role !== "admin") return apiFail("FORBIDDEN", "Only owners and admins can update workspaces");
    const workspace = store.workspaces.get(workspaceId);
    if (!workspace) return apiFail("NOT_FOUND", "Workspace not found");
    const updated = { ...workspace, name };
    store.workspaces.set(workspaceId, updated);
    return updated;
  },
  listWorkspaces(actorId: string): Workspace[] {
    const ids = [...store.workspaceMembers.values()].filter((m) => m.userId === actorId).map((m) => m.workspaceId);
    return ids.flatMap((id) => store.workspaces.get(id) ?? []);
  },
  getWorkspace(actorId: string, workspaceId: string): Workspace | undefined {
    return this.canAccessWorkspace(actorId, workspaceId) ? store.workspaces.get(workspaceId) : undefined;
  },
  canAccessWorkspace(userId: string, workspaceId: string): boolean {
    return store.workspaceMembers.has(memberKey(workspaceId, userId));
  },
  getRole(userId: string, workspaceId: string): WorkspaceRole | undefined {
    return store.workspaceMembers.get(memberKey(workspaceId, userId))?.role;
  },
  addMember(actorId: string, workspaceId: string, userId: string, role: WorkspaceRole): WorkspaceMember | ReturnType<typeof apiFail> {
    const actorRole = this.getRole(actorId, workspaceId);
    if (actorRole !== "owner" && actorRole !== "admin") return apiFail("FORBIDDEN", "Only owners and admins can add members");
    if (role === "owner" && actorRole !== "owner") return apiFail("FORBIDDEN", "Only owners can add another owner");
    const member = { workspaceId, userId, role };
    store.workspaceMembers.set(memberKey(workspaceId, userId), member);
    store.auditLogs.push({ id: createId(), actorUserId: actorId, workspaceId, action: "workspace.member_added", metadata: { userId, role }, createdAt: nowIso() });
    return member;
  },
  removeMember(actorId: string, workspaceId: string, userId: string): boolean | ReturnType<typeof apiFail> {
    const actorRole = this.getRole(actorId, workspaceId);
    if (actorRole !== "owner" && actorRole !== "admin") return apiFail("FORBIDDEN", "Only owners and admins can remove members");
    const targetRole = this.getRole(userId, workspaceId);
    if (targetRole === "owner" && actorId !== userId) return apiFail("FORBIDDEN", "Owners cannot be removed by another member");
    if (actorRole === "admin" && targetRole === "admin") return apiFail("FORBIDDEN", "Admins cannot remove other admins");
    for (const [key, member] of store.channelMembers.entries()) {
      const channel = store.channels.get(member.channelId);
      if (member.userId === userId && channel?.workspaceId === workspaceId) store.channelMembers.delete(key);
    }
    return store.workspaceMembers.delete(memberKey(workspaceId, userId));
  },
  listMembers(_actorId: string, workspaceId: string): Array<{ workspaceId: string; userId: string; role: string; email: string; displayName: string }> {
    return [...store.workspaceMembers.values()]
      .filter((m) => m.workspaceId === workspaceId)
      .map((m) => {
        const user = store.users.get(m.userId);
        return { ...m, email: user?.email ?? "", displayName: user?.displayName ?? "" };
      });
  },
  transferOwnership(actorId: string, workspaceId: string, newOwnerUserId: string): WorkspaceMember | ReturnType<typeof apiFail> {
    if (this.getRole(actorId, workspaceId) !== "owner") return apiFail("FORBIDDEN", "Only owners can transfer ownership");
    const target = store.workspaceMembers.get(memberKey(workspaceId, newOwnerUserId));
    if (!target) return apiFail("NOT_FOUND", "New owner must be a workspace member");
    const previousOwner = store.workspaceMembers.get(memberKey(workspaceId, actorId));
    if (previousOwner) store.workspaceMembers.set(memberKey(workspaceId, actorId), { ...previousOwner, role: "admin" });
    const newOwner = { ...target, role: "owner" as const };
    store.workspaceMembers.set(memberKey(workspaceId, newOwnerUserId), newOwner);
    return newOwner;
  },
  createChannel(actorId: string, workspaceId: string, name: string, mode: ChannelMode, isPrivate: boolean): Channel | ReturnType<typeof apiFail> {
    if (!this.canAccessWorkspace(actorId, workspaceId)) return apiFail("FORBIDDEN", "Workspace access denied");
    const duplicate = [...store.channels.values()].find((channel) => channel.workspaceId === workspaceId && channel.kind === "channel" && channel.name === name && !channel.deletedAt);
    if (duplicate) return apiFail("CONFLICT", "Channel name already exists in workspace");
    const channel = { id: createId(), workspaceId, name, kind: "channel" as const, mode, isPrivate, createdById: actorId, createdAt: nowIso() };
    store.channels.set(channel.id, channel);
    store.channelMembers.set(channelMemberKey(channel.id, actorId), { channelId: channel.id, userId: actorId });
    if (mode === "e2e") store.auditLogs.push({ id: createId(), actorUserId: actorId, workspaceId, action: "channel.mode_created_e2e", metadata: { channelId: channel.id }, createdAt: nowIso() });
    return channel;
  },
  listChannels(actorId: string, workspaceId: string): Channel[] {
    if (!this.canAccessWorkspace(actorId, workspaceId)) return [];
    return [...store.channels.values()].filter((channel) => channel.workspaceId === workspaceId && !channel.deletedAt && this.canAccessChannel(actorId, channel.id));
  },
  addChannelMember(actorId: string, channelId: string, userId: string): ReturnType<typeof apiFail> | { channelId: string; userId: string } {
    const channel = store.channels.get(channelId);
    if (!channel || !this.canAccessWorkspace(actorId, channel.workspaceId)) return apiFail("FORBIDDEN", "Channel access denied");
    if (channel.archivedAt || channel.deletedAt) return apiFail("FORBIDDEN", "Cannot modify archived or deleted channel");
    if (channel.mode === "e2e" && store.bots.has(userId)) return apiFail("E2E_BOT_NOT_ALLOWED", "Bots cannot join E2E channels");
    if (!this.canManageChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Only channel creators and workspace admins can add members");
    store.channelMembers.set(channelMemberKey(channelId, userId), { channelId, userId });
    store.auditLogs.push({ id: createId(), actorUserId: actorId, workspaceId: channel.workspaceId, action: "channel.member_added", metadata: { channelId, userId }, createdAt: nowIso() });
    return { channelId, userId };
  },
  removeChannelMember(actorId: string, channelId: string, userId: string): boolean | ReturnType<typeof apiFail> {
    const channel = store.channels.get(channelId);
    if (!channel || !this.canAccessWorkspace(actorId, channel.workspaceId)) return apiFail("FORBIDDEN", "Channel access denied");
    if (!this.canManageChannel(actorId, channelId) && actorId !== userId) return apiFail("FORBIDDEN", "Only channel creators and workspace admins can remove members");
    return store.channelMembers.delete(channelMemberKey(channelId, userId));
  },
  listChannelMembers(_actorId: string, channelId: string): Array<{ channelId: string; userId: string }> {
    return [...store.channelMembers.values()].filter((m) => m.channelId === channelId);
  },
  archiveChannel(actorId: string, channelId: string): Channel | ReturnType<typeof apiFail> {
    const channel = store.channels.get(channelId);
    if (!channel || !this.canManageChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Only channel creators and workspace admins can archive channels");
    const updated = { ...channel, archivedAt: nowIso() };
    store.channels.set(channelId, updated);
    return updated;
  },
  deleteChannel(actorId: string, channelId: string): Channel | ReturnType<typeof apiFail> {
    const channel = store.channels.get(channelId);
    if (!channel || !this.canManageChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Only channel creators and workspace admins can delete channels");
    const updated = { ...channel, deletedAt: nowIso() };
    store.channels.set(channelId, updated);
    return updated;
  },
  createOrGetDm(actorId: string, workspaceId: string, peerUserId: string, mode: ChannelMode): Channel | ReturnType<typeof apiFail> {
    if (!this.canAccessWorkspace(actorId, workspaceId) || !this.canAccessWorkspace(peerUserId, workspaceId)) return apiFail("FORBIDDEN", "Both users must be workspace members");
    const [a, b] = [actorId, peerUserId].sort();
    const name = `dm:${a}:${b}:${mode}`;
    const existing = [...store.channels.values()].find((channel) => channel.workspaceId === workspaceId && channel.kind === "dm" && channel.name === name);
    if (existing) return existing;
    const channel = { id: createId(), workspaceId, name, kind: "dm" as const, mode, isPrivate: true, createdAt: nowIso() };
    store.channels.set(channel.id, channel);
    store.channelMembers.set(channelMemberKey(channel.id, actorId), { channelId: channel.id, userId: actorId });
    store.channelMembers.set(channelMemberKey(channel.id, peerUserId), { channelId: channel.id, userId: peerUserId });
    return channel;
  },
  canAccessChannel(userId: string, channelId: string): boolean {
    const channel = store.channels.get(channelId);
    if (!channel || channel.deletedAt) return false;
    if (channel.kind === "channel" && !channel.isPrivate) return this.canAccessWorkspace(userId, channel.workspaceId);
    return store.channelMembers.has(channelMemberKey(channelId, userId));
  },
  canManageChannel(userId: string, channelId: string): boolean {
    const channel = store.channels.get(channelId);
    if (!channel) return false;
    const role = this.getRole(userId, channel.workspaceId);
    return channel.createdById === userId || role === "owner" || role === "admin";
  },
  muteChannel(actorId: string, channelId: string): { muted: true } | ReturnType<typeof apiFail> {
    if (!this.canAccessChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Channel access denied");
    if (!store.channelMutes.has(actorId)) store.channelMutes.set(actorId, new Set());
    store.channelMutes.get(actorId)!.add(channelId);
    return { muted: true };
  },
  unmuteChannel(actorId: string, channelId: string): { muted: false } | ReturnType<typeof apiFail> {
    if (!this.canAccessChannel(actorId, channelId)) return apiFail("FORBIDDEN", "Channel access denied");
    store.channelMutes.get(actorId)?.delete(channelId);
    return { muted: false };
  },
  isChannelMuted(actorId: string, channelId: string): boolean {
    return store.channelMutes.get(actorId)?.has(channelId) ?? false;
  }
};
