---
lang: en
phase: 1
status: todo
---

# 19 — Phase 1 — Web Message Actions & Context Menu

## Goal

Enable common message interactions (reply, forward, copy, delete, edit, react) through a right-click context menu and per-message action buttons, filling the biggest UX gap between Phase 1 Web and production IM clients.

## Scope

### Context Menu
- Right-click (desktop) / long-press (mobile/touch) on a message opens a context menu.
- Menu items:
  - Reply — opens reply bar above input with quoted message preview.
  - Copy Text — copies message plain text to clipboard (`navigator.clipboard.writeText`).
  - Forward — opens forward target picker (channel/DM selector).
  - Edit — only for own messages; moves message text into edit input.
  - Delete — confirm dialog then soft-delete via backend.
  - React — opens emoji reaction picker anchored to the message.

### Reply Quote
- Click Reply in context menu → a reply bar appears above message input showing a compact preview of the quoted message (sender name + truncated text).
- Input optionally sends a `replyToMessageId` reference (once backend is ready; see task 23).
- Visual indicator on the replied-to message (highlight / scroll-to on click).
- "X" button on reply bar to cancel.

### Forward
- Click Forward → modal/dropdown shows list of channels + DMs.
- Supports search/filter.
- On select, calls `messageService.forward` backend and navigates to target channel.
- Forwarded message shows "Forwarded" label + original sender attribution.

### Copy
- Click Copy Text → clipboard write + brief toast "Copied".
- For E2E ciphertext messages, copy disabled (ciphertext not meaningful).

### Edit
- Only on own text messages (not ciphertext, not bot messages).
- Switches message inline to editable textarea or opens modal.
- On submit, calls `messageService.edit`.
- Displays "edited" label on edited messages.

### Delete
- Confirm dialog: "Delete this message?"
- On confirm, calls `messageService.softDelete`.
- Message renders as tombstone in the list.

### React
- Quick-reaction bar below each message showing frequently used emoji (👍❤️😄😢😮).
- "+" button opens full emoji reaction picker.
- Existing reactions displayed as emoji + count badges.
- Click existing reaction to toggle (add/remove).
- Real-time reaction updates via `message.reaction` WS event.

## Non-Goals

- No key verification UI (Phase 3).
- No message pinning UI (requires backend pin support — task 23).
- No translate message (requires external translation API).
- No schedule message (Phase 2).
- No voice/video attachment recording.

## Backend Dependencies

All message CRUD actions (edit, delete, forward, react) already supported:
- `apps/server/src/domain/messages/service.ts`
- `message.reaction`, `message.updated`, `message.deleted` WS events
- `reactMessageSchema`, `editMessageSchema`, `forwardMessageSchema` in shared schemas

Reply (`replyToMessageId`) requires backend schema extension — see task 23.

## Acceptance Criteria

- [ ] Right-click context menu with Reply, Copy, Forward, Edit, Delete, React options.
- [ ] Copy writes message text to clipboard with toast feedback.
- [ ] Edit toggles inline edit mode; submits to `messageService.edit`.
- [ ] Delete shows confirm dialog; tombstone rendered after soft-delete.
- [ ] Quick-reaction bar with 5 default emoji + full picker toggle.
- [ ] Reaction badges render per-message with real-time WS updates.
- [ ] Reply bar shows quoted message preview above input.
- [ ] Forward modal allows channel/DM target selection.
