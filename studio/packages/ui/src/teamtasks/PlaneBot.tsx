import { useState, type Dispatch, type SetStateAction } from "react";
import type { HostEvent, PlaneBotJob, StudioBot, Task, Workspace } from "@amo-studio/protocol";
import { openReview } from "../gitreview/open.js";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { Markdown } from "../lib/markdown.js";
import { TaskWorkflow } from "../task/TaskWorkflow.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";
import "./plane-bot.css";

const status: Record<PlaneBotJob["state"], string> = {
  planning: "Bot 正在分析", "awaiting-approval": "计划待确认", starting: "正在启动执行任务", declined: "已放弃",
  executing: "Bot 已进入独立工作树", "awaiting-user": "需要你答复或授权", paused: "执行已暂停", review: "等待人工验收",
  sending: "已验收，正在回写 Plane", sent: "已回写 Plane 评论", failed: "Bot 执行失败",
};

function writebackFailed(job: Pick<PlaneBotJob, "state" | "error" | "failureStage">, taskDone = false): boolean {
  return job.state === "failed" && (job.failureStage === "writeback" || !job.failureStage && (taskDone || job.error === "不支持的工作项操作"));
}

export function planeBotStatus(job: Pick<PlaneBotJob, "state" | "error" | "failureStage">, taskDone = false): string {
  return writebackFailed(job, taskDone) ? "交付已验收，Plane 回写失败" : status[job.state];
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
  const { delivery, taskId } = job;
  if (!delivery) return null;
  const check = job.check?.resultId === delivery.resultId ? job.check : undefined;
  const active = checkActive(check);
  const canCheck = !!taskId && job.state === "review" && delivery.state === "submitted" && !active && !check?.opinion;
  const verificationLong = delivery.verification.length > 240 || delivery.verification.split("\n").length > 3;
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

export function PlaneBotIntakeDialog({ link, item, source, viewerId, projects, projectId, topicId, onOpen, onClose }: {
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
      || (event.type === "data.purged" && !!job?.taskId && event.taskIds.includes(job.taskId)) || planeBotCheckChanged(job, event),
    onError: (cause) => setError(teamBoardMessage(cause)),
  }, [link, item.id, source, viewerId]);
  const [bots] = useLiveResource<StudioBot[] | null>({
    load: () => call(link, "GET /api/bots"), initial: null, reloadOn: (event) => event.type === "bots.changed",
    onError: (cause) => setError(teamBoardMessage(cause)),
  }, [link]);
  const available = bots?.filter((bot) => bot.enabled && (bot.permission == null || bot.permission === "plan" || bot.permission === "read-only")) ?? [];
  const declined = job?.state === "declined" ? job : null;
  const choosing = !job || !!declined;
  const botId = available.find((bot) => bot.id === (selectedBotId ?? declined?.botId))?.id ?? "";
  const defaultWorkspaceId = declined ? declined.workspaceId : projectId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  const workspaceId = projects.find((project) => project.id === (selectedWorkspaceId ?? defaultWorkspaceId))?.id ?? "";
  const pending = job?.state === "awaiting-approval" ? job : null;
  const planHash = pending?.plan && pending.baseCommit ? pending.planHash : undefined;
  const update = async (action: () => Promise<PlaneBotJob>) => {
    setError(""); setBusy(true);
    try { setJob(await action()); }
    catch (cause) { setError(teamBoardMessage(cause)); }
    finally { setBusy(false); reloadJob(); }
  };
  const start = () => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot", { id: item.id }, { source, viewerId, botId, workspaceId, topicId }));
  const approve = (planHash: string) => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot/approve", { id: item.id }, { source, viewerId, planHash }));
  const decline = (planHash: string) => update(() => call(link, "POST /api/team-board/plane/work-items/:id/bot/decline", { id: item.id }, { source, viewerId, planHash }));
  return <Modal portal label="交给 Bot" className={`team-return-modal${pending || job?.delivery ? " plane-bot-intake-plan" : ""}`} onClose={onClose}>
    <h2 className="modal-title">交给 Bot</h2>
    <p>{item.number} · {item.title}</p>
    {choosing && <>
      <p className="side-note">Bot 先分析，等你确认开工后再到独立工作树执行。你验收通过后，Studio 会把交付摘要和验证记录写成 Plane 原单评论。</p>
      <label className="stack-field">只读 Bot<select value={botId} disabled={busy} onChange={(event) => setSelectedBotId(event.target.value)}>
        <option value="">请选择 Bot</option>
        {available.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select></label>
      {bots && !available.length && <p className="side-note">请先在 Bots 设置中启用一个只读 Bot。</p>}
      <label className="stack-field">本地 Git 项目<select value={workspaceId} disabled={busy} onChange={(event) => setSelectedWorkspaceId(event.target.value)}>
        <option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
    </>}
    {job && <p role="status">{planeBotStatus(job)}</p>}
    {job?.state === "awaiting-user" && <p className="side-note">可在「待你处理」或执行任务内查看问题。</p>}
    {pending && <>
      {pending.baseCommit && <p className="side-note">基准提交 <code title={pending.baseCommit}>{pending.baseCommit.slice(0, 7)}</code></p>}
      {(pending.behind ?? 0) > 0 && <p className="side-note">分析后项目有 {pending.behind} 个新提交。开工会从分析时的提交开始改；想用最新代码，请放弃后重新交给 Bot。</p>}
      {pending.plan && <section className="plane-bot-plan" aria-label="Bot 计划"><Markdown source={pending.plan} /></section>}
      {(pending.plan?.length ?? 0) >= 4000 && <p className="side-note">{longReplyHint}</p>}
    </>}
    {job?.delivery && <PlaneBotDeliveryCard key={job.delivery.resultId} link={link} job={job} onJobChange={setJob} onReload={reloadJob} onOpen={onOpen} />}
    {(error || job?.error) && <p className="team-return-error" role="alert">{error || job?.error}</p>}
    <div className="settings-row end">
      <button type="button" className="btn-ghost small" onClick={onClose}>{job ? "关闭" : "取消"}</button>
      {job?.taskId && <button type="button" className="btn-primary small" onClick={() => onOpen(job.taskId!)}>打开执行任务</button>}
      {job?.botTaskId && job.botSessionId && <button type="button" className="btn-ghost small" onClick={() => onOpen(job.botTaskId!, job.botSessionId!)}>{job.jobId ? "打开 Bot 对话" : "查看 Bot 分析"}</button>}
      {choosing && <button type="button" className="btn-primary small" disabled={busy || !botId || !workspaceId} onClick={() => void start()}>{busy ? "正在接单…" : job?.state === "declined" ? "重新交给 Bot" : "开始接单"}</button>}
      {job?.canRetry && !job.taskId && <button type="button" className="btn-primary small" disabled={busy} onClick={() => void start()}>重试接单</button>}
      {job?.canRetry && job.taskId && job.failureStage === "execution" && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void update(() => call(link, "POST /api/team-board/local/:id/bot/retry", { id: job.taskId! }))}>重试执行</button>}
      {pending && <>
        <button type="button" className="btn-ghost small" disabled={busy || !planHash} onClick={() => { if (planHash) void decline(planHash); }}>放弃</button>
        <button type="button" className="btn-primary small" disabled={busy || !planHash} onClick={() => { if (planHash) void approve(planHash); }}>开工</button>
      </>}
    </div>
  </Modal>;
}

export function usePlaneBotJob(link: HostLink, taskId: string | null) {
  const resource = useLiveResource<PlaneBotJob | null>({
    load: taskId ? () => call(link, "GET /api/team-board/local/:id/bot", { id: taskId }) : null,
    initial: null, reset: true, reloadDelay: 80,
    reloadOn: (event): boolean => event.type === "plane.bot.changed" && event.taskId === taskId || event.type === "task.upserted" && event.task.id === taskId || planeBotCheckChanged(resource[0], event),
  }, [link, taskId]);
  return resource;
}

export function PlaneBotTaskAction({ link, task, tasks, job, setJob, onOpen }: {
  link: HostLink; task: Task; tasks: readonly Task[]; job: PlaneBotJob; setJob: Dispatch<SetStateAction<PlaneBotJob | null>>; onOpen(id: string, sessionId?: string): void;
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
  return <div className="plane-bot-delivery" aria-label="Plane Bot 交付">
    <div className="plane-bot-delivery-copy">
      <strong className="plane-bot-delivery-status" data-state={job.state} role="status">{message}</strong>
      {issue && <span className="plane-bot-delivery-detail">{issue}</span>}
      {job.state === "review" && <span className="plane-bot-delivery-detail">通过后，摘要和验证记录将写回原单</span>}
    </div>
    <div className="plane-bot-delivery-actions">
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
        {!task.lead && !task.managerTaskId && <TaskWorkflow link={link} task={task} tasks={tasks} onOpenTask={onOpen} planeBot />}
      </div>
      <footer className="plane-bot-review-footer">
        {job.canRetry && <button type="button" className="btn-primary small" disabled={busy} onClick={() => void retry()}>{busy ? "正在处理…" : failedWriteback ? "重试回写" : "重试执行"}</button>}
        <button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>关闭</button>
      </footer>
    </Modal>}
  </div>;
}
