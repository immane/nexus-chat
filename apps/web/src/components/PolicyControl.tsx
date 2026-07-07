import { Badge } from "@nexus-chat/ui";
import type { DisappearingDraftPolicy } from "../stores/domain.js";
import { getPolicyLabel, useUiStore } from "../stores/domain.js";

const PolicyControl = ({ isE2e, policy, onChange }: { isE2e: boolean; policy: DisappearingDraftPolicy; onChange: (policy: DisappearingDraftPolicy) => void }) => {
  const theme = useUiStore((state) => state.settings.theme);
  const isLight = theme === "light";

  if (!isE2e) return null;

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${isLight ? "text-slate-500" : "text-slate-400"}`}>
      <span>Policy:</span>
      <button className={`rounded-full px-3 py-1 ${isLight ? "bg-slate-200 text-slate-700" : "bg-slate-800 text-slate-200"}`} type="button" onClick={() => onChange({ mode: "none" })}>
        Standard
      </button>
      <button className={`rounded-full px-3 py-1 ${isLight ? "bg-slate-200 text-slate-700" : "bg-slate-800 text-slate-200"}`} type="button" onClick={() => onChange({ mode: "read_once" })}>
        Read once
      </button>
      <button className={`rounded-full px-3 py-1 ${isLight ? "bg-slate-200 text-slate-700" : "bg-slate-800 text-slate-200"}`} type="button" onClick={() => onChange({ mode: "ttl", ttlSeconds: 300 })}>
        5 min TTL
      </button>
      <Badge tone={policy.mode === "none" ? "neutral" : "warning"}>{getPolicyLabel(policy)}</Badge>
    </div>
  );
};

export default PolicyControl;
