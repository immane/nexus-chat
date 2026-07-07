---
lang: en
phase: 1
status: todo
---

# 20 — Phase 1 — Web Message Display & Formatting

## Goal

Upgrade message rendering from plain text to rich Markdown, add relative timestamps, URL link previews, and Markdown-formatting input support — bringing the Web client to production IM display quality.

## Scope

### Markdown Rendering (Messages)
- Integrate `markdown-it` with SafeLink plugin for XSS-resistant rendering.
- Support: **bold**, *italic*, `inline code`, ```code blocks```, > blockquotes, ~~strikethrough~~, bullet/numbered lists.
- Code blocks render with monospace background, optional syntax highlighting via Shiki (defer if heavy).
- Links auto-detected and rendered as clickable `<a>` with `target="_blank" rel="noopener noreferrer"`.
- @mentions and #channels rendered as inline styled badges (no navigation link yet, Phase 2).
- Plain text fallback for unrecognized/unparseable content.

### Markdown Input
- Replace `<input>` with `<textarea>` supporting multiline input (Shift+Enter for newline, Enter to send).
- Add formatting toolbar above/below the textarea: Bold, Italic, Code, Link, Quote buttons that insert/wrap markdown syntax.
- Live preview toggle — preview panel showing rendered markdown before sending.
- Slash command detection preserved (messages starting with `/` routed to bot).
- Keyboard shortcuts: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+K` link.

### Link Previews
- On message send, detect URLs in message text.
- Fetch Open Graph metadata from URL (title, description, image).
- Render a compact link preview card below the message text.
- Thumbnail image, title, domain, and truncated description.
- Debounce / cache to avoid excessive fetches.
- Handle fetch failures gracefully (no preview card shown).

### Relative Timestamps
- Display message time as relative: "Just now", "2m ago", "1h ago", "Yesterday", "Jan 5".
- Tooltip on hover shows absolute timestamp.
- Date separators between messages on different days ("Monday, Jan 5, 2026").
- Update relative timestamps periodically (every 60s for recent messages).

## Non-Goals

- No Shiki syntax highlighting (heavy dependency; defer to Phase 2 if needed).
- No spoiler text (Telegram-specific).
- No animated emoji / message effects.
- No rich media album rendering (Phase 2).
- No link preview for E2E ciphertext messages.

## Dependencies

- `markdown-it` (add to `apps/web/package.json`).
- Link preview: use `open-graph-scraper` or simple `fetch` + `cheerio`-based OG extraction, or use a server-side proxy endpoint to avoid CORS.
- No new backend dependencies — link preview fetch can be done from Web directly or via a lightweight server proxy endpoint.

## Acceptance Criteria

- [ ] Messages render Markdown: bold, italic, code, code blocks, blockquotes, lists.
- [ ] Links in messages are clickable and open in new tab.
- [ ] Message input is multiline textarea with Shift+Enter newline, Enter send.
- [ ] Formatting toolbar with Bold, Italic, Code, Quote buttons.
- [ ] URLs in messages auto-generate link preview cards (title, description, thumbnail).
- [ ] Timestamps shown as relative ("5m ago") with absolute tooltip.
- [ ] Date separator dividers between different days.
- [ ] Slash commands still work correctly after input upgrade.
