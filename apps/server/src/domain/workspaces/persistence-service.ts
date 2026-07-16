/**
 * Workspace & Channel Persistence Service (Business Logic)
 *
 * Thin authorization and coordination layer atop WorkspacePersistence.
 * Owns RBAC rules, DM name derivation, and access-control queries.
 *
 * Responsibilities:
 * - Enforce workspace/channel RBAC before delegating mutations
 * - Derive deterministic DM channel names (sorted user IDs)
 * - Resolve channel visibility (general auto-access, private member check)
 * - Coordinate workspace creation with default general channel
 *
 * Does NOT:
 * - Execute database queries directly (delegated to WorkspacePersistence)
 * - Handle WebSocket broadcasts or real-time events
 * - Manage message state or attachments
 *
 * Invariants:
 * - Every workspace creation includes exactly one owner and one general channel
 * - Ownership transfer downgrades the previous owner to admin
 * - DM channel names are idempotent: dm:{sortedUserIdA}:{sortedUserIdB}:{mode}
 *
 * Architecture Boundary:
 *   Allowed: persistence port, shared contracts
 *   Forbidden: HTTP, WebSocket, store
 *
 * Related Modules:
 * - persistence.ts: WorkspacePersistence interface and adapters
 * - service.ts: legacy Phase 1 workspaceService (kept for memory-mode compatibility)
 */
import { createId } from "@paralleldrive/cuid2";
import {
  apiFail,
  nowIso,
  type Channel,
  type ChannelMode,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceRole
} from "@nexus-chat/shared";
import { getWorkspacePersistence } from "./persistence.js";

type ErrorResult = ReturnType<typeof apiFail>;

export const workspacePersistenceService = {
  async createWorkspace(actorId: string, name: string): Promise<Workspace> {
    const workspace = { id: createId(), name, createdAt: nowIso() };
    const channel = {
      id: createId(),
      workspaceId: workspace.id,
      name: "general",
      kind: "channel" as const,
      mode: "normal" as const,
      isPrivate: false,
      createdById: actorId,
      createdAt: nowIso()
    };
    await (
      await getWorkspacePersistence()
    ).createWorkspace({
      workspace,
      owner: { workspaceId: workspace.id, userId: actorId, role: "owner" },
      channel
    });
    return workspace;
  },
  async getRole(
    userId: string,
    workspaceId: string
  ): Promise<WorkspaceRole | undefined> {
    return (await getWorkspacePersistence()).getRole(userId, workspaceId);
  },
  async getChannel(channelId: string): Promise<Channel | undefined> {
    return (await getWorkspacePersistence()).findChannel(channelId);
  },
  async canAccessWorkspace(
    userId: string,
    workspaceId: string
  ): Promise<boolean> {
    return Boolean(await this.getRole(userId, workspaceId));
  },
  async getWorkspace(
    actorId: string,
    workspaceId: string
  ): Promise<Workspace | undefined> {
    return (await this.canAccessWorkspace(actorId, workspaceId))
      ? (await getWorkspacePersistence()).findWorkspace(workspaceId)
      : undefined;
  },
  async listWorkspaces(actorId: string): Promise<Workspace[]> {
    return (await getWorkspacePersistence()).listWorkspaces(actorId);
  },
  async updateWorkspace(
    actorId: string,
    workspaceId: string,
    name: string
  ): Promise<Workspace | ErrorResult> {
    const role = await this.getRole(actorId, workspaceId);
    const updated =
      role === "owner" || role === "admin"
        ? await (
            await getWorkspacePersistence()
          ).updateWorkspace(workspaceId, name)
        : undefined;
    return (
      updated ??
      apiFail(
        role ? "NOT_FOUND" : "FORBIDDEN",
        role
          ? "Workspace not found"
          : "Only owners and admins can update workspaces"
      )
    );
  },
  async addMember(
    actorId: string,
    workspaceId: string,
    userId: string,
    role: WorkspaceRole
  ): Promise<WorkspaceMember | ErrorResult> {
    const actorRole = await this.getRole(actorId, workspaceId);
    if (actorRole !== "owner" && actorRole !== "admin")
      return apiFail("FORBIDDEN", "Only owners and admins can add members");
    if (role === "owner" && actorRole !== "owner")
      return apiFail("FORBIDDEN", "Only owners can add another owner");
    const member = { workspaceId, userId, role };
    await (await getWorkspacePersistence()).upsertMember(member);
    return member;
  },
  async removeMember(
    actorId: string,
    workspaceId: string,
    userId: string
  ): Promise<boolean | ErrorResult> {
    const actorRole = await this.getRole(actorId, workspaceId);
    const targetRole = await this.getRole(userId, workspaceId);
    if (actorRole !== "owner" && actorRole !== "admin")
      return apiFail("FORBIDDEN", "Only owners and admins can remove members");
    if (targetRole === "owner" && actorId !== userId)
      return apiFail("FORBIDDEN", "Owners cannot be removed by another member");
    if (actorRole === "admin" && targetRole === "admin")
      return apiFail("FORBIDDEN", "Admins cannot remove other admins");
    return (await getWorkspacePersistence()).deleteMemberAndChannelMemberships(
      workspaceId,
      userId
    );
  },
  async listMembers(_actorId: string, workspaceId: string) {
    return (await getWorkspacePersistence()).listMembers(workspaceId);
  },
  async transferOwnership(
    actorId: string,
    workspaceId: string,
    newOwnerUserId: string
  ): Promise<WorkspaceMember | ErrorResult> {
    if ((await this.getRole(actorId, workspaceId)) !== "owner")
      return apiFail("FORBIDDEN", "Only owners can transfer ownership");
    const persistence = await getWorkspacePersistence();
    const target = await persistence.updateMemberRole(
      workspaceId,
      newOwnerUserId,
      "owner"
    );
    if (!target)
      return apiFail("NOT_FOUND", "New owner must be a workspace member");
    // Downgrade previous owner to admin to preserve administrative access
    await persistence.updateMemberRole(workspaceId, actorId, "admin");
    return target;
  },
  async createChannel(
    actorId: string,
    workspaceId: string,
    name: string,
    mode: ChannelMode,
    isPrivate: boolean
  ): Promise<Channel | ErrorResult> {
    if (!(await this.canAccessWorkspace(actorId, workspaceId)))
      return apiFail("FORBIDDEN", "Workspace access denied");
    const channel = {
      id: createId(),
      workspaceId,
      name,
      kind: "channel" as const,
      mode,
      isPrivate,
      createdById: actorId,
      createdAt: nowIso()
    };
    const created = await (
      await getWorkspacePersistence()
    ).createChannel(channel, [actorId]);
    return (
      created ?? apiFail("CONFLICT", "Channel name already exists in workspace")
    );
  },
  /**
   * General channel auto-access: any workspace member can access #general
   * without explicit channel membership. Private channels require membership.
   */
  async canAccessChannel(userId: string, channelId: string): Promise<boolean> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (!channel || channel.deletedAt) return false;
    if (channel.kind === "channel" && channel.name === "general")
      return this.canAccessWorkspace(userId, channel.workspaceId);
    return (
      await (await getWorkspacePersistence()).listChannelMembers(channelId)
    ).some((member) => member.userId === userId);
  },
  async canManageChannel(userId: string, channelId: string): Promise<boolean> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    return Boolean(
      channel &&
      (channel.createdById === userId ||
        ["owner", "admin"].includes(
          (await this.getRole(userId, channel.workspaceId)) ?? ""
        ))
    );
  },
  async listChannels(actorId: string, workspaceId: string): Promise<Channel[]> {
    if (!(await this.canAccessWorkspace(actorId, workspaceId))) return [];
    const channels = await (
      await getWorkspacePersistence()
    ).listChannels(workspaceId);
    const visible = await Promise.all(
      channels
        .filter((channel) => !channel.deletedAt)
        .map(async (channel) =>
          (await this.canAccessChannel(actorId, channel.id))
            ? channel
            : undefined
        )
    );
    return visible.filter((channel): channel is Channel => Boolean(channel));
  },
  async updateChannel(
    actorId: string,
    channelId: string,
    updates: Partial<Pick<Channel, "name" | "description">>
  ): Promise<Channel | ErrorResult> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (!channel) return apiFail("NOT_FOUND", "Channel not found");
    if (!(await this.canManageChannel(actorId, channelId)))
      return apiFail(
        "FORBIDDEN",
        "Only admins and channel creators can update channels"
      );
    return (await getWorkspacePersistence()).updateChannel({
      ...channel,
      ...updates
    });
  },
  async addChannelMember(
    actorId: string,
    channelId: string,
    userId: string
  ): Promise<{ channelId: string; userId: string } | ErrorResult> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (
      !channel ||
      !(await this.canAccessWorkspace(actorId, channel.workspaceId)) ||
      !(await this.canManageChannel(actorId, channelId))
    )
      return apiFail("FORBIDDEN", "Channel access denied");
    if (channel.archivedAt || channel.deletedAt)
      return apiFail("FORBIDDEN", "Cannot modify archived or deleted channel");
    await (
      await getWorkspacePersistence()
    ).upsertChannelMember(channelId, userId);
    return { channelId, userId };
  },
  async removeChannelMember(
    actorId: string,
    channelId: string,
    userId: string
  ): Promise<boolean | ErrorResult> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (
      !channel ||
      !(await this.canAccessWorkspace(actorId, channel.workspaceId))
    )
      return apiFail("FORBIDDEN", "Channel access denied");
    if (
      !(await this.canManageChannel(actorId, channelId)) &&
      actorId !== userId
    )
      return apiFail(
        "FORBIDDEN",
        "Only channel creators and workspace admins can remove members"
      );
    return (await getWorkspacePersistence()).deleteChannelMember(
      channelId,
      userId
    );
  },
  async listChannelMembers(_actorId: string, channelId: string) {
    return (await getWorkspacePersistence()).listChannelMembers(channelId);
  },
  async archiveChannel(
    actorId: string,
    channelId: string
  ): Promise<Channel | ErrorResult> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (!channel || !(await this.canManageChannel(actorId, channelId)))
      return apiFail(
        "FORBIDDEN",
        "Only channel creators and workspace admins can archive channels"
      );
    return (await getWorkspacePersistence()).updateChannel({
      ...channel,
      archivedAt: nowIso()
    });
  },
  async deleteChannel(
    actorId: string,
    channelId: string
  ): Promise<Channel | ErrorResult> {
    const channel = await (
      await getWorkspacePersistence()
    ).findChannel(channelId);
    if (!channel || !(await this.canManageChannel(actorId, channelId)))
      return apiFail(
        "FORBIDDEN",
        "Only channel creators and workspace admins can delete channels"
      );
    return (await getWorkspacePersistence()).updateChannel({
      ...channel,
      deletedAt: nowIso()
    });
  },
  async createOrGetDm(
    actorId: string,
    workspaceId: string,
    peerUserId: string,
    mode: ChannelMode
  ): Promise<Channel | ErrorResult> {
    if (
      !(await this.canAccessWorkspace(actorId, workspaceId)) ||
      !(await this.canAccessWorkspace(peerUserId, workspaceId))
    )
      return apiFail("FORBIDDEN", "Both users must be workspace members");
    const [a, b] = [actorId, peerUserId].sort();
    const channel = await (
      await getWorkspacePersistence()
    ).createOrGetDm(
      {
        id: createId(),
        workspaceId,
        name: `dm:${a}:${b}:${mode}`,
        kind: "dm",
        mode,
        isPrivate: true,
        createdAt: nowIso()
      },
      [actorId, peerUserId]
    );
    return (
      channel ??
      apiFail("CONFLICT", "Could not create or retrieve direct message")
    );
  },
  async muteChannel(
    actorId: string,
    channelId: string
  ): Promise<{ muted: true } | ErrorResult> {
    if (!(await this.canAccessChannel(actorId, channelId)))
      return apiFail("FORBIDDEN", "Channel access denied");
    await (await getWorkspacePersistence()).setMuted(actorId, channelId, true);
    return { muted: true };
  },
  async unmuteChannel(
    actorId: string,
    channelId: string
  ): Promise<{ muted: false } | ErrorResult> {
    if (!(await this.canAccessChannel(actorId, channelId)))
      return apiFail("FORBIDDEN", "Channel access denied");
    await (await getWorkspacePersistence()).setMuted(actorId, channelId, false);
    return { muted: false };
  },
  async isChannelMuted(actorId: string, channelId: string): Promise<boolean> {
    return (await getWorkspacePersistence()).isMuted(actorId, channelId);
  }
};
