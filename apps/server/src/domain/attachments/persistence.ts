/**
 * Attachment Persistence
 *
 * Owns file metadata, upload sessions, and message-to-file association storage.
 *
 * Responsibilities:
 * - Persist file records with scan status, object key, and encryption flag
 * - Track upload session lifecycle (pending → completed)
 * - Associate files with messages via join table
 * - Resolve files for a given message
 *
 * Does NOT:
 * - Store file byte content (delegated to dev Map or future object storage)
 * - Generate signed download URLs (delegated to attachment service)
 * - Perform malware scanning (reads scanStatus, actual scanning deferred)
 *
 * Invariants:
 * - File + upload session creation is atomic in PostgreSQL
 * - Upload session completion requires status=pending (optimistic concurrency)
 * - Row mappers translate PostgreSQL timestamps to ISO 8601 strings
 *
 * Architecture Boundary:
 *   Allowed: config/env, db/client, db/schema, domain/store
 *   Forbidden: HTTP, WebSocket, UI, messages
 *
 * Future Evolution:
 * - Add content hash indexing for deduplication
 * - Add retention policy enforcement via scheduled cleanup
 */
import { and, eq } from "drizzle-orm";
import type { FileRecord } from "@nexus-chat/shared";
import { getDb, type Database } from "../../db/client.js";
import { files, messageAttachments, uploadSessions } from "../../db/schema.js";
import { store, type UploadSession } from "../store.js";

const mapFile = (row: typeof files.$inferSelect): FileRecord => ({
  ...row,
  channelId: row.channelId ?? undefined,
  createdAt: row.createdAt.toISOString()
});
const mapSession = (row: typeof uploadSessions.$inferSelect): UploadSession => ({
  id: row.id,
  fileId: row.fileId,
  userId: row.userId,
  uploadUrl: "",
  expiresAt: row.expiresAt.toISOString(),
  ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {})
});

export interface AttachmentPersistence {
  create(file: FileRecord, session: UploadSession): Promise<void>;
  findFile(id: string): Promise<FileRecord | undefined>;
  findSession(id: string): Promise<UploadSession | undefined>;
  findSessionForFile(fileId: string, userId: string): Promise<UploadSession | undefined>;
  completeSession(id: string): Promise<UploadSession | undefined>;
  updateFile(
    id: string,
    updates: Partial<Pick<FileRecord, "objectKey" | "scanStatus" | "sizeBytes">>
  ): Promise<FileRecord | undefined>;
  associate(messageId: string, fileIds: string[]): Promise<void>;
  listForMessage(messageId: string): Promise<FileRecord[]>;
}

export class InMemoryAttachmentPersistence implements AttachmentPersistence {
  async create(file: FileRecord, session: UploadSession) {
    store.files.set(file.id, file);
    store.uploadSessions.set(session.id, session);
  }
  async findFile(id: string) {
    return store.files.get(id);
  }
  async findSession(id: string) {
    return store.uploadSessions.get(id);
  }
  async findSessionForFile(fileId: string, userId: string) {
    return [...store.uploadSessions.values()].find(
      (session) => session.fileId === fileId && session.userId === userId
    );
  }
  async completeSession(id: string) {
    const session = store.uploadSessions.get(id);
    if (!session) return undefined;
    const completed = { ...session, completedAt: new Date().toISOString() };
    store.uploadSessions.set(id, completed);
    return completed;
  }
  async updateFile(
    id: string,
    updates: Partial<Pick<FileRecord, "objectKey" | "scanStatus" | "sizeBytes">>
  ) {
    const file = store.files.get(id);
    if (!file) return undefined;
    const updated = { ...file, ...updates };
    store.files.set(id, updated);
    return updated;
  }
  async associate(messageId: string, fileIds: string[]) {
    const ids = store.messageAttachments.get(messageId) ?? new Set<string>();
    for (const id of fileIds) ids.add(id);
    store.messageAttachments.set(messageId, ids);
  }
  async listForMessage(messageId: string) {
    return [...(store.messageAttachments.get(messageId) ?? [])].flatMap(
      (id) => store.files.get(id) ?? []
    );
  }
}

export class DrizzleAttachmentPersistence implements AttachmentPersistence {
  constructor(private readonly database: Database) {}
  async create(file: FileRecord, session: UploadSession) {
    await this.database.transaction(async (tx) => {
      await tx.insert(files).values({
        ...file,
        channelId: file.channelId ?? null,
        createdAt: new Date(file.createdAt)
      });
      await tx.insert(uploadSessions).values({
        id: session.id,
        fileId: session.fileId,
        userId: session.userId,
        expiresAt: new Date(session.expiresAt)
      });
    });
  }
  async findFile(id: string) {
    const [row] = await this.database
      .select()
      .from(files)
      .where(eq(files.id, id));
    return row && mapFile(row);
  }
  async findSession(id: string) {
    const [row] = await this.database
      .select()
      .from(uploadSessions)
      .where(eq(uploadSessions.id, id));
    return row && mapSession(row);
  }
  async findSessionForFile(fileId: string, userId: string) {
    const [row] = await this.database
      .select()
      .from(uploadSessions)
      .where(and(eq(uploadSessions.fileId, fileId), eq(uploadSessions.userId, userId)));
    return row && mapSession(row);
  }
  async completeSession(id: string) {
    const [row] = await this.database
      .update(uploadSessions)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(eq(uploadSessions.id, id), eq(uploadSessions.status, "pending"))
      )
      .returning();
    return row && mapSession(row);
  }
  async updateFile(
    id: string,
    updates: Partial<Pick<FileRecord, "objectKey" | "scanStatus" | "sizeBytes">>
  ) {
    const [row] = await this.database
      .update(files)
      .set(updates)
      .where(eq(files.id, id))
      .returning();
    return row && mapFile(row);
  }
  async associate(messageId: string, fileIds: string[]) {
    if (fileIds.length)
      await this.database
        .insert(messageAttachments)
        .values(fileIds.map((fileId) => ({ messageId, fileId })))
        .onConflictDoNothing();
  }
  async listForMessage(messageId: string) {
    const rows = await this.database
      .select({ file: files })
      .from(messageAttachments)
      .innerJoin(files, eq(messageAttachments.fileId, files.id))
      .where(eq(messageAttachments.messageId, messageId));
    return rows.map(({ file }) => mapFile(file));
  }
}

let persistence: AttachmentPersistence | undefined;

/**
 * Selects InMemoryAttachmentPersistence or DrizzleAttachmentPersistence based on env.PERSISTENCE.
 * The factory is cached — calling multiple times returns the same instance.
 */
export async function getAttachmentPersistence(): Promise<AttachmentPersistence> {
  if (persistence) return persistence;
  if ((await import("../../config/env.js")).env.PERSISTENCE === "memory")
    return (persistence = new InMemoryAttachmentPersistence());
  return (persistence = new DrizzleAttachmentPersistence(await getDb()));
}
