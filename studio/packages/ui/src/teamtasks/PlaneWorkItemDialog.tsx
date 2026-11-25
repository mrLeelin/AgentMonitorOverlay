import { useEffect, useRef, useState } from "react";
import type { PlaneProjectBoard, PlaneWorkItem, PlaneWorkItemChange, PlaneWorkItemDetail, PlaneWorkItemEdit, TeamTaskFile, Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";
import { PLANE_PRIORITIES, planeStateName } from "./PlaneWorkItemLayouts.js";

export function PlaneWorkItemDialog({ link, item, board, target, projects, onProject, onCopy, onChange, onClose }: {
  link: HostLink;
  item: PlaneWorkItem;
  board: PlaneProjectBoard;
  target?: Workspace;
  projects?: readonly Workspace[];
  onProject(id: string): void;
  onCopy(): Promise<void>;
  onChange(item: PlaneWorkItem, change: PlaneWorkItemChange): Promise<PlaneWorkItemDetail | null>;
  onClose(): void;
}) {
  const [detail, setDetail] = useState<PlaneWorkItemDetail | null>(null);
  const [fields, setFields] = useState<PlaneWorkItemEdit>({});
  const [comment, setComment] = useState("");
  const [editingComment, setEditingComment] = useState<string>();
  const [confirm, setConfirm] = useState<"delete" | string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const writable = board.writable && !!detail && !detail.archived;

  async function load() {
    const version = ++generation.current;
    setLoading(true); setError("");
    try {
      const value = await call(link, "GET /api/team-board/plane/work-items/:id", { id: item.id });
      if (version === generation.current) { setDetail(value); setFields({}); }
    } catch (err) { if (version === generation.current) setError(teamBoardMessage(err)); }
    finally { if (version === generation.current) setLoading(false); }
  }
  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [link, item.id]);

  async function run(action: () => Promise<void>) {
    if (pending.current || loading) return;
    pending.current = true;
    setBusy(true); setError("");
    try { await action(); }
    catch (err) { setError(teamBoardMessage(err)); }
    finally { pending.current = false; setBusy(false); }
  }

  type Action = PlaneWorkItemChange extends infer Change ? Change extends PlaneWorkItemChange ? Omit<Change, "source" | "revision"> : never : never;
  function mutate(action: Action) {
    if (!detail) return;
    void run(async () => {
      const next = await onChange(detail, { ...action, source: board.source, revision: detail.revision });
      setConfirm(null);
      if (!next) { onClose(); return; }
      setDetail(next);
      if (action.action === "edit" || action.action === "archive") setFields({});
      if (action.action === "comment") { setComment(""); setEditingComment(undefined); }
    });
  }

  function field<K extends keyof PlaneWorkItemEdit>(key: K, value: PlaneWorkItemEdit[K], original: PlaneWorkItemEdit[K]) {
    setFields((current) => {
      const next = { ...current };
      if (JSON.stringify(value) === JSON.stringify(original)) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function attachments(files: TeamTaskFile[]) {
    return files.length > 0 && <ul className="plane-attachments">{files.map((file) => <li key={file.id}>
      <button type="button" className="tb-button" onClick={() => void run(async () => {
        if (!window.amo?.saveTeamTaskAttachment) throw new Error("请在 Studio 桌面客户端保存附件");
        await window.amo.saveTeamTaskAttachment(item.id, file.id, file.name, true);
      })}>{file.name}</button>
    </li>)}</ul>;
  }

  const editing = Object.keys(fields).length > 0;
  const status = detail && board.states.find((state) => state.id === detail.stateId);
  return <Modal portal className="plane-item-modal tb-preview" backdropClassName="tb-preview-backdrop" label={`团队工作项 ${item.number}`} busy={busy} onClose={onClose}>
    <header className="plane-item-head">
      <div><span className="plane-card-number">{item.number}</span><h2 className="modal-title">{detail?.title ?? item.title}</h2></div>
      <button type="button" className="tb-button tb-quiet" aria-label="关闭工作项" disabled={busy} onClick={onClose}>关闭</button>
    </header>
    <div className="plane-item-body">
      {loading && <p role="status" className="tb-empty">正在读取工作项…</p>}
      {error && <div className="tb-error plane-item-error" role="alert">
        <span>{error}</span><button type="button" className="tb-button" disabled={busy || loading} onClick={() => void load()}>重新读取</button>
      </div>}
      {detail && <>
        <div className="plane-item-byline"><span>提出人 {detail.creator}</span>
          {status && <span>{planeStateName(status.name)}</span>}
          {detail.archived && <span>已归档</span>}
        </div>
        {writable ? <form className="tb-form plane-item-form" onSubmit={(event) => { event.preventDefault(); if (editing) mutate({ action: "edit", fields }); }}>
          <fieldset disabled={busy || loading || !!confirm}>
            <label>标题<input value={fields.title ?? detail.title} maxLength={255} required onChange={(event) => field("title", event.target.value, detail.title)} /></label>
            <label>说明<textarea value={fields.description ?? detail.description} maxLength={60000} rows={4} onChange={(event) => field("description", event.target.value, detail.description)} /></label>
            <div className="plane-item-properties">
              <label>状态<select value={fields.stateId ?? detail.stateId ?? ""} onChange={(event) => field("stateId", event.target.value, detail.stateId ?? undefined)}>
                {!detail.stateId && <option value="" disabled>无状态</option>}
                {board.states.map((state) => <option key={state.id} value={state.id}>{planeStateName(state.name)}</option>)}
              </select></label>
              <label>优先级<select value={fields.priority ?? detail.priority} onChange={(event) => field("priority", event.target.value as PlaneWorkItem["priority"], detail.priority)}>
                {Object.entries(PLANE_PRIORITIES).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select></label>
              <label>开始日期<input type="date" value={("startDate" in fields ? fields.startDate : detail.startDate) ?? ""} onChange={(event) => field("startDate", event.target.value || null, detail.startDate)} /></label>
              <label>截止日期<input type="date" value={("dueDate" in fields ? fields.dueDate : detail.dueDate) ?? ""} onChange={(event) => field("dueDate", event.target.value || null, detail.dueDate)} /></label>
            </div>
            <div className="plane-item-properties">
              <details className="plane-check-list"><summary>执行者 <span>{(fields.assigneeIds ?? detail.assigneeIds).length}</span></summary>
                {board.members.length ? board.members.map((member) => {
                  const ids = fields.assigneeIds ?? detail.assigneeIds;
                  return <label key={member.id}><input type="checkbox" checked={ids.includes(member.id)} onChange={(event) => field(
                    "assigneeIds", event.target.checked ? [...ids, member.id] : ids.filter((id) => id !== member.id), detail.assigneeIds,
                  )} />{member.name}</label>;
                }) : <p className="tb-empty">没有可指派成员</p>}
              </details>
              <details className="plane-check-list"><summary>标签 <span>{(fields.labelIds ?? detail.labelIds).length}</span></summary>
                {board.labels.length ? board.labels.map((label) => {
                  const ids = fields.labelIds ?? detail.labelIds;
                  return <label key={label.id}><input type="checkbox" checked={ids.includes(label.id)} onChange={(event) => field(
                    "labelIds", event.target.checked ? [...ids, label.id] : ids.filter((id) => id !== label.id), detail.labelIds,
                  )} />{label.name}</label>;
                }) : <p className="tb-empty">此项目没有标签</p>}
              </details>
            </div>
            <div className="plane-edit-actions">
              {editing && <button type="button" className="tb-button" onClick={() => setFields({})}>取消修改</button>}
              <button type="submit" className="tb-button tb-primary" disabled={!editing}>保存修改</button>
            </div>
          </fieldset>
        </form> : <p className="tb-text">{detail.description || "暂无说明"}</p>}
        {attachments(detail.files)}
        <section className="plane-comments" aria-labelledby="plane-comments-heading">
          <h3 id="plane-comments-heading">评论 <span>{detail.comments.length}</span></h3>
          {detail.comments.length ? <ol>{detail.comments.map((entry) => <li key={entry.id}>
            <div className="tb-between"><strong>{entry.author}</strong><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString("zh-CN")}</time></div>
            <p className="tb-text">{entry.text}</p>
            {attachments(entry.files)}
            {writable && <div className="plane-comment-actions">
              {entry.canEdit && <button type="button" className="tb-button tb-quiet" disabled={busy || !!confirm} onClick={() => { setEditingComment(entry.id); setComment(entry.text); }}>编辑评论</button>}
              {entry.canDelete && <button type="button" className="tb-button tb-quiet soft-danger" disabled={busy || !!confirm} onClick={() => setConfirm(entry.id)}>删除评论</button>}
            </div>}
          </li>)}</ol> : <p className="tb-empty">暂无评论</p>}
          {writable && <form className="tb-form" onSubmit={(event) => { event.preventDefault(); mutate({ action: "comment", text: comment.trim(), commentId: editingComment }); }}>
            <label>{editingComment ? "修改评论" : "写评论"}<textarea value={comment} maxLength={6000} rows={2} disabled={busy || loading || !!confirm} onChange={(event) => setComment(event.target.value)} /></label>
            <div className="plane-edit-actions">
              {editingComment && <button type="button" className="tb-button" disabled={busy} onClick={() => { setEditingComment(undefined); setComment(""); }}>取消编辑评论</button>}
              <button type="submit" className="tb-button tb-primary" disabled={busy || loading || !!confirm || !comment.trim()}>{editingComment ? "保存评论" : "发表评论"}</button>
            </div>
          </form>}
        </section>
      </>}
    </div>
    {detail && <footer className="plane-item-foot">
      {confirm ? <>
        <p role="status">{confirm === "delete" ? `删除 ${detail.number}？这会从 Plane 项目删除该工作项。` : "删除这条 Plane 评论？"}</p>
        <div className="tb-row">
          <button type="button" className="tb-button" disabled={busy} onClick={() => setConfirm(null)}>取消</button>
          <button type="button" className="btn-danger" disabled={busy} onClick={() => mutate(confirm === "delete" ? { action: "delete" } : { action: "delete-comment", commentId: confirm })}>确认删除</button>
        </div>
      </> : <>
        <div className="tb-row">
          <button type="button" className="tb-button tb-quiet" disabled={busy || !window.amo?.openExternal} onClick={() => void run(async () => { await window.amo?.openExternal?.(detail.url); })}>在 Plane 打开</button>
          {board.writable && <button type="button" className="tb-button" disabled={busy || loading || editing} onClick={() => mutate({ action: detail.archived ? "restore" : "archive" })}>{detail.archived ? "恢复工作项" : "归档工作项"}</button>}
          {detail.canDelete && <button type="button" className="tb-button tb-quiet soft-danger" disabled={busy || loading} onClick={() => setConfirm("delete")}>删除工作项</button>}
        </div>
        {!detail.archived && <div className="tb-row plane-copy">
          {projects && <select aria-label="复制到本地项目" disabled={busy} value={target?.id ?? ""} onChange={(event) => onProject(event.target.value)}>
            <option value="">选择本地项目</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>}
          <button type="button" className="tb-button" title={target ? `创建到「${target.name}」，并把当前 Plane 账号加为执行人` : "请选择本地项目"} disabled={busy || loading || editing || !target} onClick={() => void run(onCopy)}>创建个人任务</button>
        </div>}
      </>}
    </footer>}
  </Modal>;
}
