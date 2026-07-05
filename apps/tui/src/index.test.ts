import { describe, expect, it } from "vitest";
import { createProgram } from "./cli.js";
import { getAccessToken, setAccessToken, clearAccessToken } from "./lib/api.js";

describe("nexus CLI program", () => {
  it("has program name nexus", () => {
    const program = createProgram();
    expect(program.name()).toBe("nexus");
  });

  it("registers all required commands", () => {
    const program = createProgram();
    const cmds = program.commands as unknown as Array<{ name: () => string }>;
    const names = cmds.map((c) => c.name());
    expect(names).toContain("login");
    expect(names).toContain("logout");
    expect(names).toContain("whoami");
    expect(names).toContain("workspaces");
    expect(names).toContain("workspace-create");
    expect(names).toContain("channels");
    expect(names).toContain("channel-create");
    expect(names).toContain("chat");
    expect(names).toContain("read");
    expect(names).toContain("send");
    expect(names).toContain("api-smoke");
    expect(names).toContain("p2p-smoke");
    expect(names).toContain("e2e-smoke");
    expect(names).toContain("bot-smoke");
  });

  it("login command requires --email and --password", () => {
    const program = createProgram();
    const cmds = program.commands as unknown as Array<{ name: () => string; options: Array<{ name: () => string; required: boolean }> }>;
    const cmd = cmds.find((c) => c.name() === "login")!;
    const opts = cmd.options;
    expect(opts.find((o) => o.name() === "email")?.required).toBe(true);
    expect(opts.find((o) => o.name() === "password")?.required).toBe(true);
  });

  it("channels command requires --workspace", () => {
    const program = createProgram();
    const cmds = program.commands as unknown as Array<{ name: () => string; options: Array<{ name: () => string; required: boolean }> }>;
    const cmd = cmds.find((c) => c.name() === "channels")!;
    expect(cmd.options.find((o) => o.name() === "workspace")?.required).toBe(true);
  });
});

describe("token persistence", () => {
  it("stores and clears token in memory", () => {
    setAccessToken("test-token-123");
    expect(getAccessToken()).toBe("test-token-123");
    clearAccessToken();
    expect(getAccessToken()).toBe("");
  });
});
