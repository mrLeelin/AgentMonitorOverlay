import { useId, useState } from "react";
import type { PlaneBotExecutionChoice, PlaneBotJob, Session, StudioBot, Task } from "@amo-studio/protocol";
import { IconChevronDown, IconChevronRight, IconPlan } from "../chat/icons.js";
import { ApprovalCard } from "../chat/Transcript.js";
import { QuestionCard } from "../chat/questions/QuestionCard.js";
import { DecisionCard } from "../collab/DecisionPanel.js";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { TaskWorkflow } from "../task/TaskWorkflow.js";
import { PlaneBotDeliveryCard, PlaneBotRootLinks, PlaneBotWritebackHistory, planeBotCheckChanged, planeBotStatus } from "./PlaneBot.js";
import { PlaneBotPlan, PlaneBotReplanControl } from "./PlaneBotPlan.js";
import { planeBotNeedsAttention } from "./planeBotAttention.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";

export function PlaneBotConversation({ link, bot, session, sessions, tasks, onOpen }: {
  link: HostLink; bot: StudioBot; session: Session | null; sessions: readonly Session[]; tasks: readonly Task[]; onOpen(id: string, sessionId?: string): void;
}) {
  const listId = useId();
  const [expanded, setExpanded] = useState<boolean>();
  const [jobs, setJobs, reload] = useLiveResource<PlaneBotJob[]>({
    load: () => call(link, "GET /api/team-board/plane/bots/:id/jobs", { id: bot.id }, undefined, { unfinished: "1" }),
    initial: [], reset: true, reloadDelay: 80,
    reloadOn: (event): boolean => event.type === "plane.bot.changed" || event.type === "data.purged" || jobs.some((job) => planeBotCheckChanged(job, event)),
    onError: () => setJobs([]),
  }, [link, bot.id]);
  const activeChats = sessions.filter((s) => s.taskId === bot.taskId && !s.archivedAt);
  const fallback = activeChats[0]?.id ?? session?.id;
  const home = !!session && session.id === bot.homeSessionId;
  const visible = jobs.filter((job) => job.jobId && (home || job.botSessionId === session?.id
    || (session?.id === fallback && !activeChats.some((s) => s.id === job.botSessionId))));
  if (!visible.length) return null;
  const ordered = visible.toSorted((a, b) => Number(planeBotNeedsAttention(b)) - Number(planeBotNeedsAttention(a)));
  const pending = ordered.filter(planeBotNeedsAttention).length;
  const showList = expanded ?? pending > 0;
  const update = (updated: PlaneBotJob) => setJobs((current) => current.map((job) => job.jobId === updated.jobId ? updated : job));
  return <section className="plane-bot-conversation" aria-label="Plane 工单" data-testid="plane-bot-conversation">
    <button type="button" className="plane-bot-conversation-toggle" aria-expanded={showList} aria-controls={listId} onClick={() => setExpanded(!showList)}>
      <IconPlan /><strong>Plane 工单</strong><span className="plane-bot-conversation-count">{visible.length} 张</span>
      {pending > 0 && <span className="plane-bot-conversation-pending">{pending} 项待处理</span>}
      {showList ? <IconChevronDown /> : <IconChevronRight />}
    </button>
    <ul className="plane-bot-conversation-list" id={listId} hidden={!showList}>
      {ordered.map((job) => <ConversationJob key={job.jobId} link={link} job={job} botName={bot.name} tasks={tasks} onUpdate={update} onReload={reload} onOpen={onOpen} />)}
    </ul>
  </section>;
}

function ConversationJob({ link, job, botName, tasks, onUpdate, onReload, onOpen }: {
  link: HostLink; job: PlaneBotJob; botName: string; tasks: readonly Task[]; onUpdate(job: PlaneBotJob): void; onReload(): void; onOpen(id: string, sessionId?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const task = tasks.find((t) => t.id === (job.rootTaskId ?? job.taskId));
  const plan = job.state === "awaiting-approval";
  const status = planeBotStatus(job, task?.column === "done");
  const statusDetail = [status, job.decisions?.[0]?.question].filter(Boolean).join(" · ");
  const next = plan ? "查看计划" : job.state === "awaiting-user" ? "答复 Bot" : job.state === "review" ? "验收交付" : "查看工单";
  const act = async (operation: () => Promise<PlaneBotJob | { ok: true }>) => {
    setError(""); setBusy(true);
    try {
      const result = await operation();
      if ("jobId" in result) onUpdate(result);
    } catch (cause) {
      setError(teamBoardMessage(cause));
    } finally {
      setBusy(false); onReload();
    }
  };
  const decide = (approve: boolean, execution?: PlaneBotExecutionChoice) => void act(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/decision", { id: job.botId, jobId: job.jobId! },
    approve ? { approve, planHash: job.planHash!, ...(execution ? { execution } : {}) } : { approve, planHash: job.planHash! }));
  const retry = () => void act(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/retry", { id: job.botId, jobId: job.jobId! }));
  return <li className="plane-bot-conversation-job" data-testid="plane-bot-conversation-job">
    <div className="plane-bot-delivery-copy">
      <div className="plane-bot-conversation-title"><span>{job.item.number}</span><strong title={job.item.title}>{job.item.title}</strong></div>
      <span className="plane-bot-delivery-status" role="status" data-state={job.state} title={statusDetail}>{statusDetail}</span>
    </div>
    <button type="button" className={`btn-${plan || job.state === "awaiting-user" || job.state === "review" ? "primary" : "ghost"} small`} aria-haspopup="dialog" onClick={() => setOpen(true)}>{next}</button>
    {open && <Modal portal label="Bot 工单" className="plane-bot-review" onClose={() => setOpen(false)}>
      <header className="plane-bot-review-heading">
        <h2 className="modal-title">{botName} · {job.item.number}</h2>
        <p className="dim">{job.item.title}</p>
      </header>
      <div className="plane-bot-review-body">
        <p role="status">{status}</p>
        {plan && <PlaneBotPlan key={job.planHash} link={link} job={job} busy={busy} approve={(execution) => decide(true, execution)} decline={() => decide(false)} />}
        <PlaneBotReplanControl link={link} job={job} busy={busy} replan={(workspaceId) => void act(() => call(link, "POST /api/team-board/plane/bots/:id/jobs/:jobId/replan",
          { id: job.botId, jobId: job.jobId! }, { planHash: job.planHash!, workspaceId }))} />
        {job.decisions?.map((decision) => <DecisionCard key={decision.id} link={link} decision={decision} sessionTitle={botName} />)}
        {job.requests?.map((item) => item.type === "approval"
          ? <ApprovalCard key={item.id} item={item} busy={busy} onApprove={(_, decision) => void act(() => call(link, "POST /api/approvals/:approvalId", { approvalId: item.approvalId }, { sessionId: item.sessionId, decision }))} />
          : activeQuestion === item.id ? <QuestionCard key={item.id} link={link} sessionId={item.sessionId} item={item} onClose={() => setActiveQuestion(null)} />
          : <button key={item.id} type="button" className="btn-ghost small" onClick={() => setActiveQuestion(item.id)}>答复「{item.questions?.[0]?.question || "需要确认"}」</button>)}
        {job.delivery && <PlaneBotDeliveryCard key={job.delivery.resultId} link={link} job={job} onJobChange={onUpdate} onReload={onReload} onOpen={(id, sessionId) => { setOpen(false); onOpen(id, sessionId); }} compact />}
        {task && job.delivery && <TaskWorkflow link={link} task={task} tasks={tasks} onOpenTask={onOpen} planeBot />}
        <PlaneBotWritebackHistory job={job} />
        {(error || job.error) && <p className="form-error" role="alert">{error || job.error}</p>}
      </div>
      <footer className="plane-bot-review-footer">
        <PlaneBotRootLinks job={job} onOpen={(id) => { setOpen(false); onOpen(id); }} />
        <button type="button" className="btn-ghost small" onClick={() => setOpen(false)}>关闭</button>
        {job.canRetry && <button type="button" className="btn-primary small" disabled={busy} onClick={retry}>{job.failureStage === "writeback" ? job.rootTaskId ? "核对并重试回写" : "重试回写" : job.taskId ? "重试执行" : "重试接单"}</button>}
      </footer>
    </Modal>}
  </li>;
}
