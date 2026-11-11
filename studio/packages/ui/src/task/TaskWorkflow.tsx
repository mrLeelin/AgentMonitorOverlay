import { useState } from "react";
import type { Id, SharedContextView, Task, TaskWorkflow as Workflow } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import "./workflow.css";
import "./context.css";

const RESULT_LABEL = { submitted: "待主控验收", accepted: "已验收", returned: "已退回" } as const;

/** The board remains inspectable while the manager handles routine decisions and verifies deliveries. */
export function TaskWorkflow({ link, task, tasks, onOpenTask }: { link: HostLink; task: Task; tasks: readonly Task[]; onOpenTask(id: Id): void }) {
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryError, setRetryError] = useState("");
  const [workflow] = useLiveResource<Workflow>({
    load: () => call(link, "GET /api/tasks/:id/workflow", { id: task.id }).then((value) => { setError(""); return value; }),
    initial: { rootTaskId: null, results: [], decisions: [], deliveryIssues: [] },
    reset: true,
    reloadOn: (event) => event.type === "task.upserted" || event.type === "decision.upserted" || event.type === "task.note.added" || event.type === "item.updated" && event.item.type === "user",
    reloadDelay: 60,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  }, [link, task.id]);
  const resultTasks = [...new Set(workflow.results.map((r) => r.taskId))];
  const [contexts] = useLiveResource<Record<string, SharedContextView>>({
    load: async () => { const views: Record<string, SharedContextView> = {}; for (const id of resultTasks) { try { views[id] = await call(link, "GET /api/tasks/:id/context", { id }); } catch { /* Missing data is shown as unavailable, never inferred. */ } } return views; },
    initial: {}, reset: true, reloadOn: (e) => e.type === "task.upserted", reloadDelay: 80,
  }, [link, task.id, JSON.stringify(resultTasks)]);
  const title = (id: Id) => tasks.find((t) => t.id === id)?.title || "未命名任务";
  return <section className="task-workflow" data-testid="task-workflow" aria-label="交付与验收">
    <div className="workflow-heading"><strong>交付与验收</strong><span className="dim">{workflow.results.filter((r) => r.state === "submitted").length} 项待验收 · {workflow.decisions.length} 个问题待主控处理</span></div>
    <span className="side-note">下级提交结果，由直属主控验收或退回；总主控整合后向你交付。</span>
    {error && <span className="error" role="alert">交付状态读取失败：{error}</span>}
    {retryError && <span className="error" role="alert">通知重试失败：{retryError}</span>}
    {workflow.deliveryIssues?.map((issue) => <div key={issue.id} className="workflow-delivery-issue" data-testid="workflow-delivery-issue" role="status"><strong>主控通知发送失败</strong><p className="workflow-text">{issue.detail}</p><button type="button" className="link-btn" disabled={retrying === issue.id} onClick={() => { setRetryError(""); setRetrying(issue.id); void call(link, "POST /api/tasks/:id/workflow/retry-notice", { id: task.id, noticeId: issue.id }).catch((err: unknown) => setRetryError(err instanceof Error ? err.message : String(err))).finally(() => setRetrying(null)); }}>{retrying === issue.id ? "正在重试…" : "重试通知"}</button><button type="button" className="link-btn" onClick={() => onOpenTask(issue.taskId)}>进入相关任务</button></div>)}
    {!!workflow.deliveryNotices?.length && <details data-testid="workflow-delivery-history"><summary>管理通知 · {workflow.deliveryNotices.filter((n) => n.state === "waiting").length} 条等待发送 · 查看历史</summary>{workflow.deliveryNotices.map((notice) => <div key={notice.id} className="workflow-text" data-testid="workflow-notice" data-state={notice.state}><strong>{{ waiting: "等待发送", delivered: "已送入会话", expired: "已过期", failed: "发送失败" }[notice.state]}</strong><p>{notice.detail}</p>{notice.replacesNoticeId && <span className="dim">已按当前要求重新生成，原通知保留在历史中。</span>}</div>)}</details>}
    {!error && workflow.results.length === 0 && <span className="side-note" data-testid="workflow-empty">还没有提交结果。主控会在这里收齐各负责人的交付。</span>}
    {workflow.results.map((result) => { const view = contexts[result.taskId]; const binding = view?.binding; const mismatch = result.contextMismatch || (binding && (!view.validBinding ? "原共同需求归属已失效。" : result.contextBasis?.contextId !== binding.contextId || result.contextBasis?.version !== binding.version ? "实际交付依据与当前任务要求不同。" : "")); return <details key={result.id} className="workflow-result" data-testid="workflow-result" data-state={result.state}>
      <summary><span>{title(result.taskId)}</span><span className="workflow-state">{result.state === "accepted" && !result.managerTaskId ? "已交付" : RESULT_LABEL[result.state]}</span></summary>
      <p className="workflow-text">{result.summary}</p>
      <strong>验证记录</strong><p className="workflow-text">{result.verification}</p>
      <div className="workflow-context" data-mismatch={!!mismatch}>
        <strong>交付依据</strong><p data-testid="workflow-context-basis">{result.contextBasis ? `实际依据：第 ${result.contextBasis.version} 版共同需求` : "未记录共同需求版本（旧任务不推测版本）"}</p>
        <p className="dim">{view ? binding ? `当前任务要求：第 ${binding.version} 版${!view.validBinding ? "（归属待核对）" : ""}` : "当前任务未绑定共同需求" : "当前任务要求暂不可读"}</p>
        {result.contextBasis && <details><summary>版本标识</summary><p className="workflow-text">{result.contextBasis.contextId}</p></details>}
        {mismatch && <div data-testid="workflow-context-mismatch" role="status"><strong>{result.state === "submitted" ? "依据差异待主控处理" : "依据差异记录"}</strong>{result.state === "submitted" ? <p className="side-note">成果已保留。主控需对照当前要求及有效前置结果，退回更新、明确调整要求，或在允许的差异范围说明不影响接受的原因。</p> : <p className="side-note">历史交付保留实际依据，当前任务的要求变化不改写这份记录。</p>}<details><summary>查看差异记录</summary><p className="workflow-text">{mismatch}</p></details></div>}
        {result.contextResolution && <p className="workflow-text">差异处理说明：{result.contextResolution.explanation}{result.contextResolution.requiredBasis ? `（对照要求第 ${result.contextResolution.requiredBasis.version} 版）` : ""}</p>}
        <details data-testid="workflow-prerequisites"><summary>前置交付依据 · {result.prerequisiteResultIds?.length ?? 0} 项</summary>{result.prerequisiteResultIds?.length ? result.prerequisiteResultIds.map((id) => { const source = workflow.results.find((r) => r.id === id); return <p className="workflow-text" key={id}>{source ? `${title(source.taskId)} · ${RESULT_LABEL[source.state]}` : "前置结果"}<br />{id}</p>; }) : <p className="side-note">未记录具体前置结果，不推测历史依据。</p>}</details>
      </div>
      {result.review && <><strong>验收意见</strong><p className="workflow-text">{result.review}</p></>}
      <button type="button" className="link-btn" onClick={() => onOpenTask(result.taskId)}>进入任务</button>
    </details>; })}
    {workflow.decisions.map((decision) => <div key={decision.id} className="workflow-decision" data-testid="workflow-decision">
      <span className="dim">{decision.taskId ? title(decision.taskId) : "下级任务"} · 待主控处理</span>
      <p className="workflow-text">{decision.question}</p>
      {decision.options.length > 0 && <span className="dim">{decision.options.join(" / ")}</span>}
      {decision.taskId && <button type="button" className="link-btn" onClick={() => onOpenTask(decision.taskId!)}>查看来源任务</button>}
    </div>)}
  </section>;
}
