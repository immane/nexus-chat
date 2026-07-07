---
lang: en
phase: 1
status: done
---

# 21 — Phase 1 — Web Rich Media & Emoji Picker

## Goal

Add emoji picker, file upload, and clipboard paste support to the message composer, enabling richer message composition and media sharing in Phase 1 Web.

## Scope

### Emoji Picker
- Integrate `emoji-mart` or `emoji-picker-react` for emoji selection.
- Emoji button next to the message input opens a popover picker.
- Selected emoji inserted at cursor position in the textarea.
- Recent/frequently-used emoji section.
- Search by emoji name or keyword.
- Native emoji rendering (no custom sprite sheets needed at Phase 1).

### File Upload Button
- Attachment button (📎) next to message input.
- On click, opens native file picker (`<input type="file">`).
- Supports: images, documents, archives (common MIME types).
- Selected file triggers upload via `attachmentService.createUploadSession` → presigned URL → `fetch` PUT.
- On upload complete, calls `attachmentService.completeUpload`.
- Sends message with `attachments: [{ fileId, name, mimeType, size, scanStatus }]`.
- Upload progress indicator (progress bar on the composing attachment).
- Cancel upload button.
- File size validation (warn on >10MB, but allow up to server limits).

### Clipboard Paste
- `onPaste` handler on message textarea.
- Detect image data in clipboard (`event.clipboardData.files`).
- If image present, upload via attachment pipeline and insert as `[image]` placeholder or inline thumbnail.
- Paste multiple images → batch upload.
- Text paste behavior unchanged.

### Inline Attachment Rendering
- Image attachments render thumbnails inline in the message list (clickable for full view).
- Non-image files render as file cards with icon + filename + size.
- Download button on file cards calls `attachmentService.createDownloadUrl` → triggers download.

## Non-Goals

- No voice message recording (requires MediaRecorder + audio waveform — Phase 2).
- No video message recording.
- No sticker support.
- No GIF search integration.
- No drag-and-drop file upload into chat area (can add later).
- No image editing/cropping before send.
- No E2E encrypted file upload (client-side encryption before upload — Phase 2).

## Backend Dependencies

Attachment service fully implemented and tested:
- `attachmentService.createUploadSession`
- `attachmentService.completeUpload`
- `attachmentService.createDownloadUrl`
- `attachmentService.validateAttachmentRefs`
- Attachment ref schema in shared: `attachmentRefSchema`

All backend APIs exposed via REST:
- `POST /api/v1/attachments/upload-sessions`
- `POST /api/v1/attachments/:sessionId/complete`
- `GET /api/v1/files/:fileId/download-url`

## Acceptance Criteria

- [ ] Emoji picker popover opens from button next to input.
- [ ] Selected emoji inserted at cursor position.
- [ ] File upload button triggers native file picker.
- [ ] Uploaded file shows progress bar during transfer.
- [ ] Message sent with attachment refs; image renders inline, file renders as card.
- [ ] Clipboard paste uploads pasted images as attachments.
- [ ] Download button on file card triggers file download.
- [ ] Cancel button aborts in-progress upload.
