import { useState } from "react";
import { taskManagement, type Id, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { COLUMN_NAMES } from "../lib/status.js";
import { TaskWorkflow } from "./TaskWorkflow.js";

/** The person's assignment controls: membership comes from the task, never from a canvas line. */
export function TaskManagement({ link, task, tasks, onOpenTask, onDescribe }: { link: HostLink; task: Task; tasks: readonly Task[]; onOpenTask(id: Id): void; onDescribe?(id: Id): void }) {
  const tree = taskManagement(tasks, task.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const manager = tasks.find((t) => t.id === task.managerTaskId);
  const descendants = new Set(tree.descendants.map((t) => t.id));
  const candidates = tasks.filter((t) => t.lead && !t.archivedAt && !t.remote && t.id !== task.id && !descendants.has(t.id) && (task.topicId ? t.topicId === task.topicId : !t.topicId && t.workspaceId === task.workspaceId));
  const assign = async (managerTaskId: string) => {
    setBusy(true);
    setError("");
    try { await call(link, "PATCH /api/tasks/:id", { id: task.id }, { managerTaskId: managerTaskId || null }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const branch = (parentId: Id, seen: ReadonlySet<Id>) => tasks.filter((t) => descendants.has(t.id) && t.managerTaskId === parentId && !seen.has(t.id)).map((t) => {
    const children = tasks.some((c) => descendants.has(c.id) && c.managerTaskId === t.id);
    const row = <div className="management-task-row"><button type="button" className="link-btn" onClick={() => onOpenTask(t.id)}>{t.lead ? "主控 · " : ""}{t.title || "未命名任务"}</button><span className="dim">{COLUMN_NAMES[t.column]}</span>{onDescribe && <button type="button" className="link-btn" onClick={() => onDescribe(t.id)}>分配工作</button>}</div>;
    return children ? <details key={t.id} open className="management-branch"><summary>{row}</summary>{branch(t.id, new Set([...seen, t.id]))}</details> : <div key={t.id} className="management-leaf">{row}</div>;
  });
  return <div className="task-management" data-testid="task-management">
    {task.lead && !task.remote && <TaskWorkflow link={link} task={task} tasks={tasks} onOpenTask={onOpenTask} />}
    <span className="side-subheading">直属主控</span>
    {manager ? <button type="button" className="link-btn management-manager" onClick={() => onOpenTask(manager.id)}>{manager.title || "未命名主控"}</button> : <span className="side-note">{task.lead && !task.managerTaskId ? "这是总主控，你在这里提需求并接收汇总交付。" : "未分配主控"}</span>}
    {!task.archivedAt && !task.remote && <label className="stack-field"><span>{manager ? "转交 / 解除归属" : "设置直属主控"}</span><select aria-label="直属主控" value={task.managerTaskId ?? ""} disabled={busy} onChange={(e) => void assign(e.target.value)}><option value="">未分配</option>{candidates.map((t) => <option key={t.id} value={t.id}>{t.title || "未命名主控"}</option>)}</select></label>}
    {error && <span className="error" role="alert">{error}</span>}
    {task.lead && <><span className="side-subheading">管理范围 · {tree.directLeadCount} 个直属主控 · {tree.workerCount} 个下辖执行任务</span><span className="side-note">直属 {tree.direct.length} 个任务，全部下辖 {tree.descendants.length} 个。展开下级主控查看层级；进入受管任务可转交归属。</span>{tree.direct.length ? <div className="management-tree">{branch(task.id, new Set([task.id]))}</div> : <span className="side-note">尚未分配受管任务。旧任务需明确设置归属。</span>}</>}
  </div>;
}
