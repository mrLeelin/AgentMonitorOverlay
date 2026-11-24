import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { LinkedTeamTask, TeamTask, TeamTaskChange, TeamTaskFile, TeamTaskInboxItem, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showError, showToast } from "../lib/toast.js";
import type { Scope } from "../board/Board.js";
import { readTeamTaskFiles, TeamStatus, TeamTaskHistory } from "./shared.js";
import "./teamtasks.css";

export const TEAM_TASK_DRAG = "application/x-amo-team-task";
export type TeamDrop = { available: boolean; import(id: string): void };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");

async function save(ticket: string, file: TeamTaskFile): Promise<void> {
  if (!window.amo?.saveTeamTaskAttachment) throw new Error("请更新并重新打开 AMO Studio 后，再保存附件");
  await window.amo.saveTeamTaskAttachment(ticket, file.id, file.name);
}

export function StudioTeamInbox({ link, scope, workspaces, onOpen, children }: { link: HostLink; scope: Scope; workspaces: readonly Workspace[]; onOpen(id: string): void; children(drop?: TeamDrop): ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string | null>();
  const [list, setList] = useState<TeamTaskInboxItem[]>([]);
  const [selection, setSelection] = useState<string>();
  const [selected, setSelected] = useState<TeamTask | null>(null);
  const [mode, setMode] = useState<"new" | "local">("new");
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const importing = useRef(false);
  const request = useRef(0);
  const projects = workspaces.filter((workspace) => !workspace.archivedAt && !workspace.builtin);
  const filtered = mode === "new" ? list.filter((ticket) => !ticket.localTaskId && ticket.status !== "done") : list.filter((ticket) => ticket.localTaskId);
  const activeId = filtered.find((ticket) => ticket.id === selection)?.id ?? filtered[0]?.id;
  const scopeTarget = scope.kind === "workspace" && projects.some((p) => p.id === scope.id) ? scope.id : "";
  const targetId = scopeTarget || projects.find((p) => p.id === project)?.id || "";

  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    setError("");
    try {
      const info = await call(link, "GET /api/team-tasks");
      if (token !== request.current) return;
      setName(info.name);
      setList(info.tickets);
    } catch (err) {
      if (token === request.current) setError(message(err));
    } finally {
      if (token === request.current) setLoading(false);
    }
  }, [link]);

  useEffect(() => {
    if (open) void refresh();
    return () => { request.current++; };
  }, [open, refresh]);

  useEffect(() => {
    let active = true;
    setSelected(null);
    if (open && activeId) void call(link, "GET /api/team-tasks/:id", { id: activeId }).then((ticket) => {
      if (active) setSelected(ticket);
    }, (err: unknown) => { if (active) setError(message(err)); });
    return () => { active = false; };
  }, [link, open, activeId, list]);

  async function importTicket(id: string) {
    if (importing.current) return;
    const ticket = list.find((item) => item.id === id);
    if (!ticket) return;
    if (ticket.localTaskId) { onOpen(ticket.localTaskId); return; }
    const workspaceId = targetId;
    if (!workspaceId) { setError("选好本地项目后，再加入本地待办"); return; }
    importing.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await call(link, "POST /api/team-tasks/:id/import", { id }, { workspaceId, ...(scope.kind === "topic" ? { topicId: scope.id } : {}) });
      setList((old) => old.map((item) => item.id === id ? { ...item, localTaskId: result.task.id } : item));
      setMode("local");
      setSelection(id);
      if (result.existing) onOpen(result.task.id);
      else showToast(`已加入 ${projects.find((p) => p.id === workspaceId)?.name ?? "项目"} 的待办`);
    } catch (err) { setError(message(err)); }
    finally { importing.current = false; setBusy(false); }
  }

  const localId = list.find((ticket) => ticket.id === selected?.id)?.localTaskId;
  return <div className="tt-board-shell">
    <div className="tt-board-bar"><button type="button" className="tt-button" aria-expanded={open} aria-controls="team-task-inbox" onClick={() => setOpen(!open)}>团队任务</button></div>
    <div className={`tt-board-row${open ? " has-inbox" : ""}`}>
      {children(open && name && mode === "new" && !!filtered.length ? { available: !!targetId, import: (id) => void importTicket(id) } : undefined)}
      {open && <aside className="tt-panel" id="team-task-inbox" aria-label="团队任务收件箱">
        <div className="tt-between"><h2>团队任务</h2><button className="tt-button" type="button" disabled={loading || busy} onClick={() => void refresh()}>刷新</button></div>
        {error && <p className="tt-error" role="alert">{error}</p>}
        {loading && <p className="tt-muted" role="status">正在读取团队任务…</p>}
        {name === null && !loading && <p className="tt-empty">请先在 AMO 平台里登录，再点刷新。</p>}
        {name && <>
          <div className="tt-tabs"><button type="button" aria-pressed={mode === "new"} onClick={() => setMode("new")}>待接入 {list.filter((ticket) => !ticket.localTaskId && ticket.status !== "done").length}</button><button type="button" aria-pressed={mode === "local"} onClick={() => setMode("local")}>已加入本地 {list.filter((ticket) => ticket.localTaskId).length}</button></div>
          <div className="tt-list">{filtered.length === 0 && <p className="tt-muted tt-empty">{mode === "new" ? "暂无分配给你的任务。" : "接入的任务会显示在这里。"}</p>}{filtered.map((ticket) => (
            <button type="button" key={ticket.id} className="tt-ticket" aria-current={activeId === ticket.id} draggable={mode === "new" && !busy && !!targetId} onClick={() => setSelection(ticket.id)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData(TEAM_TASK_DRAG, ticket.id); }}>
              <strong>{ticket.title}</strong><span className="tt-between"><span>提交人 {ticket.creator}</span><TeamStatus status={ticket.status} /></span>
            </button>
          ))}</div>
          {selected && <section className="tt-inbox-detail" aria-label="团队原单预览">
            <div className="tt-between"><h3>{selected.title}</h3><TeamStatus status={selected.status} /></div>
            <p className="tt-muted tt-task-meta">提交人 {selected.creator}</p>
            <p className="tt-copy">{selected.description}</p>
            {localId ? <div className="tt-import"><button type="button" className="tt-button" onClick={() => onOpen(localId)}>查看本地任务</button></div> : <div className="tt-import">
              {!scopeTarget && <label className="tt-muted">加入本地项目<select disabled={busy || projects.length === 0} value={targetId} onChange={(event) => setProject(event.target.value)}><option value="">{projects.length ? "请选择项目" : "请先添加本地项目"}</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
              {scopeTarget && <p className="tt-muted">加入 {projects.find((p) => p.id === scopeTarget)?.name} 的待办</p>}
              <button type="button" className="tt-button tt-solid" disabled={busy || !targetId} onClick={() => void importTicket(selected.id)}>{busy ? "正在加入…" : "加入本地待办"}</button>
            </div>}
            <TeamTaskHistory ticket={selected} onFile={(file) => void save(selected.id, file).catch((err) => setError(message(err)))} />
          </section>}
        </>}
      </aside>}
    </div>
  </div>;
}

export function LocalTeamTask({ link, taskId, archived }: { link: HostLink; taskId: string; archived: boolean }) {
  const [value, setValue] = useState<LinkedTeamTask | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const detail = await call(link, "GET /api/team-tasks/local/:id", { id: taskId });
      if (current === generation.current) {
        setValue(detail);
        if (detail?.ticket.status !== "doing") setDelivering(false);
        setError("");
      }
    } catch (err) {
      if (current === generation.current && (!(err instanceof HostApiError) || (err.code !== "not_found" && err.status !== 404))) setError(message(err));
    }
  }, [link, taskId]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!open || busy || delivering) return;
    const timer = setInterval(() => void refresh(), 7000);
    return () => clearInterval(timer);
  }, [open, busy, delivering, refresh]);

  async function change(action: TeamTaskChange["action"], event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!value) return;
    const input = event && new FormData(event.currentTarget);
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const files = await readTeamTaskFiles(input ? input.getAll("files").filter((file): file is File => file instanceof File && !!file.name) : []);
      const updated = await call(link, "POST /api/team-tasks/local/:id/change", { id: taskId }, { revision: value.ticket.revision, action, text: input ? String(input.get("text")) : "", files });
      setValue(updated);
      setDelivering(false);
      showToast(action === "deliver" ? "结果已发给提交人" : "已同步开工状态");
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }

  if (!value && !error) return null;
  const ticket = value?.ticket;
  return <section className="tt-local" aria-label="团队原单">
    <div className="tt-actions"><button type="button" className="tt-button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh(); }}>团队原单</button>{ticket && <TeamStatus status={ticket.status} />}</div>
    {(open || !ticket) && <div className="tt-local-content">
      {error && <p className="tt-error" role="alert">{error}</p>}
      {ticket && <><h3>{ticket.title}</h3><p className="tt-muted tt-task-meta">提交人 {ticket.creator}</p><p className="tt-copy">{ticket.description}</p><TeamTaskHistory ticket={ticket} onFile={(file) => void save(ticket.id, file).catch((err) => setError(message(err)))} /></>}
      {!archived && <div className="tt-actions">
        <button type="button" className="tt-button" disabled={busy} onClick={() => void refresh()}>刷新原单</button>
        {value?.needsStartSync && <button type="button" className="tt-button tt-solid" disabled={busy} onClick={() => void change("start")}>同步开工状态</button>}
        {ticket?.status === "doing" && !delivering && <button type="button" className="tt-button tt-solid" disabled={busy} onClick={() => setDelivering(true)}>提交结果</button>}
      </div>}
      {delivering && !archived && <form className="tt-form tt-feedback" onSubmit={(event) => void change("deliver", event)}>
        <label>处理说明和验证结果<textarea name="text" required maxLength={6000} /></label>
        <label>验证附件（选填）<input name="files" type="file" multiple /></label>
        <div className="tt-actions"><button className="tt-button tt-solid" disabled={busy}>{busy ? "正在提交…" : "提交给验收人"}</button><button className="tt-button" disabled={busy} type="button" onClick={() => setDelivering(false)}>取消</button></div>
      </form>}
    </div>}
  </section>;
}
