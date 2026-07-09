/**
 * Markdown Rendering & Time Formatting Utilities
 *
 * Responsibilities:
 * - Render markdown text to safe HTML via markdown-it
 * - Format timestamps as relative ("5m ago"), date separators ("Today", "Yesterday")
 * - Format file sizes (B, KB, MB)
 *
 * Security:
 * - html: false — markdown-it does NOT render raw HTML
 * - linkify: true — autolinks URLs but we override link_open to add target=_blank rel=noopener
 *
 * Does NOT:
 * - Handle @mentions, #channels, or :emoji: shortcodes (custom plugins deferred)
 * - Use DOMPurify (markdown-it with html:false is sufficient for Phase 1)
 */
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false
});

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  if (!token) return "";
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

export const renderMarkdown = (text: string): string => md.render(text);

export const formatRelativeTime = (isoString: string): string => {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString([], { month: "short", day: "numeric" });
};

export const formatDateSeparator = (isoString: string): string => {
  const date = new Date(isoString);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";

  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: "numeric" });
};

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
