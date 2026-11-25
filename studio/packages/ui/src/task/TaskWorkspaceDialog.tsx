import { useState } from "react";
import { isCommon, projectWorkspaces, type Task, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";

export function TaskWorkspaceDialog({ link, task, workspaces, hasSessions, onClose }: { link: HostLink; task: Task; workspaces: readonly Workspace[]; hasSessions: boolean; onClose(): void }) {
  const projects = projectWorkspaces(workspaces);
  const common = workspaces.find(isCommon);
  const current = task.workspaceId === common?.id ? "" : task.workspaceId;
  const [selected, setSelected] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = selected ? projects.find((w) => w.id === selected) : common;
  const canSave = !!target && selected !== current && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await call(link, "PATCH /api/tasks/:id", { id: task.id }, { workspaceId: selected || null });
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <Modal portal className="confirm-modal task-workspace-dialog" labelledBy="task-workspace-title" busy={busy} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <span className="modal-title" id="task-workspace-title">切换工作区</span>
      <label className="stack-field">
        <span>任务工作区</span>
        <select value={selected} disabled={busy} onChange={(e) => { setSelected(e.target.value); setError(null); }}>
          <option value="">公共目录（未指定项目）</option>
          {selected && !target && <option value={selected} disabled>所选项目不可用</option>}
          {projects.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      {target?.path && <span className="settings-hint task-workspace-path" title={target.path}>{target.path}</span>}
      {hasSessions && <span className="settings-hint">新会话将默认在所选工作区启动，已有会话继续使用各自原来的目录。</span>}
      {error && <span className="form-error" role="alert">{error}</span>}
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="btn-primary small" disabled={!canSave}>{busy ? "切换中…" : "切换"}</button>
      </div>
    </Modal>
  );
}
