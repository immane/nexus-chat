/**
 * Database Schema Tests
 *
 * Covers:
 * - All core tables are exported with expected names
 * - Generated migration contains required indexes
 * - Workflow-specific bot tables are NOT in the base schema
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  auditLogs,
  botChannelMemberships,
  botEventSubscriptions,
  botIntegrations,
  channelMutes,
  channelMembers,
  channelPins,
  channels,
  files,
  messageAttachments,
  messageReadReceipts,
  messageReactions,
  messages,
  savedMessages,
  signalOneTimePreKeys,
  signalPreKeyBundles,
  signalSessions,
  uploadSessions,
  users,
  workspaceMembers,
  workspaces
} from "./schema.js";

const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle/0000_gigantic_sally_floyd.sql");
const parityMigrationPath = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle/0001_workable_loki.sql");

describe("database schema", () => {
  it("exports all phase 1 core tables", () => {
    const tableNames = [
      users,
      workspaces,
      workspaceMembers,
      channels,
      channelMembers,
      messages,
      messageReactions,
      savedMessages,
      messageReadReceipts,
      channelPins,
      channelMutes,
      files,
      uploadSessions,
      messageAttachments,
      botIntegrations,
      botChannelMemberships,
      botEventSubscriptions,
      signalPreKeyBundles,
      signalOneTimePreKeys,
      signalSessions,
      auditLogs
    ].map((table) => getTableName(table));

    expect(tableNames).toEqual([
      "users",
      "workspaces",
      "workspace_members",
      "channels",
      "channel_members",
      "messages",
      "message_reactions",
      "saved_messages",
      "message_read_receipts",
      "channel_pins",
      "channel_mutes",
      "files",
      "upload_sessions",
      "message_attachments",
      "bot_integrations",
      "bot_channel_memberships",
      "bot_event_subscriptions",
      "signal_prekey_bundles",
      "signal_one_time_prekeys",
      "signal_sessions",
      "audit_logs"
    ]);
  });

  it("migration contains required indexes and no workflow-specific bot tables", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE INDEX \"messages_channel_page_idx\" ON \"messages\" USING btree (\"channel_id\",\"id\" desc)");
    expect(sql).toContain("CREATE UNIQUE INDEX \"messages_sender_client_msg_idx\" ON \"messages\" USING btree (\"sender_id\",\"client_msg_id\")");
    expect(sql).toContain("CREATE INDEX \"channel_members_user_joined_idx\" ON \"channel_members\" USING btree (\"user_id\",\"joined_at\")");
    expect(sql).toContain("CREATE INDEX \"bot_channel_memberships_channel_idx\" ON \"bot_channel_memberships\" USING btree (\"channel_id\")");
    expect(sql).toContain("CREATE INDEX \"files_workspace_created_idx\" ON \"files\" USING btree (\"workspace_id\",\"created_at\")");
    expect(sql).toContain("CREATE INDEX \"files_scan_idx\" ON \"files\" USING btree (\"scan_status\")");
    expect(sql).toContain("CREATE INDEX \"upload_sessions_cleanup_idx\" ON \"upload_sessions\" USING btree (\"status\",\"expires_at\")");
    expect(sql).not.toMatch(/CREATE TABLE "(polls|reminders|kudos|todos|standups)"/);
  });

  it("migration reconciles the durable runtime model", () => {
    const sql = readFileSync(parityMigrationPath, "utf8");
    expect(sql).toContain('ALTER TABLE "channels" ADD COLUMN "created_by_id" text');
    expect(sql).toContain('ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" text');
    expect(sql).toContain('ALTER TABLE "channel_members" ADD COLUMN "last_read_at" timestamp with time zone');
    expect(sql).toContain('ALTER TABLE "files" ADD COLUMN "channel_id" text');
    expect(sql).toContain('CREATE TABLE "saved_messages"');
    expect(sql).toContain('CREATE TABLE "message_read_receipts"');
    expect(sql).toContain('CREATE TABLE "channel_pins"');
    expect(sql).toContain('CREATE TABLE "channel_mutes"');
  });
});
