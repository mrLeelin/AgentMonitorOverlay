import { useState } from "react";
import { taskManagement, type ContextSource, type Session, type SharedContext, type SharedContextView, type Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import "./context.css";

const SOURCE_LABEL = { user_requirement: "用户明确要求", lead_agreement: "主控约定", suggestion: "可选建议" } as const;
const EMPTY: SharedContextView = { context: null, binding: null, validBinding: false, receipts: [], prerequisiteResultIds: [] };

export function contextStatus(view: SharedContextView): string {
  if (!view.binding) return "未绑定共同需求";
  if (!view.validBinding) return "归属待核对";
  const current = view.receipts.filter((r) => r.requirementId === view.binding!.id && r.taskId === view.binding!.taskId && r.contextId === view.binding!.contextId && r.version === view.binding!.version);
  return current.some((r) => r.adoptedAt) ? "已声明采用" : current.some((r) => r.deliveredAt) ? "等待执行者采用" : current.some((r) => r.queuedAt) ? "更新已排队" : "等待送入会话";
}

/** Reading this panel never impersonates an agent's declaration of adoption. */
export function TaskContext({ link, task, tasks, session }: { link: HostLink; task: Task; tasks: readonly Task[]; session: Session | null }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [view, , reload] = useLiveResource<SharedContextView>({
    load: () => call(link, "GET /api/tasks/:id/context", { id: task.id }).then((v) => { setError(""); return v; }), initial: EMPTY, reset: true,
    reloadOn: (e) => e.type === "task.upserted", reloadDelay: 80,
    onError: () => setError("共同需求暂时无法读取，请稍后重试。"),
  }, [link, task.id]);
  const root = task.lead && !task.managerTaskId;
  const state = contextStatus(view);
  const pending = !!view.binding && state !== "已声明采用";
  const version = view.binding?.version;
  const required = view.context?.versions.find((v) => v.version === version);
  const [editing, setEditing] = useState(false);
  const canEdit = root && !task.archivedAt && !task.remote && session?.kind === "main" && !session.archivedAt && session.writer !== "archived";
  return <>
    <button type="button" className={`link-btn task-context-toggle${pending ? " context-pending" : ""}`} data-testid="task-context-toggle" onClick={() => setOpen(true)}>
      共同需求 · {error ? "暂不可读" : pending ? "待处理更新" : root ? "查看" : view.binding ? `要求第 ${version} 版` : "未绑定"}
    </button>
    {open && <Modal className="task-context-dialog" label="共同需求" testId="task-context" portal onClose={() => { setOpen(false); setEditing(false); }}>
      <div className="context-heading"><div><span className="side-subheading">共同需求</span><h2>{view.context?.title || "由主控维护的共同需求"}</h2></div><button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>关闭</button></div>
      <p className="side-note">目标和变更继续告诉主控。主控负责整理、发布和安排任务，你无需逐项同步或确认已读。</p>
      {error ? <div role="alert" className="error">{error} <button type="button" className="link-btn" onClick={reload}>重试</button></div> : <>
        <div className="context-status" data-testid="context-status" data-pending={pending}>
          <strong>{state}</strong>
          <span>{view.binding ? `任务要求：第 ${version} 版` : "本任务未绑定，不推测采用版本。"}</span>
          {view.binding && <span>已声明采用：{[...new Set(view.receipts.filter((r) => r.adoptedAt).map((r) => r.version))].map((v) => `第 ${v} 版`).join("、") || "尚无声明"}</span>}
          {view.binding && !view.validBinding && <span>原要求已失效，请由当前主控核对归属并重新安排。</span>}
        </div>
        {required && <section className="context-document"><strong>本任务要求正文 · 第 {required.version} 版{!view.validBinding ? "（原归属记录）" : ""}</strong><p>{required.body}</p><Sources sources={required.sources} /><p className="dim">变更说明：{required.changeNote}</p></section>}
        {!view.binding && !root && <p className="side-note">保持原有任务与交付方式；同专题或画布引用不会自动绑定。</p>}
        {view.binding && <details className="context-section"><summary>会话接收与采用记录</summary><p className="side-note">排队、送入会话和声明采用分别记录。送入会话不代表理解；采用由执行者通过工具声明。</p><div className="context-table-wrap"><table><thead><tr><th>会话 / 版本</th><th>已排队</th><th>已送入</th><th>已声明采用</th></tr></thead><tbody>{view.receipts.map((r) => <tr key={`${r.sessionId}:${r.requirementId}`}><td>{r.sessionId === session?.id ? "当前会话" : r.sessionId} · 第 {r.version} 版{r.requirementId !== view.binding?.id && "（历史）"}</td><td>{r.queuedAt ? "是" : "—"}</td><td>{r.deliveredAt ? "是" : "—"}</td><td>{r.adoptedAt ? "是" : "—"}</td></tr>)}</tbody></table></div></details>}
        {view.context && <details className="context-section" data-testid="context-history"><summary>发布历史 · 当前发布第 {view.context.currentVersion ?? "尚未发布"} 版</summary><p className="side-note">发布不会自动升级任务。历史正文保持原样，回退也通过发布新版本表达。</p>{[...view.context.versions].reverse().map((v) => <details key={v.version} className="context-version"><summary>第 {v.version} 版 · {v.changeNote} <time>{new Date(v.publishedAt).toLocaleString()}</time></summary><p className="context-body">{v.body}</p><Sources sources={v.sources} /></details>)}</details>}
        {root && <Adoption link={link} task={task} tasks={tasks} />}
        {canEdit && <details className="context-section" data-testid="context-editor" onToggle={(e) => setEditing(e.currentTarget.open)}><summary>高级 · 查看与维护草稿</summary><p className="side-note">日常由主控在会话中维护。这里提供可选编辑，保存、发布和指定受影响任务分别操作。</p>{editing && <ContextEditor link={link} task={task} tasks={tasks} sessionId={session!.id} context={view.context} onChange={reload} />}</details>}
        {root && !canEdit && <p className="side-note">打开本总主控的本地主会话后，可选查看与维护草稿。</p>}
      </>}
    </Modal>}
  </>;
}

function Sources({ sources }: { sources: ContextSource[] }) {
  return <ul className="context-sources">{sources.map((s, i) => <li key={i}><span>{SOURCE_LABEL[s.kind]}</span> {s.source}</li>)}</ul>;
}

function Adoption({ link, task, tasks }: { link: HostLink; task: Task; tasks: readonly Task[] }) {
  const members = [task, ...taskManagement(tasks, task.id).descendants];
  const [data] = useLiveResource<Array<{ task: Task; view: SharedContextView | null }>>({
    // A large tree should not create an unbounded fan-out of HTTP requests.
    load: async () => { const rows: Array<{ task: Task; view: SharedContextView | null }> = []; for (const member of members) { try { rows.push({ task: member, view: await call(link, "GET /api/tasks/:id/context", { id: member.id }) }); } catch { rows.push({ task: member, view: null }); } } return rows; },
    initial: [], reset: true, reloadOn: (e) => e.type === "task.upserted", reloadDelay: 100,
  }, [link, JSON.stringify(members.map((m) => [m.id, m.column]))]);
  return <details className="context-section" data-testid="context-adoption"><summary>任务采用情况 · 仅明确管理范围</summary><div className="context-table-wrap"><table><thead><tr><th>任务</th><th>要求版本</th><th>进展</th></tr></thead><tbody>{data.map(({ task: member, view }) => <tr key={member.id}><td>{member.title || "未命名任务"}{member.column === "done" && "（已完成）"}</td><td>{view?.binding ? `第 ${view.binding.version} 版` : "未绑定"}</td><td>{view ? contextStatus(view) : "暂不可读"}</td></tr>)}</tbody></table></div></details>;
}

function ContextEditor({ link, task, tasks, sessionId, context, onChange }: { link: HostLink; task: Task; tasks: readonly Task[]; sessionId: string; context: SharedContext | null; onChange(): void }) {
  const [base, setBase] = useState(context);
  const [title, setTitle] = useState(context?.title ?? "共同需求");
  const [body, setBody] = useState(context?.draft.body ?? "");
  const [note, setNote] = useState(context?.draft.changeNote ?? "");
  const [sources, setSources] = useState<ContextSource[]>(context?.draft.sources ?? [{ kind: "user_requirement", source: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [applyVersion, setApplyVersion] = useState(context?.currentVersion ?? 0);
  const dirty = title !== base?.title || body !== base?.draft.body || note !== base?.draft.changeNote || JSON.stringify(sources) !== JSON.stringify(base?.draft.sources);
  const changedElsewhere = (context?.revision ?? 0) > (base?.revision ?? 0);
  const candidates = [task, ...taskManagement(tasks, task.id).descendants].filter((t) => !t.archivedAt && !t.remote && t.column !== "done");
  const reset = () => { setBase(context); setTitle(context?.title ?? "共同需求"); setBody(context?.draft.body ?? ""); setNote(context?.draft.changeNote ?? ""); setSources(context?.draft.sources ?? [{ kind: "user_requirement", source: "" }]); setError(""); };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); setNotice(""); try { await fn(); onChange(); } catch (err) { setError(err instanceof HostApiError && err.status === 409 ? "共同需求已被其他会话更新。你的编辑仍保留，请核对发布历史后重新读取草稿并合并。" : err instanceof Error ? err.message : "操作未完成，请重试。"); } finally { setBusy(false); } };
  return <div className="context-editor-fields">
    {(changedElsewhere || error) && <div className="context-conflict" role="status">{error || "共同需求已有新的修改。当前编辑保留，保存前请合并。"}<button type="button" className="link-btn" disabled={busy} onClick={reset}>放弃当前编辑并重新读取草稿</button></div>}
    <label className="stack-field">标题<input aria-label="共同需求标题" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
    <label className="stack-field">正文<textarea aria-label="共同需求正文" rows={7} maxLength={100000} value={body} onChange={(e) => setBody(e.target.value)} /></label>
    <label className="stack-field">变更说明<textarea aria-label="共同需求变更说明" rows={2} maxLength={10000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
    {sources.map((s, i) => <div className="context-source-edit" key={i}><select aria-label={`来源性质 ${i + 1}`} value={s.kind} onChange={(e) => setSources(sources.map((v, n) => n === i ? { ...v, kind: e.target.value as ContextSource["kind"] } : v))}>{Object.entries(SOURCE_LABEL).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select><input aria-label={`需求来源 ${i + 1}`} maxLength={4000} placeholder="来源或约定依据" value={s.source} onChange={(e) => setSources(sources.map((v, n) => n === i ? { ...v, source: e.target.value } : v))} /><button type="button" className="link-btn" disabled={sources.length === 1 || busy} onClick={() => setSources(sources.filter((_, n) => n !== i))}>移除</button></div>)}
    <button type="button" className="link-btn" disabled={sources.length >= 100 || busy} onClick={() => setSources([...sources, { kind: "lead_agreement", source: "" }])}>添加来源</button>
    <div className="context-actions"><button type="button" className="btn-ghost small" disabled={busy || !dirty || changedElsewhere || !body.trim() || !note.trim() || !title.trim() || sources.some((s) => !s.source.trim())} onClick={() => void run(async () => { const next = await call(link, "POST /api/shared-context/save", {}, { sessionId, rootTaskId: task.id, baseRevision: base?.revision ?? 0, title, body, changeNote: note, sources }); setBase(next); setNotice("草稿已保存，尚未发布。"); })}>保存草稿</button><button type="button" className="btn-primary small" disabled={busy || !base || dirty || changedElsewhere} onClick={() => void run(async () => { const next = await call(link, "POST /api/shared-context/publish", {}, { sessionId, contextId: base!.id, baseRevision: base!.revision }); setBase(next); setApplyVersion(next.currentVersion!); setNotice("已发布。任务要求保持原样，下面可指定受影响任务。"); })}>发布已保存草稿</button></div>
    {base?.versions.length ? <fieldset className="context-apply"><legend>指定受影响任务</legend><p className="side-note">只升级勾选的任务。已完成任务保留原依据，需要继续工作时先明确重新开始。</p><select aria-label="应用需求版本" value={applyVersion} onChange={(e) => setApplyVersion(Number(e.target.value))}>{base.versions.map((v) => <option key={v.version} value={v.version}>第 {v.version} 版 · {v.changeNote}</option>)}</select><div className="context-task-choices">{candidates.map((t) => <label key={t.id}><input type="checkbox" checked={selected.includes(t.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, t.id] : selected.filter((id) => id !== t.id))} />{t.title || "未命名任务"}</label>)}</div><button type="button" className="btn-ghost small" disabled={busy || !selected.length || !applyVersion || changedElsewhere} onClick={() => void run(async () => { await call(link, "POST /api/shared-context/apply", {}, { sessionId, contextId: base.id, version: applyVersion, taskIds: selected }); setSelected([]); setNotice("已更新所选任务要求，等待执行者接收并声明采用。"); })}>更新所选任务要求</button></fieldset> : null}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
