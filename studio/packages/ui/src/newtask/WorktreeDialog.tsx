import { useEffect, useState } from "react";
import type { SessionForkOptions } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { IconBranch, IconWorktree } from "../chat/icons.js";
import type { WorktreeChoice } from "./draft.js";
import "./worktree.css";

export function WorktreeDialog({ link, workspaceId, choice, onClose, onApply }: {
  link: HostLink;
  workspaceId: string;
  choice: WorktreeChoice | undefined;
  onClose(): void;
  onApply(choice: WorktreeChoice | undefined): void;
}) {
  const [options, setOptions] = useState<SessionForkOptions>();
  const [newWorktree, setNewWorktree] = useState(!!choice);
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void call(link, "GET /api/workspaces/:id/git-options", { id: workspaceId }).then(
      (result) => {
        if (!active) return;
        setOptions(result);
        const savedBranch = choice?.branch;
        setBranch(savedBranch && result.git?.branches.includes(savedBranch) ? savedBranch : result.git?.branch ?? "");
      },
      (err: unknown) => { if (active) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { active = false; };
  }, [link, workspaceId, choice, attempt]);

  const git = options?.git;
  const head = git?.head ? `${git.head.slice(0, 7)}（分离）` : "无提交";
  const currentBranch = git?.branch ?? "";
  return (
    <Modal label="分支与工作树" className="worktree-dialog" backdropClassName="worktree-backdrop" testId="draft-worktree-dialog" onClose={onClose} portal onSubmit={(e) => {
      e.preventDefault();
      if (options) onApply(newWorktree && git?.head ? (branch ? { branch } : {}) : undefined);
    }}>
      <div className="modal-title">分支与工作树</div>
      {git && (
        <div className="worktree-settings">
          <label className="worktree-row">
            <IconWorktree />
            <span>新建工作树</span>
            <input className="worktree-switch" type="checkbox" role="switch" checked={newWorktree && !!git.head} disabled={!git.head} onChange={(e) => {
              setNewWorktree(e.target.checked);
              if (!e.target.checked) setBranch(currentBranch);
            }} />
          </label>
          <label className="worktree-row">
            <IconBranch />
            <span>分支</span>
            {git.head ? (
              <select aria-label="分支" title="选择其他分支会开启新建工作树" value={branch} onChange={(e) => {
                setBranch(e.target.value);
                if (e.target.value !== currentBranch) setNewWorktree(true);
              }}>
                {!git.branch && <option value="">{head}</option>}
                {git.branches.map((name) => <option value={name} key={name}>{name}</option>)}
              </select>
            ) : (
              <span className="worktree-value" title={git.branch ?? head}>{git.branch ?? head}</span>
            )}
          </label>
        </div>
      )}
      {options && (
        <div className="worktree-hint">
          {!git?.head ? "这个项目没有可用于新建工作树的 Git 提交。" : newWorktree ? "开始任务时，从所选提交创建独立工作树（分离 HEAD）。原目录的未提交改动留在原处。" : "任务将在项目当前目录中开始。"}
        </div>
      )}
      {!options && !error && <div className="worktree-hint" role="status">正在读取分支设置…</div>}
      {error && <div className="worktree-error" role="alert">{error}</div>}
      <div className="worktree-actions">
        <button type="button" className="btn-ghost" onClick={onClose}>取消</button>
        {error ? (
          <button type="button" className="btn-primary" onClick={() => { setError(""); setAttempt((n) => n + 1); }}>重试</button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!options}>应用</button>
        )}
      </div>
    </Modal>
  );
}
