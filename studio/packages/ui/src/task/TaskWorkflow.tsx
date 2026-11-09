import { useState } from "react";
import type { DecisionRequest, Id, Task, TaskResult } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import "./workflow.css";

const RESULT_LABEL = { submitted: "待主控验收", accepted: "已验收", returned: "已退回" } as const;
type Workflow = { rootTaskId: Id | null; results: TaskResult[]; decisions: DecisionRequest[]; deliveryIssues?: Array<{ id: Id; taskId: Id; detail: string }> };

/** The board remains inspectable while the manager handles routine decisions and verifies deliveries. */
export function TaskWorkflow({ link, task, tasks, onOpenTask }: { link: HostLink; task: Task; tasks: readonly Task[]; onOpenTask(id: Id): void }) {
  const [error, setError] = useState("");
  const [workflow] = useLiveResource<Workflow>({
    load: () => call(link, "GET /api/tasks/:id/workflow", { id: task.id }).then((value) => { setError(""); return value; }),
    initial: { rootTaskId: null, results: [], decisions: [] },
    reset: true,
    reloadOn: (event) => event.type === "task.upserted" || event.type === "decision.upserted" || event.type === "task.note.added",
    reloadDelay: 60,
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  }, [link, task.id]);
  const title = (id: Id) => tasks.find((t) => t.id === id)?.title || "未命名任务";
  return <section className="task-workflow" data-testid="task-workflow" aria-label="交付与验收">
    <div className="workflow-heading"><strong>交付与验收</strong><span className="dim">{workflow.results.filter((r) => r.state === "submitted").length} 项待验收 · {workflow.decisions.length} 个问题待主控处理</span></div>
    <span className="side-note">下级提交结果，由直属主控验收或退回；总主控整合后向你交付。</span>
    {error && <span className="error" role="alert">交付状态读取失败：{error}</span>}
    {workflow.deliveryIssues?.map((issue) => <div key={issue.id} className="workflow-delivery-issue" data-testid="workflow-delivery-issue" role="status"><strong>主控通知尚未送达</strong><p className="workflow-text">{issue.detail}</p><button type="button" className="link-btn" onClick={() => onOpenTask(issue.taskId)}>进入相关任务</button></div>)}
    {!error && workflow.results.length === 0 && <span className="side-note" data-testid="workflow-empty">还没有提交结果。主控会在这里收齐各负责人的交付。</span>}
    {workflow.results.map((result) => <details key={result.id} className="workflow-result" data-testid="workflow-result" data-state={result.state}>
      <summary><span>{title(result.taskId)}</span><span className="workflow-state">{result.state === "accepted" && !result.managerTaskId ? "已交付" : RESULT_LABEL[result.state]}</span></summary>
      <p className="workflow-text">{result.summary}</p>
      <strong>验证记录</strong><p className="workflow-text">{result.verification}</p>
      {result.review && <><strong>验收意见</strong><p className="workflow-text">{result.review}</p></>}
      <button type="button" className="link-btn" onClick={() => onOpenTask(result.taskId)}>进入任务</button>
    </details>)}
    {workflow.decisions.map((decision) => <div key={decision.id} className="workflow-decision" data-testid="workflow-decision">
      <span className="dim">{decision.taskId ? title(decision.taskId) : "下级任务"} · 待主控处理</span>
      <p className="workflow-text">{decision.question}</p>
      {decision.options.length > 0 && <span className="dim">{decision.options.join(" / ")}</span>}
      {decision.taskId && <button type="button" className="link-btn" onClick={() => onOpenTask(decision.taskId!)}>查看来源任务</button>}
    </div>)}
  </section>;
}
