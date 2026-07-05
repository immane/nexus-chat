import { createId } from "@paralleldrive/cuid2";
import { apiFail, fileSchema, nowIso, type AttachmentRef, type FileRecord } from "@nexus-chat/shared";
import { store } from "../store.js";
import { workspaceService } from "../workspaces/service.js";

const objectKey = (workspaceId: string, fileId: string, fileName: string) => `workspaces/${workspaceId}/files/${fileId}/${fileName}`;

export const attachmentService = {
  createUploadSession(actorId: string, input: { workspaceId: string; channelId?: string | undefined; fileName: string; contentType: string; sizeBytes: number; encrypted: boolean }) {
    if (!workspaceService.canAccessWorkspace(actorId, input.workspaceId)) return apiFail("FORBIDDEN", "Workspace access denied");
    if (input.channelId && !workspaceService.canAccessChannel(actorId, input.channelId)) return apiFail("FORBIDDEN", "Channel access denied");
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
    store.files.set(file.id, file);
    const uploadSession = { id: createId(), fileId: file.id, userId: actorId, uploadUrl: `http://localhost:4000/dev-upload/${file.id}`, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() };
    store.uploadSessions.set(uploadSession.id, uploadSession);
    return { uploadSession, file };
  },
  completeUpload(actorId: string, uploadSessionId: string) {
    const uploadSession = store.uploadSessions.get(uploadSessionId);
    if (!uploadSession || uploadSession.userId !== actorId) return apiFail("NOT_FOUND", "Upload session not found");
    uploadSession.completedAt = nowIso();
    return uploadSession;
  },
  getFile(actorId: string, fileId: string): FileRecord | ReturnType<typeof apiFail> {
    const file = store.files.get(fileId);
    if (!file || !workspaceService.canAccessWorkspace(actorId, file.workspaceId)) return apiFail("NOT_FOUND", "File not found");
    return file;
  },
  createDownloadUrl(actorId: string, fileId: string) {
    const file = this.getFile(actorId, fileId);
    if ("ok" in file) return file;
    store.auditLogs.push({ id: createId(), actorUserId: actorId, workspaceId: file.workspaceId, action: "attachment.download_url_issued", metadata: { fileId }, createdAt: nowIso() });
    return { url: `http://localhost:4000/dev-download/${fileId}?token=${createId()}`, expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() };
  },
  associateAttachments(messageId: string, attachments: AttachmentRef[]): void {
    const existing = store.messageAttachments.get(messageId) ?? new Set<string>();
    for (const att of attachments) existing.add(att.fileId);
    store.messageAttachments.set(messageId, existing);
  },
  validateAttachmentRefs(attachments: AttachmentRef[]): AttachmentRef[] | ReturnType<typeof apiFail> {
    for (const att of attachments) {
      const file = store.files.get(att.fileId);
      if (!file) return apiFail("NOT_FOUND", `Attachment file not found: ${att.fileId}`);
      if (file.scanStatus === "blocked") return apiFail("FORBIDDEN", `Attachment file blocked: ${att.fileId}`);
      if (file.encrypted && att.scanStatus !== "skipped") return apiFail("VALIDATION_FAILED", "E2E attachment must have scanStatus skipped");
    }
    return attachments;
  },
  getMessageAttachments(messageId: string): FileRecord[] {
    const fileIds = store.messageAttachments.get(messageId);
    if (!fileIds) return [];
    return [...fileIds].map((fileId) => store.files.get(fileId)).filter((file): file is FileRecord => Boolean(file));
  }
};
