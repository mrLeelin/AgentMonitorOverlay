import { useState } from "react";
import type { Id, SharedContextView, Task, TaskResult, TaskWorkflow as Workflow } from "@amo-studio/protocol";
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
    <span className="side-note">下级（含二级主控）的交付由直属主控验收或退回；总主控的最终交付等待你在这里明确验收或退回，通过后才完成。</span>
    {error && <span className="error" role="alert">交付状态读取失败：{error}</span>}
    {retryError && <span className="error" role="alert">通知重试失败：{retryError}</span>}
    {workflow.deliveryIssues?.map((issue) => <div key={issue.id} className="workflow-delivery-issue" data-testid="workflow-delivery-issue" role="status"><strong>主控通知发送失败</strong><p className="workflow-text">{issue.detail}</p><button type="button" className="link-btn" disabled={retrying === issue.id} onClick={() => { setRetryError(""); setRetrying(issue.id); void call(link, "POST /api/tasks/:id/workflow/retry-notice", { id: task.id, noticeId: issue.id }).catch((err: unknown) => setRetryError(err instanceof Error ? err.message : String(err))).finally(() => setRetrying(null)); }}>{retrying === issue.id ? "正在重试…" : "重试通知"}</button><button type="button" className="link-btn" onClick={() => onOpenTask(issue.taskId)}>进入相关任务</button></div>)}
    {!!workflow.deliveryNotices?.length && <details data-testid="workflow-delivery-history"><summary>管理通知 · {workflow.deliveryNotices.filter((n) => n.state === "waiting").length} 条等待发送 · 查看历史</summary>{workflow.deliveryNotices.map((notice) => <div key={notice.id} className="workflow-text" data-testid="workflow-notice" data-state={notice.state}><strong>{{ waiting: "等待发送", delivered: "已送入会话", expired: "已过期", failed: "发送失败" }[notice.state]}</strong><p>{notice.detail}</p>{notice.replacesNoticeId && <span className="dim">已按当前要求重新生成，原通知保留在历史中。</span>}</div>)}</details>}
    {!error && workflow.results.length === 0 && <span className="side-note" data-testid="workflow-empty">还没有提交结果。主控会在这里收齐各负责人的交付。</span>}
    {workflow.results.map((result) => { const view = contexts[result.taskId]; const binding = view?.binding; const mismatch = result.contextMismatch || (binding && (!view.validBinding ? "原共同需求归属已失效。" : result.contextBasis?.contextId !== binding.contextId || result.contextBasis?.version !== binding.version ? "实际交付依据与当前任务要求不同。" : "")); return <details key={result.id} className="workflow-result" data-testid="workflow-result" data-state={result.state}>
      <summary><span>{title(result.taskId)}</span><span className="workflow-state">{!result.managerTaskId && result.state === "submitted" ? "待用户审核" : !result.managerTaskId && result.state === "accepted" && result.reviewedBy === "user" ? "用户已验收" : !result.managerTaskId && result.state === "accepted" && !result.reviewedBy ? "历史交付" : RESULT_LABEL[result.state]}</span></summary>
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
      {result.state === "submitted" && !result.managerTaskId && tasks.some((t) => t.id === result.taskId && t.lead && !t.managerTaskId && !t.archivedAt && !t.remote) && workflow.results.filter((r) => r.taskId === result.taskId).at(-1)?.id === result.id && <UserReview key={result.id} link={link} result={result} mismatch={!!mismatch} />}
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

function UserReview({ link, result, mismatch }: { link: HostLink; result: TaskResult; mismatch: boolean }) {
  const [review, setReview] = useState("");
  const [explanation, setExplanation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (accept: boolean) => {
    setPending(true); setError("");
    try { await call(link, "POST /api/tasks/:id/workflow/user-review", { id: result.taskId }, { resultId: result.id, accept, review: review.trim() || "用户验收通过", ...(explanation.trim() ? { contextExplanation: explanation.trim() } : {}) }); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  };
  return <div className="workflow-user-review" data-testid="workflow-user-review">
    <strong>等待你审核最终交付</strong>
    <p className="side-note">核对成果与验证记录后点击验收；需要修改请填写原因并退回。AI 不能自行通过这项审核。</p>
    <label>验收意见或退回原因<textarea value={review} maxLength={20_000} disabled={pending} onChange={(e) => setReview(e.target.value)} placeholder="验收时可补充意见；退回时必须填写修改要求" /></label>
    {mismatch && <label>依据差异处理说明<textarea value={explanation} maxLength={20_000} disabled={pending} onChange={(e) => setExplanation(e.target.value)} placeholder="如接受版本差异，说明为什么不影响此次交付；无效前置结果仍需重新交付" /></label>}
    {error && <p className="error" role="alert">审核未完成：{error}</p>}
    <div className="workflow-review-actions"><button type="button" disabled={pending} onClick={() => void submit(true)}>{pending ? "正在处理…" : "验收通过"}</button><button type="button" disabled={pending || !review.trim()} onClick={() => void submit(false)}>退回修改</button></div>
  </div>;
}
