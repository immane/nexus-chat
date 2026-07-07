import { Badge } from "@nexus-chat/ui";
import type { DisappearingDraftPolicy } from "../stores/domain.js";
import { getPolicyLabel } from "../stores/domain.js";

const PolicyControl = ({ isE2e, policy, onChange }: { isE2e: boolean; policy: DisappearingDraftPolicy; onChange: (policy: DisappearingDraftPolicy) => void }) => {
  if (!isE2e) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
      <span>Policy:</span>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "none" })}>
        Standard
      </button>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "read_once" })}>
        Read once
      </button>
      <button className="rounded-full bg-slate-800 px-3 py-1 text-slate-200" type="button" onClick={() => onChange({ mode: "ttl", ttlSeconds: 300 })}>
        5 min TTL
      </button>
      <Badge tone={policy.mode === "none" ? "neutral" : "warning"}>{getPolicyLabel(policy)}</Badge>
    </div>
  );
};

export default PolicyControl;
