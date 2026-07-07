import { useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { API_BASE } from "../lib/api.js";
import { useUiStore } from "../stores/domain.js";

export type PendingAttachment = { fileId: string; name: string; mimeType: string; size: number; scanStatus: string };
export type UploadEntry = { name: string; progress: number; cancel: () => void };

export const useAttachments = ({
  accessToken,
  setDraft,
  workspaceId
}: {
  accessToken: string | undefined;
  setDraft: (draft: string) => void;
  workspaceId: string | undefined;
}) => {
  const [uploading, setUploading] = useState<UploadEntry[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (file: File) => {
    if (!accessToken || !workspaceId) return;
    const controller = new AbortController();
    const entry = { name: file.name, progress: 0, cancel: () => controller.abort() };
    setUploading((prev) => [...prev, entry]);
    try {
      const createResp = await fetch(`${API_BASE}/api/v1/attachments/upload-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ workspaceId, fileName: file.name, contentType: file.type, sizeBytes: file.size })
      });
      const createJson = (await createResp.json()) as { ok: boolean; data?: { file: { id: string; objectKey: string; scanStatus: string }; uploadSession: { id: string; uploadUrl: string } } };
      if (!createJson.ok || !createJson.data) return;
      const { uploadSession, file: fileRecord } = createJson.data;
      const uploadResp = await fetch(uploadSession.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${accessToken}` }, body: file, signal: controller.signal });
      if (!uploadResp.ok) throw new Error("Upload failed");
      await fetch(`${API_BASE}/api/v1/attachments/upload-sessions/${uploadSession.id}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}` }
      });
      setPendingAttachments((prev) => [...prev, { fileId: fileRecord.id, name: file.name, mimeType: file.type, size: file.size, scanStatus: fileRecord.scanStatus }]);
      const currentDraft = useUiStore.getState().messageDraft;
      setDraft((currentDraft ? `${currentDraft} ` : "") + `[${file.name}]`);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") { /* ignore */ }
    }
    setUploading((prev) => prev.filter((upload) => upload !== entry));
  };

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) void handleFileUpload(file);
      }
    }
  };

  return {
    clearPendingAttachments: () => setPendingAttachments([]),
    fileInputRef,
    handleFileUpload,
    handlePaste,
    pendingAttachments,
    uploading
  };
};
