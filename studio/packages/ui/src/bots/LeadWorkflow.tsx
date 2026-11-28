import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BotLeadControlInput, BotLeadRunState, DecisionRequest, Id, Session, Task, TaskResult, TaskResultHeader, TaskWorkflowSummaryPage, TaskWorkflowSummaryRow } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { DecisionCard } from "../collab/DecisionPanel.js";
import { UserReview } from "../task/TaskWorkflow.js";
import { BotAvatar } from "./BotAvatar.js";
import { COLUMN_NAMES } from "../lib/status.js";
import { openReview } from "../gitreview/open.js";
import { decisionNeedsPerson } from "../focus/managedAttention.js";
import type { LeadDirectory } from "./LeadAppointment.js";
import { LeadHistory, LegacyLeadBindingDialog, ReplaceLeadDialog } from "./LeadLifecycle.js";
import { ActionMenu } from "../lib/ActionMenu.js";
import { IconClock, IconPause, IconPeople, IconPlus } from "../chat/icons.js";
import "./lead-appointment.css";

const RUN_STATE: Record<BotLeadRunState, string> = {
  pending: "等待主控启动", starting: "正在启动主控", running: "主控工作中", idle: "主控空闲",
  paused: "主控暂停", failed: "主控启动失败", "needs-reconciliation": "启动状态待核对",
};
const BLOCKER = { turn: "等待当前回合结束", "background-command": "等待后台命令结束", terminal: "等待收回终端",
  approval: "有原生审批或提问待处理", "unsent-message": "有未发送的消息" } as const;

export function leadRunLabel(task: Task) {
  const state = task.botLead;
  if (state?.kind === "appointed") return state.term.state === "handing-off" ? "正在交接" : RUN_STATE[state.term.runState];
  if (state?.kind === "pending-upgrade") return "等待安全交接";
  if (state?.kind === "legacy") return state.state === "historical" ? "历史主控" : "待绑定机器人";
  return "";
}

export function LeadRun({ link, task, sessions, directory, botsEnabled = true, sidebar = false, onAppendWork, onChooseUpgrade, onRepair, onOpen }: {
  link: HostLink; task: Task; sessions: readonly Session[]; directory?: LeadDirectory; botsEnabled?: boolean;
  sidebar?: boolean; onAppendWork?(): void;
  onChooseUpgrade?(): void; onRepair?(): void; onOpen(taskId: Id, sessionId?: Id): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"replace" | "legacy" | "history">();
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLButtonElement }>();
  const attempted = useRef<{ key: string; operationId: Id } | undefined>(undefined);
  const inFlight = useRef(false);
  const projected = task.botLead;
  const term = projected?.kind === "appointed" ? projected.term : undefined;
  const handoff = projected?.kind === "pending-upgrade" ? projected : projected?.kind === "appointed" ? projected.handoff : undefined;
  if (!projected) return null;

  async function control(input: Omit<Extract<BotLeadControlInput, { action: "cancel-handoff" }>, "operationId"> | Omit<Extract<BotLeadControlInput, { action: "retry-start" | "pause" | "resume" }>, "operationId">) {
    if (inFlight.current) return;
    const key = JSON.stringify(input);
    if (attempted.current?.key !== key) attempted.current = { key, operationId: crypto.randomUUID() };
    inFlight.current = true; setBusy(true); setError("");
    try {
      await call(link, "POST /api/tasks/:id/bot-lead/control", { id: task.id }, { ...input, operationId: attempted.current.operationId });
      attempted.current = undefined;
    } catch (err) {
      setError(err instanceof HostApiError && err.details?.reason === "stale-term" ? "主控状态已变化，请核对当前状态。" : err instanceof Error ? err.message : String(err));
    } finally { inFlight.current = false; setBusy(false); }
  }

  const termRef = term ? { termId: term.termId, generation: term.generation } : null;
  const live = !task.archivedAt;
  const controllable = live && term?.state === "active";
  const legacy = projected.kind === "legacy" && projected.state === "needs-bot" ? projected : null;
  const reason = term?.reason ?? (projected.kind === "pending-upgrade" ? projected.reason : legacy?.issue);
  const role = task.managerTaskId ? "中控" : "总主控";
  const status = live ? leadRunLabel(task) : "历史主控";
  const runState = live ? term?.state === "handing-off" ? "handing-off" : term?.runState ?? projected.kind : "historical";
  const sessionId = term?.sessionId;
  const canAsk = controllable && (runState === "idle" || runState === "running");
  const pause = controllable && botsEnabled && termRef && term?.runState !== "paused" && {
    label: "暂停主控", icon: <IconPause />, disabled: busy, run: () => void control({ action: "pause", expectedTerm: termRef }),
  };
  const replace = controllable && botsEnabled && directory && { label: "更换机器人", icon: <IconPeople />, run: () => setDialog("replace") };
  const history = term && directory && { label: "任期记录", icon: <IconClock />, run: () => setDialog("history") };
  const hasMenu = !!(pause || replace || history);
  const actions = <div className={sidebar ? "lead-run-actions" : "lead-actions"}>
    {sessionId && <button type="button" className={sidebar ? "btn-primary with-icon" : "btn-ghost small"} title={sidebar && canAsk ? "打开主控对话，询问任务进度" : undefined} onClick={() => onOpen(task.id, sessionId)}>
      {sidebar && <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM5.5 7h5" /></svg>}
      打开主控对话
    </button>}
    {live && handoff && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void control({ action: "cancel-handoff", expectedTerm: termRef, handoffOperationId: handoff.operationId })}>取消此次切换</button>}
    {controllable && botsEnabled && termRef && term && (term.runState === "failed" || term.runState === "needs-reconciliation") && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void control({ action: "retry-start", expectedTerm: termRef })}>重试启动</button>}
    {controllable && botsEnabled && termRef && term?.runState === "paused" && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void control({ action: "resume", expectedTerm: termRef })}>恢复主控</button>}
    {legacy && live && botsEnabled && !legacy.issue && task.lead && directory && <button type="button" className="btn-primary small" onClick={() => setDialog("legacy")}>绑定机器人</button>}
    {legacy && live && botsEnabled && !task.lead && !legacy.issue && onChooseUpgrade && <button type="button" className="btn-primary small" onClick={onChooseUpgrade}>选择机器人继续交接</button>}
    {legacy?.issue && live && <button type="button" className="link-btn" onClick={onRepair ?? (() => onOpen(task.id))}>打开管理关系</button>}
    {onAppendWork && <button type="button" className="btn-ghost with-icon" onClick={onAppendWork}><IconPlus />追加工作</button>}
    {!sidebar && <>
      {pause && <button type="button" className="btn-ghost small" disabled={pause.disabled} onClick={pause.run}>{pause.label}</button>}
      {replace && <button type="button" className="btn-ghost small" onClick={replace.run}>{replace.label}</button>}
      {history && <button type="button" className="link-btn" onClick={history.run}>{history.label}</button>}
    </>}
  </div>;
  const details = <>
    {sidebar && reason && <p className="side-note" role="status">{reason}</p>}
    {legacy?.summary && <p className="workflow-text">{legacy.summary}</p>}
    {live && !botsEnabled && <p className="side-note">在「设置 → 工具与自动化 → Bots」启用后可继续管理这棵树。</p>}
    {!!handoff?.blockers.length && <ul className="lead-handoff-blockers">{handoff.blockers.map((blocker, index) => <li key={`${blocker.kind}:${blocker.sessionId}:${index}`}>
      <button type="button" className="link-btn" onClick={() => onOpen(task.id, blocker.sessionId)}>{BLOCKER[blocker.kind]} · {sessions.find((item) => item.id === blocker.sessionId)?.title || "打开原会话"}</button>
      {blocker.kind === "unsent-message" && <button type="button" className="link-btn" onClick={() => {
        setError("");
        void call(link, "DELETE /api/sessions/:id/items/:itemId/queued", { id: blocker.sessionId, itemId: blocker.itemId }, undefined, { retain: "lead-handoff" })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}>留作主控交接</button>}
      {blocker.kind === "unsent-message" && <button type="button" className="link-btn" onClick={() => {
        setError("");
        void call(link, "DELETE /api/sessions/:id/items/:itemId/queued", { id: blocker.sessionId, itemId: blocker.itemId })
          .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      }}>取消待发消息</button>}
    </li>)}</ul>}
  </>;
  return <section className={sidebar ? "lead-run lead-run-sidebar" : "lead-run"} aria-label="主控运行状态">
    {sidebar ? <>
      <div className="lead-run-identity">
        {term && <BotAvatar name={term.name} avatar={term.avatar} size={40} />}
        <div className="lead-run-person">
          {term && <strong title={term.name}>{term.name}</strong>}
          <div className="lead-run-meta">
            {term && <span>{role}</span>}
            <span className="lead-run-status" data-state={runState} role="status">{status}</span>
          </div>
        </div>
        {hasMenu && <button type="button" className="btn-ghost lead-run-more" aria-label="主控更多操作" title="主控更多操作"
          aria-haspopup="menu" aria-expanded={!!menu} onClick={(event) => {
            const trigger = event.currentTarget;
            const bounds = trigger.getBoundingClientRect();
            setMenu(menu ? undefined : { x: bounds.right, y: bounds.bottom + 4, trigger });
          }}><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12.5" cy="8" r="1" /></svg></button>}
      </div>
      {details}
      {actions}
      {onAppendWork && canAsk && sessionId && <p className="side-note">对话问进度，新增需求用「追加工作」。</p>}
      {menu && hasMenu && createPortal(<ActionMenu label="主控更多操作" at={menu} trigger={menu.trigger} focus alignEnd groups={[[pause, replace], [history]]} onClose={() => {
        if (document.activeElement?.closest(".action-menu")) menu.trigger.focus({ preventScroll: true });
        setMenu(undefined);
      }} />, document.body)}
    </> : <>
      {term && <strong className="bot-identity"><BotAvatar name={term.name} avatar={term.avatar} size={19} />{role} · {term.name}</strong>}
      <span className="side-note" role="status">{status}{reason ? ` · ${reason}` : ""}</span>
      {details}
      {actions}
    </>}
    {error && <span className="form-error" role="alert">{error}</span>}
    {dialog === "replace" && directory && term && <ReplaceLeadDialog directory={directory} task={task} term={term} onClose={() => setDialog(undefined)} />}
    {dialog === "legacy" && directory && <LegacyLeadBindingDialog directory={directory} task={task} onClose={() => setDialog(undefined)} />}
    {dialog === "history" && directory && <LeadHistory directory={directory} task={task} onClose={() => setDialog(undefined)} />}
  </section>;
}

export async function readLeadResult(link: HostLink, rootId: Id, header: TaskResultHeader): Promise<TaskResult> {
  let offset = 0;
  let json = "";
  for (;;) {
    const page = await call(link, "GET /api/tasks/:id/workflow/results/:resultId", { id: rootId, resultId: header.id }, undefined, { offset: String(offset) });
    if (page.result.id !== header.id || page.result.taskId !== header.taskId || page.result.updatedAt !== header.updatedAt) throw new Error("交付状态或版本已变化，请刷新后再查看。");
    json += page.text;
    if (page.nextOffset === null) {
      if (json.length !== page.length) throw new Error("交付证据未完整返回，请重试。");
      return JSON.parse(json) as TaskResult;
    }
    if (page.nextOffset <= offset || page.nextOffset !== json.length || page.nextOffset >= page.length) throw new Error("交付证据分页已变化，请重试。");
    offset = page.nextOffset;
  }
}

export const resultLabel = (header: TaskResultHeader, userReview: boolean, acceptedCurrent: boolean) =>
  header.state === "submitted" ? userReview ? "待你验收" : header.managerTaskId ? "待直属主控验收" : "已提交"
    : header.state === "returned" ? "已退回" : acceptedCurrent ? "已验收" : "历史验收";

export function ResultEvidence({ link, rootId, header, review, tasks, onRefresh, onOpen }: {
  link: HostLink; rootId: Id; header: TaskResultHeader; review: boolean; tasks: readonly Task[]; onRefresh(): void; onOpen(taskId: Id, sessionId?: Id): void;
}) {
  const [result, setResult] = useState<TaskResult>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setResult(undefined); setError("");
    void readLeadResult(link, rootId, header).then((value) => { if (active) setResult(value); }, (err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { active = false; };
  }, [link.url, link.token, rootId, header.id, header.updatedAt, revision]);
  if (error) return <div><p role="alert" className="form-error">{error}</p><button type="button" className="link-btn" onClick={() => { onRefresh(); setRevision((n) => n + 1); }}>刷新证据</button></div>;
  if (!result) return <p role="status" className="side-note">正在读取交付证据…</p>;
  const manager = tasks.find((task) => task.id === result.managerTaskId);
  const sameBot = result.state === "submitted" && manager?.botLead?.kind === "appointed" && manager.botLead.term.botId === result.submittedByLead?.botId;
  return <div className="lead-workflow">
    <p className="workflow-text">{result.summary}</p>
    <strong>验证记录</strong><p className="workflow-text">{result.verification}</p>
    <span className="side-note">{result.submittedByLead?.name ? `${result.submittedByLead.name} · ` : ""}{new Date(result.createdAt).toLocaleString()} · {result.id}</span>
    {sameBot && <p role="status" className="side-note">需要另一位主控验收。<button type="button" className="link-btn" onClick={() => onOpen(manager.id)}>打开直属主控换任</button></p>}
    {result.contextBasis && <span className="side-note">共同需求第 {result.contextBasis.version} 版</span>}
    {!!result.prerequisiteResultIds?.length && <details><summary>前置交付依据 · {result.prerequisiteResultIds.length} 项</summary><ul>{result.prerequisiteResultIds.map((id) => <li key={id}>{id}</li>)}</ul></details>}
    {result.contextMismatch && <p className="workflow-text" role="status">{result.contextMismatch}</p>}
    {result.contextResolution && <p className="workflow-text">{result.contextResolution.explanation}</p>}
    {result.review && <><strong>验收意见</strong><p className="workflow-text">{result.review}</p></>}
    {result.userReview && result.userReview.review !== result.review && <p className="workflow-text">人工意见 · {result.userReview.review}</p>}
    <div className="lead-actions"><button type="button" className="link-btn" onClick={() => onOpen(result.taskId, result.sessionId)}>打开交付会话</button></div>
    {!!result.worktrees?.length && <details><summary>工作树证据 · {result.worktrees.length} 项</summary>
      {result.worktrees.map((tree) => {
        const task = tasks.find((item) => item.id === tree.taskId);
        return <div className="lead-workflow-row" key={`${tree.taskId}:${tree.sessionId}`}>
          <strong>{task?.title || "执行任务"}</strong><span className="side-note">{tree.cwd}</span><span className="side-note">基准 {tree.baseCommit}{tree.headCommit ? ` · 提交 ${tree.headCommit}` : ""}</span>
          {task && <button type="button" className="link-btn" onClick={() => openReview({ workspaceId: task.workspaceId, sessionId: tree.sessionId, worktreeSessionId: tree.sessionId, base: tree.baseCommit })}>查看实际改动</button>}
        </div>;
      })}
    </details>}
    {review && result.state === "submitted" && !result.managerTaskId && <UserReview link={link} result={result} mismatch={!!result.contextMismatch} onRefresh={onRefresh} />}
  </div>;
}

export function LeadWorkflowPanel({ link, task, root, selectedRow, pages, pending, error, decisions, tasks, focusReview, focusDecision, online = true, onRefresh, onMore, onLocate, onOpen }: {
  link: HostLink; task: Task; root: TaskWorkflowSummaryPage | undefined; pages: readonly TaskWorkflowSummaryPage[];
  pending: boolean; error?: string; decisions: readonly DecisionRequest[]; tasks: readonly Task[]; focusReview?: string; focusDecision?: string; online?: boolean; selectedRow?: TaskWorkflowSummaryRow;
  onRefresh(): void; onMore(): void; onLocate(id: Id): void; onOpen(taskId: Id, sessionId?: Id): void;
}) {
  const [opened, setOpened] = useState<Id>();
  const rows = pages.flatMap((page) => page.tasks);
  const selected = selectedRow ?? rows.find((row) => row.taskId === task.id) ?? root?.tasks.find((row) => row.taskId === task.id);
  const header = selected?.latestResult;
  const canReview = !!header && root?.pendingUserReviewResultId === header.id && root.rootTaskId === task.id && !error && !pending && !task.archivedAt && online;
  const expanded = !!header && (opened === header.id || opened === undefined && focusReview === header.id);
  const publicDecisions = new Set(root?.decisions.map((item) => item.id));
  const human = decisions.filter((item) => publicDecisions.has(item.id) && decisionNeedsPerson(item, tasks) && root?.rootTaskId === task.id);
  return <section className="lead-workflow task-workflow" aria-label="交付与验收" data-testid="task-workflow">
    <strong>交付与验收</strong>
    {root && root.rootTaskId === task.id && <span className="side-note">直属 {root.counts.directTasks} 项 · 全树执行任务 {root.counts.executionTasks} 项，其中已验收 {root.counts.acceptedExecutionTasks} 项</span>}
    {root && root.rootTaskId === task.id && root.counts.directTasks > 0 && rows.filter((row) => row.managerTaskId === task.id).length === root.counts.directTasks &&
      rows.filter((row) => row.managerTaskId === task.id).every((row) => row.acceptedCurrent) && !header && <span className="side-note">全部直属任务已验收，等待主控汇总。</span>}
    {pending && <span role="status" className="side-note">正在更新交付状态…</span>}
    {!online && <span role="status" className="side-note">连接恢复后会自动核对交付状态。</span>}
    {focusReview && root && focusReview !== root.pendingUserReviewResultId && <span role="status" className="side-note">原待验收交付已处理或状态已变化。</span>}
    {error && <div role="alert" className="form-error">交付状态读取失败：{error} <button type="button" className="link-btn" onClick={onRefresh}>刷新</button></div>}
    {focusDecision && root && !publicDecisions.has(focusDecision) && <span role="status" className="side-note">原待决问题已处理或状态已变化。</span>}
    {human.map((decision) => <details key={decision.id} open={focusDecision === decision.id ? true : undefined}><summary>待你决定 · {decision.question}</summary><DecisionCard link={link} decision={decision} /></details>)}
    {header ? <>
      <button type="button" className="btn-ghost small" aria-expanded={expanded} onClick={() => setOpened(expanded ? "" : header.id)}>{resultLabel(header, canReview, !!selected?.acceptedCurrent)} · {expanded ? "收起证据" : "查看证据"}</button>
      {expanded && root && <ResultEvidence key={header.id} link={link} rootId={root.rootTaskId} header={header} review={canReview} tasks={tasks} onRefresh={onRefresh} onOpen={onOpen} />}
    </> : !pending && !error && <span className="side-note">{selected ? "此任务还没有交付。" : "当前页没有此任务的交付状态。"}</span>}
    {!!selected?.waitingForWorktree?.length && <div className="lead-workflow-row">
      <strong>等待接入前置改动</strong>
      {selected.waitingForWorktree.map((input) => <button key={input.prerequisiteTaskId} type="button" className="link-btn" onClick={() => onLocate(input.prerequisiteTaskId)}>
        {tasks.find((item) => item.id === input.prerequisiteTaskId)?.title || "前置任务"}{input.prerequisiteResultId ? ` · ${input.prerequisiteResultId}` : " · 等待可用交付"}
      </button>)}
    </div>}
    {task.lead && rows.filter((row) => row.managerTaskId === task.id).map((row) => <div className="lead-workflow-row" key={row.taskId}>
      <button type="button" className="link-btn" onClick={() => onLocate(row.taskId)}>{row.title || "未命名任务"}</button>
      <span className="side-note">{row.latestResult ? resultLabel(row.latestResult, false, row.acceptedCurrent) : COLUMN_NAMES[row.column]}{row.directTaskCount ? ` · 展开 ${row.directTaskCount} 项直属任务` : ""}</span>
    </div>)}
    {pages.at(-1)?.nextCursor && <button type="button" className="btn-ghost small" disabled={pending} onClick={onMore}>加载更多直属任务</button>}
  </section>;
}
