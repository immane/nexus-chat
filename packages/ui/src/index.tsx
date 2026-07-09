/**
 * @nexus-chat/ui — Shared UI Primitives
 *
 * Atomic design components reused across apps (web, desktop).
 * Currently provides:
 * - Badge: colored label with configurable tone (neutral/success/warning)
 * - InputActionBar: styled container for input actions + children
 *
 * Design Decision:
 * These components are intentionally minimal and presentation-only.
 * Business logic (theme detection, state management) lives in the
 * consumer (apps/web). This keeps the UI package framework-agnostic
 * and avoids bundling Zustand or other state libraries.
 *
 * Future Evolution:
 * - Add Storybook stories for each component
 * - Expand with Composite components (following Atomic Design methodology)
 * - Add design tokens via Tailwind @theme directive
 */
import type { PropsWithChildren, ReactNode } from "react";

export const Badge = ({ children, tone = "neutral" }: PropsWithChildren<{ tone?: "neutral" | "warning" | "success" }>) => {
  const toneClass = {
    neutral: "bg-slate-800 text-white ring-slate-700",
    success: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/30",
    warning: "bg-amber-500/15 text-amber-100 ring-amber-400/30"
  }[tone];

  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${toneClass}`}>{children}</span>;
};

export const InputActionBar = ({ children, actions }: PropsWithChildren<{ actions?: ReactNode }>) => (
  <div className="bg-slate-950/95 p-3">
    {actions ? <div className="mb-2 flex flex-wrap items-center gap-2">{actions}</div> : null}
    <div className="flex items-center gap-2">{children}</div>
  </div>
);
