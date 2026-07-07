import { useEffect, useRef } from "react";

export type ContextMenuItem = { label: string; icon?: string; disabled?: boolean; danger?: boolean; onClick: () => void };

export const ContextMenu = ({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const style: React.CSSProperties = { position: "fixed", left: x, top: y, zIndex: 50 };

  return (
    <div ref={ref} style={style} className="w-48 rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl">
      {items.map((item, i) => (
        <button
          key={i}
          className={`flex w-full items-center gap-2 px-4 py-2 text-left text-sm transition
            ${item.disabled ? "cursor-not-allowed text-slate-600" : item.danger ? "text-red-400 hover:bg-red-500/10" : "text-slate-300 hover:bg-slate-800"}`}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            if (!item.disabled) item.onClick();
            onClose();
          }}
        >
          {item.icon ? <span className="w-4 text-center text-xs">{item.icon}</span> : null}
          {item.label}
        </button>
      ))}
    </div>
  );
};
