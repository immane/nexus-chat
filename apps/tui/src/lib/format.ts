const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;
const WEEK = 604800;

export const formatRelativeTime = (isoDate: string): string => {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffSeconds = Math.floor((now - then) / 1000);

  if (diffSeconds < 0) return new Date(isoDate).toLocaleTimeString();
  if (diffSeconds < MINUTE) return "just now";
  if (diffSeconds < HOUR) {
    const m = Math.floor(diffSeconds / MINUTE);
    return `${m}m ago`;
  }
  if (diffSeconds < DAY) {
    const h = Math.floor(diffSeconds / HOUR);
    return `${h}h ago`;
  }
  if (diffSeconds < 2 * DAY) return "Yesterday";
  if (diffSeconds < WEEK) {
    const d = Math.floor(diffSeconds / DAY);
    return `${d}d ago`;
  }
  return new Date(isoDate).toLocaleDateString();
};

export const formatFullTime = (isoDate: string): string =>
  new Date(isoDate).toLocaleString();

export const formatDateSeparator = (isoDate: string): string => {
  const date = new Date(isoDate);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "──── Today ────";
  if (date.toDateString() === yesterday.toDateString()) return "──── Yesterday ────";
  return `──── ${date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })} ────`;
};

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
