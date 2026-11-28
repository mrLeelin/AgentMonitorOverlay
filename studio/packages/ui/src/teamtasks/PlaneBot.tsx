import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { HostEvent, PlaneBotExecutionChoice, PlaneBotJob, StudioBot, Task, Workspace } from "@amo-studio/protocol";
import { focusCanvasTarget } from "../bots/lead-navigation.js";
import { openReview } from "../gitreview/open.js";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { Markdown } from "../lib/markdown.js";
import { revealInExplorer } from "../lib/openin.js";
import { TaskWorkflow } from "../task/TaskWorkflow.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";
import { PlaneBotPlan, PlaneBotReplanControl } from "./PlaneBotPlan.js";
import "./plane-bot.css";

const status: Record<PlaneBotJob["state"], string> = {
  planning: "Bot 正在分析", "awaiting-approval": "计划待确认", starting: "正在启动执行任务", declined: "已放弃",
  executing: "Bot 已进入独立工作树", "awaiting-user": "需要你答复或授权", paused: "执行已暂停", review: "等待人工验收",
  sending: "已验收，正在回写 Plane", sent: "已回写 Plane 评论", failed: "Bot 执行失败",
};

function writebackFailed(job: Pick<PlaneBotJob, "state" | "error" | "failureStage">, taskDone = false): boolean {
  return job.state === "failed" && (job.failureStage === "writeback" || !job.failureStage && (taskDone || job.error === "不支持的工作项操作"));
}

export function planeBotStatus(job: Pick<PlaneBotJob, "state" | "error" | "failureStage" | "mode" | "baseDrift" | "requesterReview" | "manualIntake">, taskDone = false): string {
  if (job.state === "sent" && job.requesterReview === "confirmed") return "发起人已验收，可以归档";
  if (job.state === "sent" && job.requesterReview === "waiting") return "已通知发起人，等待验收";
  if (job.manualIntake && job.state === "review") return "请到工程中验收";
  if (job.manualIntake && job.state === "executing") return "机器人正在处理";
  if (writebackFailed(job, taskDone)) return job.mode === "managed" ? "已验收，回写待处理" : "交付已验收，Plane 回写失败";
  if (job.mode === "managed" && job.state === "executing") return job.baseDrift ? "基准已变化，等待重新批准" : "机器人带队";
  return status[job.state];
}

export function PlaneBotCanvasLink({ job }: { job: PlaneBotJob }) {
  const { rootTaskId, topicId } = job;
  if (!rootTaskId || !topicId || !window.amo?.openInWorkbench) return null;
  return <button type="button" className="btn-ghost small" onClick={() => void window.amo?.openInWorkbench?.(focusCanvasTarget(topicId, rootTaskId,
    !job.manualIntake && job.state === "review" && job.delivery ? { resultId: job.delivery.resultId } : undefined))}>{job.manualIntake ? "查看执行画布" : "打开专题画布"}</button>;
}

export function PlaneBotWritebackHistory({ job }: { job: PlaneBotJob }) {
  return !!job.writebackHistory?.length && <details className="plane-bot-writeback">
    <summary>Plane 回写记录 · {job.writebackHistory.length} 项</summary>
    <ul>{job.writebackHistory.map((receipt) => <li key={receipt.resultId}>
      <code>{receipt.resultId}</code> · {receipt.state === "sent" ? <>评论 <code>{receipt.commentId}</code></> : "回执待核对"}
      {receipt.state === "sent" && receipt.sentAt && <> · <time dateTime={receipt.sentAt}>{new Date(receipt.sentAt).toLocaleString()}</time></>}
    </li>)}</ul>
  </details>;
}

function checkActive(check: PlaneBotJob["check"]): boolean {
  return check?.status === "queued" || check?.status === "running" || check?.status === "waiting";
}

export function planeBotCheckChanged(job: PlaneBotJob | null, event: HostEvent): boolean {
  const check = job?.check;
  return event.type === "session.upserted" && check?.sessionId === event.session.id && checkActive(check);
}

const longReplyHint = "内容较长，这里只显示前 4000 字，完整内容在 Bot 聊天里";

export function PlaneBotDeliveryCard({ link, job, onJobChange, onReload, onOpen, compact = false }: {
  link: HostLink; job: PlaneBotJob; onJobChange(job: PlaneBotJob): void; onReload?(): void; onOpen(id: string, sessionId?: string): void; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { delivery } = job;
  const taskId = job.rootTaskId ?? job.taskId;
  if (!delivery) return null;
  const check = job.check?.resultId === delivery.resultId ? job.check : undefined;
  const active = checkActive(check);
  const canCheck = !!taskId && job.state === "review" && delivery.state === "submitted" && !active && !check?.opinion;
  const verificationLong = delivery.verification.length > 240 || delivery.verification.split("\n").length > 3;
  const managed = job.mode === "managed" ? job.delivery : undefined;
  const changedTrees = managed?.worktrees.filter((tree) => tree.changedPaths?.length) ?? [];
  const reviewDir = managed?.integratedWorktree?.cwd ?? (changedTrees.length === 1 ? changedTrees[0]?.cwd :
    managed?.worktrees.length === 1 ? managed.worktrees[0]?.cwd : managed && !changedTrees.length ? job.project?.path : undefined);
  const reviewTree = (tree: NonNullable<typeof managed>["worktrees"][number]) => openReview({
    workspaceId: job.workspaceId, worktreeSessionId: tree.sessionId, base: tree.baseCommit, baseLabel: "批准的基准",
  });
  const start = async () => {
    if (!taskId) return;
    setBusy(true); setError("");
    try {
      onJobChange(await call(link, "POST /api/team-board/local/:id/bot/check", { id: taskId }, { resultId: delivery.resultId }));
    } catch (cause) {
      setError(teamBoardMessage(cause));
    } finally {
      // The completion event can arrive before the POST response, so reconcile after applying that response too.
      if (onReload) onReload();
      else {
        try {
          const latest = await call(link, "GET /api/team-board/local/:id/bot", { id: taskId });
          if (latest) onJobChange(latest);
        } catch { /* Keep the check error visible if the job cannot be reloaded. */ }
      }
      setBusy(false);
    }
  };
  return <section className="plane-bot-delivery-card" aria-label="交付">
    {!compact && <>
      <div><strong>交付摘要</strong><p className="plane-bot-evidence">{delivery.summary}</p></div>
      {verificationLong ? <details><summary>验证记录</summary><p className="plane-bot-evidence">{delivery.verification}</p></details>
        : <div><strong>验证记录</strong><p className="plane-bot-evidence">{delivery.verification}</p></div>}
    </>}
    {active && <p className="side-note" aria-live="polite">{check?.status === "waiting" ? "Bot 在等你回复" : "Bot 正在对照检查…"}</p>}
    {check?.opinion && <section className="plane-bot-opinion" aria-label="Bot 检查意见">
      <strong>Bot 检查意见</strong><div className="plane-bot-plan plane-bot-opinion-text"><Markdown source={check.opinion} /></div>
      {check.opinion.length >= 4000 && <p className="side-note">{longReplyHint}</p>}
    </section>}
    {(check?.status === "failed" || check?.status === "stopped") && <p className="form-error">{check.error || (check.status === "stopped" ? "Bot 检查已中止。" : "Bot 检查失败。")}</p>}
    {check?.status === "completed" && !check.opinion && <p className="side-note">Bot 没有给出意见</p>}
    {canCheck && !check && <p className="side-note">Bot 只读对照计划里的完成标准给意见，不会改变验收状态。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {managed && <div className="plane-bot-worktrees">
      {reviewDir && <div className="plane-bot-review-location"><strong>验收工程</strong>
        <code>{reviewDir}</code>
        <button type="button" className="btn-ghost small" onClick={() => void revealInExplorer(link, { path: reviewDir }).catch((cause: unknown) => setError(teamBoardMessage(cause)))}>打开工程目录</button>
      </div>}
      {managed.integratedWorktree && <button type="button" className="btn-ghost small" onClick={() => reviewTree(managed.integratedWorktree!)}>查看集成工作树差异</button>}
      {!!managed.worktrees.length && <details open={!job.manualIntake || !reviewDir}><summary>执行工作树 · {managed.worktrees.length} 项</summary>
        <ul>{managed.worktrees.map((tree) => <li key={tree.taskId}>
          <strong>{tree.title || "执行工作树"}</strong>{" "}
          <button type="button" className="btn-ghost small" onClick={() => reviewTree(tree)}>查看改动</button>
          <span className="side-note">{tree.changedPaths?.length ?? 0} 个改动路径 · {tree.integrations?.length ?? 0} 项前置接入</span>
          <div className="side-note" title={tree.cwd}>{tree.cwd}</div>
          <details className="side-note"><summary>核对执行证据</summary>
            {tree.resultId && <div>交付 <code>{tree.resultId}</code></div>}
            {tree.headCommit && <div>实际提交 <code>{tree.headCommit}</code>{tree.workingTreeDirty ? " · 含未提交改动" : ""}</div>}
            {tree.changeDigest && <div>改动校验值 <code>{tree.changeDigest}</code></div>}
            {tree.integrations?.map((receipt) => <div key={receipt.operationId}>
              接入前置 <code>{receipt.prerequisiteResultId}</code> · {receipt.verification === "git" ? "Git 已核对" : "已人工核对"}
            </div>)}
          </details>
        </li>)}</ul>
      </details>}
    </div>}
    {(delivery.sessionId || canCheck || check?.taskId && check.sessionId) && <div className="plane-bot-card-actions">
      {delivery.sessionId && <button className="btn-ghost small" type="button" onClick={() => openReview({
        workspaceId: job.workspaceId, worktreeSessionId: delivery.sessionId!,
        ...(delivery.baseCommit ? { base: delivery.baseCommit, baseLabel: "接单时的基准" } : {}),
      })}>查看改动</button>}
      {canCheck && <button className="btn-ghost small" type="button" disabled={busy} onClick={() => void start()}>{busy ? "正在发送…" : check ? "再让 Bot 检查" : "让 Bot 对照检查"}</button>}
      {check?.taskId && check.sessionId && <button className="btn-ghost small" type="button" onClick={() => onOpen(check.taskId!, check.sessionId!)}>打开 Bot 聊天</button>}
    </div>}
  </section>;
}

export function PlaneBotIntakeDialog({ link, item, source, viewerId, projects, projectId, onOpen, onClose }: {
  link: HostLink; item: { id: string; number: string; title: string }; source: string; viewerId: string;
  projects: readonly Workspace[]; projectId?: string | null; topicId?: string; onOpen(id: string, sessionId?: string): void; onClose(): void;
}) {
  const [selectedBotId, setSelectedBotId] = useState<string>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob, reloadJob] = useLiveResource<PlaneBotJob | null>({
    load: () => call(link, "GET /api/team-board/plane/work-items/:id/bot", { id: item.id }),
    initial: null, reset: true, reloadDelay: 80,
    reloadOn: (event): boolean => event.type === "plane.bot.changed" && event.itemId === item.id
      || (event.type === "data.purged" && !!(job?.taskId ?? job?.rootTaskId) && event.taskIds.includes((job?.taskId ?? job?.rootTaskId)!)) || planeBotCheckChanged(job, event),
    onError: (cause) => setError(teamBoardMessage(cause)),
  }, [link, item.id, source, viewerId]);
  const [bots] = useLiveResource<StudioBot[] | null>({
    load: () => call(link, "GET /api/bots"), initial: null, reloadOn: (event) => event.type === "bots.changed",
    onError: (cause) => setError(teamBoardMessage(cause)),
  }, [link]);
  const declined = job?.state === "declined" && !job.rootTaskId ? job : null;
  const available = bots?.filter((bot) => bot.enabled && (!declined || bot.permission == null || bot.permission === "plan" || bot.permission === "read-only")) ?? [];
  const choosing = !job || !!declined;
  const botId = available.find((bot) => bot.id === (selectedBotId ?? declined?.botId))?.id ?? "";
  const defaultWorkspaceId = declined ? declined.workspaceId : projectId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  const workspaceId = projects.find((project) => project.id === (selectedWorkspaceId ?? defaultWorkspaceId))?.id ?? "";
  const pending = job?.state === "awaiting-approval" ? job : null;
  const planHash = pending?.plan && pending.baseCommit ? pending.planHash : undefined;
  const update = async (action: () => Promise<PlaneBotJob>, openConversation = false) => {
    setError(""); setBusy(true);
    try {
      const updated = await action();
      setJob(updated);
      if (openConversation && updated.manualIntake && !updated.error && updated.botTaskId) {
        onOpen(updated.botTaskId, updated.botSessionId ?? undefined);
      }
    }
    catch (cause) { setError(teamBoardMessage(cause)); }
    finally { setBusy(false); reloadJob(); }
  };
  const start = () => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot", { id: item.id }, { source, viewerId, botId, workspaceId }), true);
  const approve = (planHash: string, execution?: PlaneBotExecutionChoice) => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot/approve", { id: item.id }, { source, viewerId, planHash, ...(execution ? { execution } : {}) }));
  const decline = (planHash: string) => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot/decline", { id: item.id }, { source, viewerId, planHash }));
  return <Modal portal label="交给 Bot" className={`team-return-modal${pending || job?.delivery ? " plane-bot-intake-plan" : ""}`} onClose={onClose}>
    <h2 className="modal-title">交给 Bot</h2>
    <p>{item.number} · {item.title}</p>
    {choosing && <>
      <p className="side-note">接单后，原单进入 In Progress。机器人将建立专题，并在对话中提醒你验收。</p>
      <label className="stack-field">接单机器人<select value={botId} disabled={busy} onChange={(event) => setSelectedBotId(event.target.value)}>
        <option value="">请选择 Bot</option>
        {available.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select></label>
      {bots && !available.length && <p className="side-note">{declined ? "请在 Bots 设置中启用一个只读机器人以重新分析旧单。" : "请先在 Bots 设置中启用一个机器人。"}</p>}
      <label className="stack-field">本地 Git 项目<select value={workspaceId} disabled={busy} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
        <option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
    </>}
    {job && <p role="status">{planeBotStatus(job)}</p>}
    {job?.state === "awaiting-user" && <p className="side-note">打开机器人对话答复这张工单。</p>}
    {pending && <PlaneBotPlan key={planHash} link={link} job={pending} busy={busy}
      approve={(execution) => { if (planHash) void approve(planHash, execution); }}
      decline={() => { if (planHash) void decline(planHash); }} />}
    {job && !job.manualIntake && <PlaneBotReplanControl link={link} job={job} busy={busy} replan={(workspaceId) => void update(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/replan", { id: job.botId, jobId: job.jobId! }, { planHash: job.planHash!, workspaceId }))} />}
    {job?.delivery && <PlaneBotDeliveryCard key={job.delivery.resultId} link={link} job={job} onJobChange={setJob} onReload={reloadJob} onOpen={onOpen} />}
    {job && <PlaneBotWritebackHistory job={job} />}
    {(error || job?.error) && <p className="team-return-error" role="alert">{error || job?.error}</p>}
    <div className="settings-row end">
      <button type="button" className="btn-ghost small" onClick={onClose}>{job ? "关闭" : "取消"}</button>
      {job?.taskId && <button type="button" className="btn-primary small" onClick={() => onOpen(job.taskId!)}>打开执行任务</button>}
      {job && <PlaneBotCanvasLink job={job} />}
      {job?.botTaskId && <button type="button" className="btn-ghost small" onClick={() => onOpen(job.botTaskId!, job.botSessionId ?? undefined)}>{job.jobId ? "打开 Bot 对话" : "查看 Bot 分析"}</button>}
      {choosing && <button type="button" className="btn-primary small" disabled={busy || !botId || !workspaceId} onClick={() => void start()}>{busy ? "正在接单…" : job?.state === "declined" ? "重新交给 Bot" : "开始接单"}</button>}
      {job?.canRetry && !job.taskId && !job.rootTaskId && <button type="button" className="btn-primary small" disabled={busy} onClick={() => void (job.manualIntake && job.jobId ? update(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/retry", { id: job.botId, jobId: job.jobId! }), true) : start())}>重试接单</button>}
      {job?.canRetry && job.rootTaskId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void update(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/retry", { id: job.botId, jobId: job.jobId! }))}>{job.failureStage === "writeback" ? "核对并重试回写" : "重试分析"}</button>}
      {job?.canRetry && job.taskId && job.failureStage === "execution" && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void update(() => call(link, "POST /api/team-board/local/:id/bot/retry", { id: job.taskId! }))}>重试执行</button>}
    </div>
  </Modal>;
}

export function usePlaneBotJob(link: HostLink, taskId: string | null) {
  const resource = useLiveResource<PlaneBotJob | null>({
    load: taskId ? () => call(link, "GET /api/team-board/local/:id/bot", { id: taskId }) : null,
    initial: null, reset: true, reloadDelay: 80,
    reloadOn: (event): boolean => event.type === "plane.bot.changed" && (event.taskId === taskId || event.rootTaskId === taskId) || event.type === "task.upserted" && event.task.id === taskId || planeBotCheckChanged(resource[0], event),
  }, [link, taskId]);
  return resource;
}

export function PlaneBotTaskAction({ link, task, tasks, job, setJob, openOriginal, onOpen }: {
  link: HostLink; task: Task; tasks: readonly Task[]; job: PlaneBotJob; setJob: Dispatch<SetStateAction<PlaneBotJob | null>>; openOriginal?: ReactNode; onOpen(id: string, sessionId?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const failedWriteback = writebackFailed(job, task.column === "done");
  const issue = error || (failedWriteback && job.error === "不支持的工作项操作" ? "当前 Plane 版本拒绝了 Bot 回写。" : job.error);
  const action = job.state === "review" ? "验收交付" : "查看交付";
  const message = planeBotStatus(job, task.column === "done");
  const retry = async () => {
    setError(""); setBusy(true);
    try { setJob(await call(link, "POST /api/team-board/local/:id/bot/retry", { id: task.id })); }
    catch (cause) { setError(teamBoardMessage(cause)); }
    finally { setBusy(false); }
  };
  if (job.manualIntake && job.botTaskId) return <div className="plane-bot-delivery" aria-label="Plane Bot 交付">
    <strong className="plane-bot-delivery-status" role="status">{message}</strong>
    <div className="plane-bot-delivery-actions">{openOriginal}
      <button type="button" className="btn-primary small" onClick={() => onOpen(job.botTaskId!, job.botSessionId ?? undefined)}>打开 Bot 对话</button>
    </div>
  </div>;
  return <div className="plane-bot-delivery" aria-label="Plane Bot 交付">
    <div className="plane-bot-delivery-copy">
      <strong className="plane-bot-delivery-status" data-state={job.state} role="status">{message}</strong>
      {issue && <span className="plane-bot-delivery-detail">{issue}</span>}
      {job.state === "review" && <span className="plane-bot-delivery-detail">通过后，摘要和验证记录将写回原单</span>}
    </div>
    <div className="plane-bot-delivery-actions">
      {openOriginal}
      <button type="button" className={`btn-${job.state === "review" ? "primary" : "ghost"} small`} aria-haspopup="dialog" onClick={() => setOpen(true)}>{action}</button>
      {failedWriteback && job.canRetry && <button type="button" className="btn-primary small" disabled={busy} onClick={() => void retry()}>{busy ? "正在回写…" : "重试回写"}</button>}
    </div>
    {open && <Modal portal label="交付与验收" className="plane-bot-review" onClose={() => setOpen(false)}>
      <header className="plane-bot-review-heading">
        <h2 className="modal-title">交付与验收</h2>
        <p className="dim">{task.title}</p>
      </header>
      <div className="plane-bot-review-body">
        {job.delivery && <PlaneBotDeliveryCard key={job.delivery.resultId} link={link} job={job} onJobChange={setJob} onOpen={onOpen} compact />}
        {issue && <p className="form-error" role="alert">{issue}</p>}
        <PlaneBotWritebackHistory job={job} />
        {!task.managerTaskId && <TaskWorkflow link={link} task={task} tasks={tasks} onOpenTask={(id) => onOpen(id)} planeBot />}
      </div>
      <footer className="plane-bot-review-footer">
        {job.canRetry && <button type="button" className="btn-primary small" disabled={busy} onClick={() => void retry()}>{busy ? "正在处理…" : failedWriteback ? "重试回写" : "重试执行"}</button>}
        <button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>关闭</button>
      </footer>
    </Modal>}
  </div>;
}
