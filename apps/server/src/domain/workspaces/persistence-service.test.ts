import { beforeEach, describe, expect, it } from "vitest";
import { store } from "../store.js";
import { resetStore } from "../test-utils.js";
import { workspacePersistenceService as service } from "./persistence-service.js";

const owner = "owner";
const admin = "admin";
const member = "member";
const outsider = "outsider";

describe("workspace persistence service", () => {
  beforeEach(() => {
    resetStore();
    store.channelMutes.clear();
  });

  it("creates, reads, lists, and updates workspaces with RBAC", async () => {
    const workspace = await service.createWorkspace(owner, "Workspace");

    expect(await service.getRole(owner, workspace.id)).toBe("owner");
    expect(await service.getChannel((await service.listChannels(owner, workspace.id))[0]!.id)).toMatchObject({ name: "general" });
    expect(await service.canAccessWorkspace(owner, workspace.id)).toBe(true);
    expect(await service.canAccessWorkspace(outsider, workspace.id)).toBe(false);
    expect(await service.getWorkspace(owner, workspace.id)).toEqual(workspace);
    expect(await service.getWorkspace(outsider, workspace.id)).toBeUndefined();
    expect(await service.listWorkspaces(owner)).toEqual([workspace]);
    expect(await service.updateWorkspace(outsider, workspace.id, "No")).toMatchObject({ error: { code: "FORBIDDEN" } });
    store.workspaceMembers.set("missing:owner", { workspaceId: "missing", userId: owner, role: "owner" });
    expect(await service.updateWorkspace(owner, "missing", "No")).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.updateWorkspace(owner, workspace.id, "Renamed")).toMatchObject({ name: "Renamed" });
  });

  it("enforces member and ownership changes", async () => {
    const workspace = await service.createWorkspace(owner, "Workspace");

    expect(await service.addMember(outsider, workspace.id, member, "member")).toMatchObject({ error: { code: "FORBIDDEN" } });
    await service.addMember(owner, workspace.id, admin, "admin");
    expect(await service.addMember(admin, workspace.id, member, "owner")).toMatchObject({ error: { code: "FORBIDDEN" } });
    await service.addMember(owner, workspace.id, "admin-two", "admin");
    await service.addMember(owner, workspace.id, member, "member");
    expect(await service.listMembers(outsider, workspace.id)).toHaveLength(4);
    expect(await service.removeMember(outsider, workspace.id, member)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.removeMember(admin, workspace.id, "admin-two")).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.removeMember(admin, workspace.id, owner)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.removeMember(owner, workspace.id, member)).toBe(true);
    await service.addMember(owner, workspace.id, member, "member");
    expect(await service.transferOwnership(admin, workspace.id, member)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.transferOwnership(owner, workspace.id, outsider)).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.transferOwnership(owner, workspace.id, member)).toMatchObject({ role: "owner", userId: member });
    expect(await service.getRole(owner, workspace.id)).toBe("admin");
  });

  it("enforces channel access and management through the full lifecycle", async () => {
    const workspace = await service.createWorkspace(owner, "Workspace");
    const [general] = await service.listChannels(owner, workspace.id);
    await service.addMember(owner, workspace.id, admin, "admin");
    await service.addMember(owner, workspace.id, member, "member");

    expect(await service.createChannel(outsider, workspace.id, "private", "normal", true)).toMatchObject({ error: { code: "FORBIDDEN" } });
    const privateChannel = await service.createChannel(owner, workspace.id, "private", "normal", true);
    expect(privateChannel).toMatchObject({ name: "private" });
    if ("ok" in privateChannel) throw new Error("channel creation failed");
    expect(await service.createChannel(owner, workspace.id, "private", "normal", true)).toMatchObject({ error: { code: "CONFLICT" } });
    expect(await service.canAccessChannel(member, general!.id)).toBe(true);
    expect(await service.canAccessChannel(member, privateChannel.id)).toBe(false);
    expect(await service.canAccessChannel(member, "missing")).toBe(false);
    expect(await service.canManageChannel(outsider, privateChannel.id)).toBe(false);
    expect(await service.canManageChannel(owner, privateChannel.id)).toBe(true);
    expect(await service.listChannels(outsider, workspace.id)).toEqual([]);
    expect(await service.listChannels(member, workspace.id)).toEqual([general]);
    expect(await service.updateChannel(owner, "missing", { name: "no" })).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(await service.updateChannel(member, privateChannel.id, { name: "no" })).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.updateChannel(owner, privateChannel.id, { description: "Secret" })).toMatchObject({ description: "Secret" });
    expect(await service.addChannelMember(outsider, privateChannel.id, member)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.addChannelMember(owner, privateChannel.id, member)).toEqual({ channelId: privateChannel.id, userId: member });
    expect(await service.listChannelMembers(outsider, privateChannel.id)).toHaveLength(2);
    expect(await service.removeChannelMember(outsider, privateChannel.id, member)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.removeChannelMember(member, privateChannel.id, member)).toBe(true);
    await service.addChannelMember(owner, privateChannel.id, member);
    expect(await service.removeChannelMember(member, privateChannel.id, owner)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.archiveChannel(member, privateChannel.id)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.archiveChannel(owner, privateChannel.id)).toMatchObject({ archivedAt: expect.any(String) });
    expect(await service.addChannelMember(owner, privateChannel.id, member)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.deleteChannel(owner, privateChannel.id)).toMatchObject({ deletedAt: expect.any(String) });
    expect(await service.canAccessChannel(owner, privateChannel.id)).toBe(false);
    expect(await service.deleteChannel(owner, "missing")).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("creates deterministic DMs and manages channel mutes", async () => {
    const workspace = await service.createWorkspace(owner, "Workspace");
    const [general] = await service.listChannels(owner, workspace.id);
    await service.addMember(owner, workspace.id, member, "member");

    expect(await service.createOrGetDm(owner, workspace.id, outsider, "normal")).toMatchObject({ error: { code: "FORBIDDEN" } });
    const dm = await service.createOrGetDm(member, workspace.id, owner, "normal");
    if ("ok" in dm) throw new Error("DM creation failed");
    expect(dm.name).toBe("dm:member:owner:normal");
    expect(await service.createOrGetDm(owner, workspace.id, member, "normal")).toMatchObject({ id: dm.id });
    expect(await service.muteChannel(outsider, general!.id)).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await service.muteChannel(owner, general!.id)).toEqual({ muted: true });
    expect(await service.isChannelMuted(owner, general!.id)).toBe(true);
    expect(await service.unmuteChannel(owner, general!.id)).toEqual({ muted: false });
    expect(await service.isChannelMuted(owner, general!.id)).toBe(false);
  });
});
