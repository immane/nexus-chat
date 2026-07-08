export const DeleteConfirmModal = ({
  confirmDelete,
  isLight,
  onCancel,
  themeBtn
}: {
  confirmDelete: () => void;
  isLight: boolean;
  onCancel: () => void;
  themeBtn: string;
}) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
    <div className={`w-[calc(100vw-2rem)] max-w-72 max-h-[80vh] overflow-y-auto rounded-2xl border ${isLight ? "border-slate-200 bg-white" : "border-slate-700 bg-slate-900"} p-4 shadow-2xl`} onClick={(event) => event.stopPropagation()}>
      <p className="mb-4 text-sm">Delete this message?</p>
      <div className="flex gap-2">
        <button className="flex-1 rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-200 hover:bg-red-500/30" type="button" onClick={() => confirmDelete()}>Delete</button>
        <button className={`flex-1 rounded-lg px-3 py-2 text-sm ${themeBtn}`} type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  </div>
);
