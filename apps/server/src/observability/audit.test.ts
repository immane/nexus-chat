import { beforeEach, describe, expect, it } from "vitest";
import { auditEvents, getAuditEvents, writeAuditEvent } from "./audit.js";

describe("audit events", () => {
  beforeEach(() => {
    auditEvents.length = 0;
  });

  it("writes and retrieves audit events", () => {
    writeAuditEvent({ type: "message.sent", actor: "user-1", metadata: { channelId: "ch-1", messageId: "msg-1" } });
    writeAuditEvent({ type: "user.login", actor: "user-2" });

    const events = getAuditEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("message.sent");
    expect(events[0]!.actor).toBe("user-1");
    expect(events[0]!.metadata).toEqual({ channelId: "ch-1", messageId: "msg-1" });
    expect(events[1]!.type).toBe("user.login");
    expect(events[1]!.actor).toBe("user-2");
  });

  it("has required fields for each event type", () => {
    writeAuditEvent({ type: "message.sent", actor: "user-1", target: "ch-1", metadata: { channelId: "ch-1", messageId: "msg-1" } });
    writeAuditEvent({ type: "channel.created", actor: "user-2", target: "ch-2", metadata: { workspaceId: "ws-1" } });
    writeAuditEvent({ type: "user.logout", actor: "user-3" });

    const events = getAuditEvents();
    for (const event of events) {
      expect(event.type).toBeTruthy();
      expect(event.actor).toBeTruthy();
      expect(event.timestamp).toBeTruthy();
      expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
    }

    expect(events[0]!.target).toBe("ch-1");
    expect(events[0]!.metadata).toBeDefined();
    expect(events[2]!.target).toBeUndefined();
    expect(events[2]!.metadata).toBeUndefined();
  });

  it("returns a copy of events not a mutable reference", () => {
    writeAuditEvent({ type: "test", actor: "a" });
    const events = getAuditEvents();
    events.push({ type: "intruder", actor: "bad", timestamp: new Date().toISOString() });
    expect(auditEvents).toHaveLength(1);
  });

  it("assigns a timestamp automatically", () => {
    const before = new Date();
    writeAuditEvent({ type: "test", actor: "a" });
    const after = new Date();
    const ts = new Date(auditEvents[0]!.timestamp);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
