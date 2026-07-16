/**
 * Attachment Service
 *
 * Owns file upload sessions, file metadata, and attachment-message associations.
 *
 * Responsibilities:
 * - Create upload sessions with workspace/channel access validation
 * - Complete upload sessions and transition files to ready state
 * - Generate download URLs with expiry (dev mode: /dev-download)
 * - Associate files with messages as attachments
 * - Validate attachment references before message creation
 * - Provide dev-mode direct file upload via /dev-upload
 *
 * Does NOT:
 * - Store file bytes (dev environment: local filesystem; production: S3-compatible)
 * - Process file content or perform virus scanning
 * - Handle WebSocket broadcasts for file events
 *
 * Invariants:
 * - Upload sessions expire after 15 minutes
 * - Download URLs expire after 5 minutes
 * - Encrypted files skip server-side scanning (scanStatus: "skipped")
 * - E2E attachments must have scanStatus "skipped"
 * - Workspace access required for upload sessions and file retrieval
 *
 * Dependencies:
 * - AttachmentPersistence (in-memory or PostgreSQL)
 * - workspacePersistenceService (access control checks)
 * - env (API_PUBLIC_BASE for URL generation)
 *
 * Related Modules:
 * - persistence.ts: AttachmentPersistence interface and adapters
 * - message service: validates attachment refs before message creation
 */
import { createId } from "@paralleldrive/cuid2";
import {
  apiFail,
  fileSchema,
  nowIso,
  type AttachmentRef,
  type FileRecord
} from "@nexus-chat/shared";
import { env } from "../../config/env.js";
import { workspacePersistenceService } from "../workspaces/persistence-service.js";
import { getAttachmentPersistence } from "./persistence.js";

const objectKey = (
  workspaceId: string,
  fileId: string,
  fileName: string
) => `workspaces/${workspaceId}/files/${fileId}/${fileName}`;

const publicApiBase = () => env.API_PUBLIC_BASE.replace(/\/$/, "");

export const attachmentService = {
  async createUploadSession(
    actorId: string,
    input: {
      workspaceId: string;
      channelId?: string | undefined;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      encrypted: boolean;
    }
  ) {
    if (
      !(await workspacePersistenceService.canAccessWorkspace(
        actorId,
        input.workspaceId
      ))
    )
      return apiFail("FORBIDDEN", "Workspace access denied");
    if (
      input.channelId &&
      !(await workspacePersistenceService.canAccessChannel(
        actorId,
        input.channelId
      ))
    )
      return apiFail("FORBIDDEN", "Channel access denied");

    const fileId = createId();
    const file = fileSchema.parse({
      id: fileId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      ownerId: actorId,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      objectKey: objectKey(input.workspaceId, fileId, input.fileName),
      encrypted: input.encrypted,
      scanStatus: input.encrypted ? "skipped" : "pending",
      createdAt: nowIso()
    });

    const uploadSession = {
      id: createId(),
      fileId,
      userId: actorId,
      uploadUrl: `${publicApiBase()}/dev-upload/${fileId}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
    };

    await (await getAttachmentPersistence()).create(file, uploadSession);
    return { uploadSession, file };
  },

  async completeUpload(actorId: string, id: string) {
    const persistence = await getAttachmentPersistence();
    const session = await persistence.findSession(id);
    if (!session || session.userId !== actorId)
      return apiFail("NOT_FOUND", "Upload session not found");
    return (
      (await persistence.completeSession(id)) ??
      apiFail("CONFLICT", "Upload session is not pending")
    );
  },

  async getFile(
    actorId: string,
    id: string
  ): Promise<FileRecord | ReturnType<typeof apiFail>> {
    const file = await (await getAttachmentPersistence()).findFile(id);
    return file &&
      (await workspacePersistenceService.canAccessWorkspace(
        actorId,
        file.workspaceId
      ))
      ? file
      : apiFail("NOT_FOUND", "File not found");
  },

  async createDownloadUrl(actorId: string, id: string) {
    const file = await this.getFile(actorId, id);
    if ("ok" in file) return file;
    return {
      url: `${publicApiBase()}/dev-download/${id}?token=${createId()}`,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
  },

  async associateAttachments(
    messageId: string,
    attachments: AttachmentRef[]
  ) {
    await (
      await getAttachmentPersistence()
    ).associate(
      messageId,
      attachments.map(({ fileId }) => fileId)
    );
  },

  async validateAttachmentRefs(attachments: AttachmentRef[]) {
    const persistence = await getAttachmentPersistence();
    for (const attachment of attachments) {
      const file = await persistence.findFile(attachment.fileId);
      if (!file)
        return apiFail(
          "NOT_FOUND",
          `Attachment file not found: ${attachment.fileId}`
        );
      if (file.scanStatus === "blocked")
        return apiFail(
          "FORBIDDEN",
          `Attachment file blocked: ${attachment.fileId}`
        );
      if (file.encrypted && attachment.scanStatus !== "skipped")
        return apiFail(
          "VALIDATION_FAILED",
          "E2E attachment must have scanStatus skipped"
        );
    }
    return attachments;
  },

  async getMessageAttachments(messageId: string) {
    return (await getAttachmentPersistence()).listForMessage(messageId);
  },

  async canUploadFile(actorId: string, fileId: string) {
    return Boolean(
      await (
        await getAttachmentPersistence()
      ).findSessionForFile(fileId, actorId)
    );
  },

  async updateDevUpload(fileId: string, sizeBytes: number) {
    return (await getAttachmentPersistence()).updateFile(fileId, {
      objectKey: `dev-uploaded-${fileId}`,
      scanStatus: "clean",
      sizeBytes
    });
  }
};
