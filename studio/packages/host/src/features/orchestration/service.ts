import { createHash, randomUUID } from "node:crypto";
import { managementRoot, taskManagement, type BotLeadTaskState, type BotLeadTerm, type BotLeadTermRef, type DecisionRequest, type Id, type Session, type SessionItem, type Task, type TaskResult, type TaskResultHeader, type TaskResultPage, type TaskWorkflow, type TaskWorkflowSummaryPage, type TaskWorkflowSummaryQuery, type TaskWorktreeEvidence, type WorktreeIntegrationRequirement } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError, sessionMoving } from "../../core/shared.js";
import { newId } from "../../store/store.js";
import { assertPlaneManagedBase, inPlaneBotWorktree, isPlaneBotWorker, planeBotWorkspaceId, planeManagedScope } from "../../store/plane-bot.js";
import { currentMessagePurpose, keepsAcceptance } from "../../runtime/message-purpose.js";

const RESULTS_KEY = "task-results:";
const OUTBOX_KEY = "orchestration.outbox";
const RETARGET_REASON = "原主控任期或会话已变化，旧通知终止。";
type Notice = { id: Id; sourceTaskId: Id; targetTaskId: Id; text: string; rootTaskId?: Id; targetSessionId?: Id; targetTerm?: BotLeadTermRef; requiresTerm?: boolean; messageId?: Id; sent?: boolean; error?: string; expiredAt?: string; expiredReason?: string; retiredAt?: string; replacesNoticeId?: Id; replacesItemId?: Id; decisionId?: Id; resultId?: Id; turnId?: Id; direction: "up" | "down" | "user-return" };
type SubmissionInput = Pick<TaskResult, "contextBasis" | "prerequisiteResultIds" | "worktrees">;
type SummaryInputs = { waitingFor: (taskId: Id) => readonly Id[]; waitingForWorktree: (taskId: Id) => WorktreeIntegrationRequirement[] };
const SUMMARY_PAGE_SIZE = 30;
const SUMMARY_PAGE_MAX = 100;

/** The management tree runs work; the inbox remains the sole automatic conversation delivery path. */
export class OrchestrationFeature extends Feature<"tasks" | "sessions" | "collab" | "sharedContext"> {
  private readonly sending = new Set<Id>();
  private readonly summaryEpoch = randomUUID();
  private readonly summaryChanges = new Map<Id, number>();
  currentTerm?: (taskId: Id) => BotLeadTerm | null;
  assertManagementSession?: (sessionId: Id, expectedTerm?: BotLeadTermRef) => BotLeadTerm;
  projectBotLead?: (taskId: Id) => BotLeadTaskState | null;
  verifyWorktrees?: (task: Task, session: Session, input: unknown) => TaskWorktreeEvidence[] | undefined;
  assertPlaneEvidence?: (worktrees: readonly TaskWorktreeEvidence[]) => void;

  workflow(taskId: Id, view: "full" | "pending" = "full"): TaskWorkflow {
    this.requireTask(taskId);
    const tasks = this.store.listTasks();
    const ids = new Set([taskId, ...taskManagement(tasks, taskId).descendants.map((t) => t.id)]);
    return {
      rootTaskId: managementRoot(tasks, taskId)?.id ?? null,
      results: [...ids].flatMap((id) => {
        const owner = this.store.getTask(id);
        if (!owner || owner.archivedAt) return [];
        const results = this.results(id);
        if (view === "full") return results;
        const latest = results.at(-1);
        return latest && !this.acceptedInTree(owner, latest, latest.id, tasks) ? [latest] : [];
      }),
      decisions: this.store.listDecisions({ state: "open" }).filter((d) => d.routedToTaskId === taskId),
      // pending: only notices still on their way or failed (2026-11-17); the delivered history grew with every 主控 read.
      deliveryNotices: this.notices().filter((n) => ids.has(n.sourceTaskId) || ids.has(n.targetTaskId)).map((n) => {
        const row = this.store.getItem(n.messageId ?? n.id);
        const state = n.expiredAt || row?.type === "user" && row.delivery === "expired" ? "expired" as const : row?.type === "user" ? row.delivery === "unsent" ? "failed" as const : row.delivery === "held" ? "waiting" as const : "delivered" as const : n.error ? "failed" as const : "waiting" as const;
        return { id: n.id, taskId: n.targetTaskId, state, detail: state === "expired" || state === "failed" ? n.expiredReason || (row?.type === "user" ? row.deliveryReason : undefined) || n.error || "通知发送失败。" : state === "waiting" ? "等待目标会话空闲后发送。" : "已送入会话。", ...(n.replacesNoticeId ? { replacesNoticeId: n.replacesNoticeId } : {}) };
      }).filter((n) => view === "full" || n.state === "waiting" || n.state === "failed"),
      deliveryIssues: this.notices().filter((n) => (ids.has(n.sourceTaskId) || ids.has(n.targetTaskId)) && this.valid(n)).flatMap((n) => {
        const row = this.store.getItem(n.messageId ?? n.id);
        const unsent = row?.type === "user" && row.delivery === "unsent";
        return unsent || (!row && n.error) ? [{ id: n.id, taskId: n.targetTaskId, detail: (row?.type === "user" ? row.deliveryReason : undefined) || n.error || "通知未送达，请进入目标任务的会话重新发送。" }] : [];
      }),
    };
  }

  results(taskId: Id): TaskResult[] { return JSON.parse(this.store.getKv(RESULTS_KEY + taskId)?.value ?? "[]") as TaskResult[]; }

  /** Final tree check without copying delivery prose or transport history. Full evidence stays addressable by id. */
  workflowSummary(taskId: Id, waiting: Readonly<Record<Id, readonly Id[]>>) {
    const task = this.requireTask(taskId), tasks = this.store.listTasks();
    const pending = this.workflow(taskId, "pending");
    return {
      rootTaskId: pending.rootTaskId,
      tasks: [task, ...taskManagement(tasks, taskId).descendants].filter((t) => !t.archivedAt).map((t) => {
        const latest = this.results(t.id).at(-1);
        return {
          taskId: t.id, title: t.title, managerTaskId: t.managerTaskId ?? null, lead: !!t.lead, column: t.column,
          latestResult: latest ? resultHeader(latest) : null,
          acceptedCurrent: !!latest && this.acceptedInTree(t, latest, latest.id, tasks),
          prerequisiteResultIds: this.f.sharedContext.prerequisites(t.id),
          waitingForTaskIds: waiting[t.id] ?? [],
          // createdAt is the session record's creation, not task.updatedAt or proof of an automatic dispatch.
          sessions: this.store.listSessions({ taskId: t.id }).filter((s) => !s.archivedAt && s.kind === "main").map((s) => ({ id: s.id, status: s.status, createdAt: s.createdAt, ...(s.startedBy ? { startedBy: s.startedBy } : {}) })),
        };
      }),
      decisions: pending.decisions.map((d) => ({ id: d.id, taskId: d.taskId, sessionId: d.sessionId, createdAt: d.createdAt })),
      deliveryIssues: pending.deliveryIssues,
      deliveryNotices: pending.deliveryNotices,
    };
  }

  /** The root is fixed for counts and review; a page reads only one level of the live explicit tree. */
  workflowSummaryPage(rootTaskId: Id, query: TaskWorkflowSummaryQuery, inputs: SummaryInputs): TaskWorkflowSummaryPage {
    const root = this.requireTask(rootTaskId), allTasks = this.store.listTasks();
    if (managementRoot(allTasks, root.id)?.id !== root.id || root.topicId && this.store.getTopic(root.topicId)?.archivedAt) throw new HostError("conflict", "管理根已变化，请刷新画布后选择当前管理树。");
    const { descendants, direct } = taskManagement(allTasks, root.id);
    const parentTaskId = query.parentTaskId ?? null;
    const parent = parentTaskId === null || parentTaskId === root.id ? root : descendants.find((task) => task.id === parentTaskId);
    if (!parent) throw new HostError("conflict", "所选分支已移出这棵管理树，请刷新画布。", { reason: "stale-workflow-page", rootTaskId });
    const limit = query.limit ?? SUMMARY_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SUMMARY_PAGE_MAX) throw new HostError("bad_request", `每页须为 1 到 ${SUMMARY_PAGE_MAX} 项。`);

    const tree = [root, ...descendants], treeIds = new Set(tree.map((task) => task.id));
    const children = parent.id === root.id ? direct : descendants.filter((task) => task.managerTaskId === parent.id);
    const childrenByManager = new Map<Id, Task[]>();
    for (const child of descendants) {
      const siblings = childrenByManager.get(child.managerTaskId!) ?? [];
      siblings.push(child);
      childrenByManager.set(child.managerTaskId!, siblings);
    }
    const recent = new Map<Id, TaskResult | undefined>();
    const latestFor = (id: Id) => {
      if (!recent.has(id)) recent.set(id, this.results(id).at(-1));
      return recent.get(id);
    };
    const accepted = new Map<Id, boolean>();
    const acceptedFor = (task: Task): boolean => {
      if (!accepted.has(task.id)) {
        const latest = latestFor(task.id);
        accepted.set(task.id, !!latest && this.acceptedCurrent(task, latest, latest.id) && (childrenByManager.get(task.id) ?? []).every(acceptedFor));
      }
      return accepted.get(task.id)!;
    };
    const execution = descendants.filter((task) => !task.lead);
    const counts = { directTasks: direct.length, executionTasks: execution.length, acceptedExecutionTasks: execution.filter((task) => task.column === "done" && acceptedFor(task)).length };
    const open = this.store.listDecisions({ state: "open" }).filter((decision) => !!decision.taskId && treeIds.has(decision.taskId));
    const decisions = open.map(({ id, taskId, sessionId, createdAt }) => ({ id, taskId, sessionId, createdAt }));
    const latest = latestFor(root.id);
    const pendingUserReviewResultId = root.column === "review" && latest?.state === "submitted" && latest.managerTaskId === null && !open.length && descendants.every((task) => task.column === "done" && acceptedFor(task)) ? latest.id : null;
    // Changes outside this tree (including streaming output) must not exhaust a browsing user's cursor.
    const dependencies = root.topicId ? this.store.getCanvas(root.topicId)?.edges.filter((edge) => edge.kind === "depends" && treeIds.has(edge.to)).map(({ from, to }) => [from, to]) ?? [] : [];
    const upstreamIds = new Set(dependencies.map(([from]) => from));
    const stamps = [...tree, ...allTasks.filter((task) => upstreamIds.has(task.id) && !treeIds.has(task.id))].map(({ id, managerTaskId, updatedAt }) => [id, managerTaskId, updatedAt, this.summaryChanges.get(id)]);
    const revision = createHash("sha256").update(JSON.stringify([this.summaryEpoch, root.id, parentTaskId, stamps, dependencies, counts, decisions, pendingUserReviewResultId])).digest("base64url");
    const start = summaryOffset(rootTaskId, query.cursor, revision, children.length);
    const end = Math.min(start + limit, children.length);
    const pageTasks = children.slice(start, end);
    if (!query.cursor && parentTaskId === null) pageTasks.unshift(root);
    return { rootTaskId, parentTaskId, nextCursor: end < children.length ? `${revision}.${end}` : null, counts, decisions, pendingUserReviewResultId, tasks: pageTasks.map((task) => {
      const result = latestFor(task.id), session = this.targetSession(task.id, { allowPaused: true });
      const botLead = this.projectBotLead?.(task.id) ?? task.botLead;
      const waitingForWorktree = inputs.waitingForWorktree(task.id);
      return { taskId: task.id, title: task.title, managerTaskId: task.managerTaskId ?? null, lead: !!task.lead, column: task.column, ...(botLead ? { botLead } : {}), directTaskCount: childrenByManager.get(task.id)?.length ?? 0, latestResult: result ? resultHeader(result) : null, acceptedCurrent: acceptedFor(task), prerequisiteResultIds: this.f.sharedContext.prerequisites(task.id), waitingForTaskIds: inputs.waitingFor(task.id), ...(waitingForWorktree.length ? { waitingForWorktree } : {}), session: session ? { id: session.id, status: session.status, createdAt: session.createdAt } : null };
    }) };
  }

  /** Same readable scope as workflow; a result id never grants authority to accept or manage its owner. */
  readResult(taskId: Id, resultId: Id, offset = 0): TaskResultPage {
    const task = this.requireTask(taskId);
    const tasks = this.store.listTasks();
    const owners = [task, ...taskManagement(tasks, taskId).descendants].filter((t) => !t.archivedAt);
    for (const owner of owners) {
      const results = this.results(owner.id), result = results.find((r) => r.id === resultId);
      if (!result) continue;
      // Paging the complete JSON preserves every field, including review and requirement-resolution evidence.
      const text = JSON.stringify(result);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new HostError("bad_request", "交付位置无效。");
      const end = Math.min(offset + 6000, text.length);
      const latestId = results.at(-1)?.id;
      return { result: resultHeader(result), latest: latestId === resultId, acceptedCurrent: this.acceptedInTree(owner, result, latestId, tasks), text: text.slice(offset, end), nextOffset: end < text.length ? end : null, length: text.length };
    }
    throw new HostError("bad_request", "该结果不在指定任务及其当前下辖的可读交付中；请核对 taskId 和当前归属。");
  }

  private acceptedCurrent(task: Task, result: TaskResult, latestId: Id | undefined): boolean {
    const filedForReview = task.column === "review" && result.reviewedBy === "user" && this.humanReviewable(task);
    if (result.planePlanHash) {
      const scope = planeManagedScope(this.store, task.id);
      if (!scope?.approved_at || result.planePlanHash !== scope.plan_hash) return false;
    }
    return (task.column === "done" || filedForReview) && result.state === "accepted" && latestId === result.id && result.managerTaskId === (task.managerTaskId ?? null) && this.f.sharedContext.isResultCurrent(task.id, result);
  }

  private acceptedInTree(task: Task, result: TaskResult, latestId: Id | undefined, tasks: Task[]): boolean {
    if (!this.acceptedCurrent(task, result, latestId) || !managementRoot(tasks, task.id) && !this.humanReviewable(task)) return false;
    return !task.lead || taskManagement(tasks, task.id).descendants.every((descendant) => {
      const latest = this.results(descendant.id).at(-1);
      return !!latest && this.acceptedCurrent(descendant, latest, latest.id);
    });
  }

  currentUserAcceptance(taskId: Id, resultId: Id): boolean {
    const task = this.store.getTask(taskId), result = this.results(taskId).at(-1);
    if (!task || !result || result.id !== resultId || result.reviewedBy !== "user" || !this.acceptedInTree(task, result, resultId, this.store.listTasks())) return false;
    if (!result.planePlanHash) return true;
    try {
      this.assertCurrentPlaneWorkers(task, result.worktrees ?? []);
      return true;
    } catch {
      return false;
    }
  }

  private planeWorkerEvidence(task: Task, version: string): TaskWorktreeEvidence[] {
    return taskManagement(this.store.listTasks(), task.id).descendants.filter((child) => !child.lead).flatMap((child) => {
      const result = this.results(child.id).at(-1);
      if (!result || result.planePlanHash !== version || !this.acceptedCurrent(child, result, result.id) || !result.worktrees?.length) {
        throw new HostError("conflict", `「${child.title}」缺少当前已批准版本的执行工作树交付。`);
      }
      return result.worktrees.map((tree) => ({ ...tree, resultId: result.id, title: child.title }));
    });
  }

  private assertCurrentPlaneWorkers(task: Task, worktrees: readonly TaskWorktreeEvidence[]): void {
    const scope = planeManagedScope(this.store, task.id);
    if (!scope?.approved_at) throw new HostError("conflict", "Plane 工单没有当前批准的执行计划。");
    const current = this.planeWorkerEvidence(task, scope.plan_hash);
    if (current.length !== worktrees.length || current.some((row) => !worktrees.some((recorded) => row.taskId === recorded.taskId && row.resultId === recorded.resultId && row.changeDigest === recorded.changeDigest))) {
      throw new HostError("conflict", "执行交付已换版，请退回并重新汇总实际工作树。");
    }
  }

  readReply(sessionId: Id, itemId: Id, offset = 0): { text: string; nextOffset: number | null; length: number } {
    const { task: manager } = this.own(sessionId);
    const item = this.store.getItem(itemId);
    const source = item && this.store.getSession(item.sessionId);
    const child = source?.taskId && this.store.getTask(source.taskId);
    if (!manager.lead || !item || item.type !== "agent" || !source || source.archivedAt || !child || child.archivedAt || child.managerTaskId !== manager.id) throw new HostError("read_only", "只能读取当前直属任务的会话回复。");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.markdown.length) throw new HostError("bad_request", "回复位置无效。");
    const end = Math.min(offset + 6000, item.markdown.length);
    return { text: item.markdown.slice(offset, end), nextOffset: end < item.markdown.length ? end : null, length: item.markdown.length };
  }
  private saveResults(taskId: Id, results: TaskResult[]): void { this.store.setKv(RESULTS_KEY + taskId, JSON.stringify(results)); }
  private notices(): Notice[] { return JSON.parse(this.store.getKv(OUTBOX_KEY)?.value ?? "[]") as Notice[]; }
  private saveNotices(notices: Notice[]): void { this.store.setKv(OUTBOX_KEY, JSON.stringify(notices)); }

  /** Run before inbox recovery: migrate only facts recoverable from durable producer records. */
  prepareInbox(): void {
    for (const notice of this.notices()) {
      if (notice.expiredAt || notice.retiredAt) continue;
      let row = this.store.getItem(notice.messageId ?? notice.id);
      // Revocation precedes provenance inference: later returned/accepted states never revive an old terminal row.
      if (row && this.f.sessions.inbox.expireLegacy(row)) { this.expireNotice(notice, "旧管理通知已永久作废，禁止根据后来的业务状态重新生成。"); continue; }
      if (!notice.rootTaskId && !notice.expiredAt) {
        const tokens = row?.type === "user" ? [...row.text.matchAll(/^\[AMO_SHARED_CONTEXT:([^\]]+)\]\r?$/gm)].map((m) => m[1]) : [];
        const receipts = row ? this.f.sharedContext.receipts(row.sessionId).filter((r) => tokens.includes(r.requirementId)) : [];
        const roots = [...new Set(receipts.map((r) => r.rootTaskId))];
        if (tokens.length && receipts.length === tokens.length && roots.length === 1) this.patchNotice(notice.id, { rootTaskId: roots[0] });
        else {
          const pending = !row || row.type === "user" && (row.delivery === "held" || row.delivery === "unsent");
          const valid = this.valid(notice), root = managementRoot(this.store.listTasks(), notice.sourceTaskId)?.id;
          const currentText = valid && pending ? this.currentBusiness(notice) : null;
          this.store.transaction(() => {
            this.expireNotice(notice, `历史管理根缺少可核验依据，原通知永久终止。${notice.error ? `原发送记录：${notice.error}` : ""}`);
            if (currentText && root) this.queue({ id: `${notice.id}-reconciled-${root}`, sourceTaskId: notice.sourceTaskId, targetTaskId: notice.targetTaskId, rootTaskId: root, direction: notice.direction, resultId: notice.resultId, decisionId: notice.decisionId, text: currentText, replacesNoticeId: notice.id, replacesItemId: row?.id });
          });
          continue;
        }
      }
      const current = this.notices().find((n) => n.id === notice.id)!;
      if (current.expiredAt || current.retiredAt) continue;
      if (!this.valid(current)) { this.expireNotice(current, "任务归属、交付或问题状态已变化；原通知永久作废。"); continue; }
      if ((current.targetTerm || this.currentTerm?.(current.targetTaskId)) && this.retarget(current)) continue;
      row = this.store.getItem(notice.messageId ?? notice.id);
      if (row?.type === "user" && !row.messagePurpose && (row.delivery === "held" || row.delivery === "unsent")) this.store.replaceItem({ ...row, messagePurpose: notice.direction === "up" ? "notification" : "work" });
    }
  }

  private currentBusiness(notice: Notice): string | null {
    if (notice.decisionId) {
      const d = this.store.getDecision(notice.decisionId);
      return d?.state === "open" && d.routedToTaskId === notice.targetTaskId ? decisionNotice(d) : null;
    }
    if (notice.resultId) {
      const result = this.results(notice.direction === "up" ? notice.sourceTaskId : notice.targetTaskId).at(-1);
      if (!result || result.id !== notice.resultId || result.managerTaskId !== (notice.direction === "user-return" ? null : notice.direction === "up" ? notice.targetTaskId : notice.sourceTaskId)) return null;
      return notice.direction === "up" ? submissionNotice(this.requireTask(result.taskId).title, result) : returnNotice(result);
    }
    const task = this.requireTask(notice.sourceTaskId);
    return `【当前任务状态核对】\n${noticeData({ taskId: task.id, title: task.title, column: task.column })}\n请通过 task_workflow 查看当前交付和待决问题。`;
  }

  async retry(taskId: Id, noticeId: Id): Promise<void> {
    this.requireTask(taskId);
    const ids = new Set([taskId, ...taskManagement(this.store.listTasks(), taskId).descendants.map((t) => t.id)]);
    const notice = this.notices().find((n) => n.id === noticeId && (ids.has(n.sourceTaskId) || ids.has(n.targetTaskId)));
    if (!notice || !this.valid(notice)) throw new HostError("conflict", "这条管理通知已过期或不属于当前管理范围，不能重试。");
    const row = this.store.getItem(notice.messageId ?? notice.id);
    if (row?.type === "user") {
      if (row.delivery !== "unsent") throw new HostError("conflict", "只有发送失败的通知可以重试；等待中的通知请在会话里立即发送。");
      await this.f.sessions.resend(row.sessionId, row.id);
      this.patchNotice(notice.id, { error: undefined, sent: true });
    } else { this.patchNotice(notice.id, { error: undefined, sent: false }); this.deliver(); }
    this.changed(notice.targetTaskId);
  }

  private humanReviewable(task: Task): boolean {
    return !task.managerTaskId && (task.lead
      ? managementRoot(this.store.listTasks(), task.id)?.id === task.id
      : isPlaneBotWorker(this.store, task.id));
  }

  private own(sessionId: Id, allowPlaneWorker = false): { session: Session; task: Task } {
    const session = this.requireSession(sessionId);
    const task = session.taskId ? this.requireTask(session.taskId) : null;
    if (!task || task.archivedAt || task.remote || session.archivedAt || session.kind === "sub" || session.writer === "archived" || (!managementRoot(this.store.listTasks(), task.id) && !(allowPlaneWorker && this.humanReviewable(task)))) throw new HostError("bad_request", "此操作需要有效管理树中的本地任务会话。");
    if (task.topicId) this.requireLiveTopic(task.topicId);
    return { session, task };
  }

  private managementSession(session: Session, task: Task, expected?: BotLeadTermRef): BotLeadTerm | null {
    const term = this.currentTerm?.(task.id);
    if (!task.lead && !term && !session.botLeadTerm && !expected) return null;
    if (!term || !this.assertManagementSession) throw new HostError("read_only", "当前主控任期无法校验，请使用现任主控会话。");
    return this.assertManagementSession(session.id, expected ?? term);
  }

  private targetSession(taskId: Id, options: { allowPaused?: boolean } = {}): Session | undefined {
    const term = this.currentTerm?.(taskId);
    const usable = (s: Session) => s.kind === "main" && !s.archivedAt && s.runtime !== "remote" && s.writer !== "archived" && s.writer !== "terminal-handoff";
    if (term) {
      const session = term.sessionId ? this.store.getSession(term.sessionId) : undefined;
      if (!session || session.taskId !== taskId || !usable(session)) return undefined;
      if (options.allowPaused) return session;
      if (term.state !== "active" || !["idle", "running"].includes(term.runState) || !this.assertManagementSession) return undefined;
      try { this.assertManagementSession(session.id, term); }
      catch { return undefined; } // The durable notice waits for the current term to become available.
      return session;
    }
    if (this.store.getTask(taskId)?.lead) return undefined;
    return this.store.listSessions({ taskId }).filter((s) => usable(s) && !s.botLeadTerm).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private ready(task: Task): void {
    const { descendants, direct } = taskManagement(this.store.listTasks(), task.id);
    const unfinished = descendants.filter((t) => {
      const result = this.results(t.id).at(-1);
      return !result || !this.acceptedCurrent(t, result, result.id) || this.hasOpenWork(t.id);
    });
    if (unfinished.length) {
      const unfinishedDirect = direct.filter((child) => unfinished.some((t) => t.id === child.id));
      const remaining = unfinishedDirect.length ? unfinishedDirect : unfinished;
      throw new HostError("conflict", `请先验收直属任务并处理下辖未就绪工作：${remaining.map((t) => t.title || t.id).join("、")}`);
    }
    const ids = new Set([task.id, ...descendants.map((t) => t.id)]);
    if (this.store.listDecisions({ state: "open" }).some((d) => d.taskId && ids.has(d.taskId))) throw new HostError("conflict", "本任务或下辖还有未处理的业务问题，请先解决再交付。");
  }

  private hasOpenWork(taskId: Id): boolean {
    return this.store.listSessions({ taskId }).some((s) => !s.archivedAt && (this.store.findItems(s.id, "background", { state: "running" }).length > 0 || sessionMoving(s) && !keepsAcceptance(currentMessagePurpose(this.store, s.id))));
  }

  private assertReviewSettled(taskId: Id): void {
    if (this.hasOpenWork(taskId)) throw new HostError("conflict", "执行任务仍在工作，请等本轮结束后再验收。");
  }

  submit(sessionId: Id, summaryIn: unknown, verificationIn: unknown, input?: SubmissionInput): TaskResult {
    const { session, task } = this.own(sessionId, true);
    const term = this.managementSession(session, task);
    const summary = requiredText(summaryIn, "交付摘要"), verification = requiredText(verificationIn, "验证证据");
    const result = this.host.transaction(() => {
      const { task: current, session: source } = this.own(sessionId, true);
      const currentTerm = this.managementSession(source, current, term ?? undefined);
      const planeWorkspace = planeBotWorkspaceId(this.store, current.id);
      if (planeWorkspace && !inPlaneBotWorktree(source, current.id, planeWorkspace)) throw new HostError("conflict", "请在执行任务的独立工作树会话中提交交付。");
      const plane = planeManagedScope(this.store, current.id);
      if (plane) assertPlaneManagedBase(this.store, plane);
      this.ready(current);
      const basis = this.f.sharedContext.captureBasis(sessionId, input);
      if (input?.worktrees !== undefined && !this.verifyWorktrees) throw new HostError("conflict", "当前 Host 没有工作树证据核验能力。");
      const checkedWorktrees = this.verifyWorktrees?.(current, source, input?.worktrees);
      const worktrees = plane && current.lead ? this.planeWorkerEvidence(current, plane.plan_hash) : checkedWorktrees;
      if (plane && current.lead) {
        if (!worktrees?.length && plane.root_task_id === current.id) throw new HostError("conflict", "请先完成并验收至少一个有实际独立工作树的执行任务，再汇总 Plane 交付。");
        this.assertPlaneEvidence?.(worktrees ?? []);
      }
      const results = this.results(current.id), previous = results.at(-1);
      if (previous && previous.planePlanHash === plane?.plan_hash && (previous.state === "submitted" || this.acceptedCurrent(current, previous, previous.id)) && previous.summary === summary && previous.verification === verification && previous.managerTaskId === (current.managerTaskId ?? null) && JSON.stringify(previous.contextBasis) === JSON.stringify(basis.contextBasis) && JSON.stringify(previous.prerequisiteResultIds) === JSON.stringify(basis.prerequisiteResultIds) && JSON.stringify(previous.worktrees) === JSON.stringify(worktrees)) return previous;
      if (previous?.state === "submitted") throw new HostError("conflict", current.managerTaskId ? "交付已提交，等待直属主控验收；需修改时由主控先退回。" : "最终交付已提交，等待用户在 Studio 验收或退回；AI 不能自行验收。");
      const at = new Date().toISOString();
      const submittedByLead = currentTerm ? { termId: currentTerm.termId, generation: currentTerm.generation, botId: currentTerm.botId, name: currentTerm.name } : undefined;
      const next: TaskResult = { id: newId("result"), taskId: current.id, sessionId, managerTaskId: current.managerTaskId ?? null, summary, verification, ...basis, ...(plane ? { planePlanHash: plane.plan_hash } : {}), ...(submittedByLead ? { submittedByLead } : {}), ...(worktrees?.length ? { worktrees } : {}), state: "submitted", createdAt: at, updatedAt: at };
      this.saveResults(current.id, [...results, next]);
      if (current.managerTaskId) this.queue({ id: `i-${next.id}-submit`, sourceTaskId: current.id, targetTaskId: current.managerTaskId, direction: "up", resultId: next.id, text: submissionNotice(current.title, next) });
      if (this.f.tasks.updateTask(current.id, { column: "review" }).column !== "review") throw new HostError("conflict", "下辖仍有正在进行的工作，等安定后再提交交付。");
      return next;
    });
    this.deliver();
    return result;
  }

  review(sessionId: Id, resultId: Id, accept: boolean, reviewIn: unknown, contextExplanation?: string): TaskResult {
    const { task: manager, session } = this.own(sessionId);
    if (!manager.lead) throw new HostError("bad_request", "只有直属主控能够验收交付。");
    const term = this.managementSession(session, manager);
    const review = requiredText(reviewIn, "验收结论或退回原因");
    if (this.results(manager.id).some((r) => r.id === resultId)) throw new HostError("bad_request", "不能自行验收交付：总主控等待用户在 Studio 验收或退回，受管主控交给直属主控。");
    const child = this.store.listTasks().find((t) => t.managerTaskId === manager.id && !t.archivedAt && this.results(t.id).some((r) => r.id === resultId));
    if (!child) throw new HostError("bad_request", "结果不属于你的有效直属任务，归属可能已变更。");
    return this.reviewResult(child, manager.id, resultId, accept, review, contextExplanation, { sessionId, term });
  }

  /** Human-only REST entry; the MCP credential cannot reach REST and no AI tool exposes this operation. */
  reviewByUser(taskId: Id, resultId: Id, accept: boolean, reviewIn: unknown, contextExplanation?: string): TaskResult {
    const task = this.requireTask(taskId);
    if (task.archivedAt || task.remote || !this.humanReviewable(task)) throw new HostError("bad_request", "用户验收适用于当前总主控和独立 Plane Bot 任务；受管任务由直属主控验收。");
    if (task.topicId) this.requireLiveTopic(task.topicId);
    return this.reviewResult(task, null, resultId, accept, requiredText(reviewIn, "验收结论或退回原因"), contextExplanation);
  }

  private reviewResult(child: Task, expectedManager: Id | null, resultId: Id, accept: boolean, review: string, contextExplanation?: string, actor?: { sessionId: Id; term: BotLeadTerm | null }): TaskResult {
    const state = accept ? "accepted" : "returned";
    const reviewer = expectedManager ? "manager" : "user";
    const next = this.host.transaction(() => {
      // Acceptance is based on the requirement and ownership read inside the write transaction.
      const current = this.requireTask(child.id), currentManager = expectedManager ? this.requireTask(expectedManager) : current, currentResults = this.results(child.id), currentLatest = currentResults.at(-1);
      const reviewable = expectedManager ? currentManager.lead && !!managementRoot(this.store.listTasks(), current.id) : this.humanReviewable(current);
      if (current.archivedAt || current.remote || (current.managerTaskId ?? null) !== expectedManager || !reviewable || currentLatest?.id !== resultId || currentLatest.managerTaskId !== expectedManager) throw new HostError("conflict", "只能验收最新且归属仍有效的交付，请重新读取后验收。");
      if (current.topicId) this.requireLiveTopic(current.topicId);
      if (actor) {
        const term = this.managementSession(this.requireSession(actor.sessionId), currentManager, actor.term ?? undefined);
        if (term && currentLatest.submittedByLead?.botId === term.botId) throw new HostError("conflict", "这版交付由现任主控提交，需要另一位主控验收，请从主控卡换任。", { reason: "reviewer-is-submitter", taskId: current.id, resultId });
      }
      if (currentLatest.state === state && currentLatest.reviewedBy === reviewer && currentLatest.review === review && (!contextExplanation || !currentLatest.contextResolution || currentLatest.contextResolution.explanation === contextExplanation.trim())) {
        if (accept && !this.acceptedInTree(current, currentLatest, currentLatest.id, this.store.listTasks())) throw new HostError("conflict", "原验收的依据已经变化，请读取当前工作流。");
        return currentLatest;
      }
      if (currentLatest.state !== "submitted" || current.column !== "review") throw new HostError("conflict", "此交付已经处理或任务已重新开始，请读取最新状态。");
      if (accept) {
        const planeWorkspace = planeBotWorkspaceId(this.store, current.id);
        if (planeWorkspace && !inPlaneBotWorktree(this.store.getSession(currentLatest.sessionId), current.id, planeWorkspace)) throw new HostError("conflict", "这份交付未关联独立工作树，请退回后从执行工作树重新提交。");
        const plane = planeManagedScope(this.store, current.id);
        if (plane) {
          assertPlaneManagedBase(this.store, plane);
          if (currentLatest.planePlanHash !== plane.plan_hash) throw new HostError("conflict", "这份交付属于旧版 Plane 计划，请退回后重新提交。");
          if (current.lead) this.assertCurrentPlaneWorkers(current, currentLatest.worktrees ?? []);
          this.assertPlaneEvidence?.(currentLatest.worktrees ?? []);
        }
        this.assertReviewSettled(current.id);
        this.ready(current);
      }
      const contextResolution = accept ? this.f.sharedContext.assertAcceptable(current.id, currentLatest, contextExplanation) : undefined;
      const updatedAt = new Date().toISOString();
      const next: TaskResult = { ...currentLatest, state, review, reviewedBy: reviewer, ...(!expectedManager ? { userReview: { state, review, reviewedAt: updatedAt } } : {}), ...(contextResolution ? { contextResolution } : {}), updatedAt };
      this.saveResults(child.id, [...currentResults.slice(0, -1), next]);
      // Done again: tasks that started on its earlier delivery go on from this one (2026-11-17, plans/done/task-dependencies.md).
      if (accept) this.f.sharedContext.refreshPrerequisites(child.id, next.id);
      if (!accept) this.queue({ id: `i-${next.id}-return`, sourceTaskId: expectedManager ?? child.id, targetTaskId: child.id, direction: expectedManager ? "down" : "user-return", resultId, text: returnNotice(next) });
      this.f.tasks.updateTask(child.id, { column: accept ? "done" : "doing" });
      return next;
    });
    this.deliver();
    return next;
  }

  answerDecision(sessionId: Id, decisionId: Id, answer: unknown): DecisionRequest {
    const { task, session } = this.own(sessionId);
    this.managementSession(session, task);
    const decision = this.store.getDecision(decisionId);
    const source = decision?.taskId ? this.store.getTask(decision.taskId) : undefined;
    if (!task.lead || !decision || decision.routedToTaskId !== task.id || source?.managerTaskId !== task.id || !managementRoot(this.store.listTasks(), source.id)) throw new HostError("bad_request", "此问题不属于你当前管理的直属任务。");
    if (decision.state !== "open") throw new HostError("conflict", "这条问题已经处理，请读取当前状态。");
    return this.f.collab.answerDecision(decisionId, requiredText(answer, "决定"));
  }

  answerDecisionByUser(decisionId: Id, answer: unknown): DecisionRequest {
    const decision = this.store.getDecision(decisionId);
    if (!decision) throw new HostError("not_found", "问题不存在。");
    if (decision.state !== "open") throw new HostError("conflict", "这条问题已经处理，请刷新。");
    const task = decision.taskId ? this.requireTask(decision.taskId) : null;
    if (task?.archivedAt || task?.remote) throw new HostError("conflict", "问题对应的任务已失效，请刷新。");
    if (task?.topicId) this.requireLiveTopic(task.topicId);
    if (task?.managerTaskId || decision.routedToTaskId) throw new HostError("conflict", "这条问题由直属主控处理。总主控提交给你的问题会出现在待办中。");
    return this.f.collab.answerDecision(decisionId, answer);
  }

  validateMessage(item: { id: Id; sessionId: Id }): void {
    const notices = this.notices().filter((n) => n.targetSessionId === item.sessionId && (n.messageId ?? n.id) === item.id);
    if (!notices.length) return;
    const active = notices.find((n) => this.valid(n) && this.sameTarget(n));
    if (!active) throw new HostError("read_only", "管理通知已处理或归属、任期已变化，请读取最新工作流。");
    if (active.targetTerm && this.targetSession(active.targetTaskId)?.id !== item.sessionId) throw new HostError("read_only", "主控任期暂不可用，请在恢复当前主控后处理通知。");
  }

  watch(): void {
    this.saveNotices(this.notices().map((n) => n.sent && !n.error && !this.store.getItem(n.messageId ?? n.id) ? { ...n, sent: false } : n));
    const owners = new Map(this.store.listTasks().map((task) => [task.id, task.managerTaskId ?? null]));
    this.host.on("event", (event) => {
      const changedTaskId = event.type === "task.upserted" ? event.task.id : event.type === "bot-lead.changed" ? event.taskId : event.type === "session.upserted" && event.session.kind === "main" ? event.session.taskId : null;
      if (changedTaskId) this.summaryChanges.set(changedTaskId, Math.max(event.seq, this.summaryChanges.get(changedTaskId) ?? 0));
      if (event.type === "decision.upserted") {
        if (event.decision.state === "open" && event.decision.routedToTaskId) this.routeDecision(event.decision);
        else this.deliver();
      }
      if (event.type === "task.upserted") {
        const managerId = event.task.managerTaskId ?? null, previousManagerId = owners.get(event.task.id);
        owners.set(event.task.id, managerId);
        this.reconcileDecisions();
        const results = this.results(event.task.id), latest = results.at(-1);
        // Filing a human-accepted root in 待审阅 is not a new assignment. Doing/todo, ownership changes and
        // real managed work still invalidate it; this never turns an unreviewed/returned result into acceptance.
        const filedForReview = latest?.reviewedBy === "user" && event.task.column === "review" && this.humanReviewable(event.task);
        if (latest && latest.managerTaskId !== (event.task.managerTaskId ?? null) && latest.state !== "returned") {
          this.saveResults(event.task.id, [...results.slice(0, -1), { ...latest, state: "returned", reviewedBy: undefined, review: "直属主控已变更，请按当前归属重新提交交付。", updatedAt: new Date().toISOString() }]);
        } else if ((latest?.state === "accepted" && event.task.column !== "done" && !filedForReview || latest?.state === "submitted" && event.task.column !== "review") && !event.task.archivedAt) {
          this.saveResults(event.task.id, [...results.slice(0, -1), { ...latest, state: "returned", reviewedBy: undefined, review: "交付后任务重新开始，须重新提交验证和验收。", updatedAt: new Date().toISOString() }]);
          if (event.task.managerTaskId) {
            // Not when the manager's own 传话 restarted it (2026-11-17: the Free 主控 was woken only to say 已知悉).
            if (!this.reopenedByManager(event.task, latest)) this.queue({ id: `i-${latest.id}-reopened`, sourceTaskId: event.task.id, targetTaskId: event.task.managerTaskId, direction: "up", text: `【下级任务重新开始】\n${noticeData({ taskId: event.task.id, title: event.task.title, previousResultId: latest.id })}\n请等待该任务提交新版并重新验收。` });
            const manager = this.store.getTask(event.task.managerTaskId);
            if (manager && !manager.archivedAt && (manager.column === "done" || manager.column === "review") && ["accepted", "submitted"].includes(this.results(manager.id).at(-1)?.state ?? "")) this.f.tasks.updateTask(manager.id, { column: "doing" });
          }
        }
        if (previousManagerId !== undefined && previousManagerId !== managerId) this.reopenAncestors(previousManagerId, managerId);
        this.deliver();
      }
      if (event.type === "session.upserted") { this.reportTurn(event.session); this.deliver(); }
      if (event.type === "item.updated" && event.item.type === "user") this.deliver();
      if (event.type === "bot-lead.changed" || event.type === "bots.changed" || event.type === "settings.updated" || event.type === "topic.upserted") this.deliver();
      if (event.type === "data.purged") for (const id of event.taskIds) { owners.delete(id); this.summaryChanges.delete(id); }
    });
    // Only explicit pending work resumes; installation never replays historical session completions.
    this.reconcileDecisions();
    this.deliver();
  }

  private reopenAncestors(...managers: Array<Id | null>): void {
    const seen = new Set<Id>();
    for (let managerId of managers) while (managerId && !seen.has(managerId)) {
      seen.add(managerId);
      const manager = this.store.getTask(managerId);
      if (!manager || manager.archivedAt || manager.remote) break;
      if ((manager.column === "done" || manager.column === "review") && ["accepted", "submitted"].includes(this.results(manager.id).at(-1)?.state ?? "")) this.f.tasks.updateTask(manager.id, { column: "doing" });
      managerId = manager.managerTaskId ?? null;
    }
  }

  private routeDecision(decision: DecisionRequest, rerouted = false): void {
    if (!decision.taskId || !decision.routedToTaskId) return;
    const previous = this.notices().filter((notice) => notice.decisionId === decision.id);
    if (previous.some((notice) => this.valid(notice))) return;
    const base = `i-${decision.id}-${decision.routedToTaskId}`;
    const prior = previous.find((notice) => notice.id === base);
    if (prior && !rerouted) return;
    // A real reassignment can return to a past manager. Re-read the live decision and retain the revoked receipt.
    this.queue({ id: prior ? `${base}-rerouted-${previous.length}` : base, sourceTaskId: decision.taskId, targetTaskId: decision.routedToTaskId, direction: "up", decisionId: decision.id, text: decisionNotice(decision), ...(prior ? { replacesNoticeId: prior.id, replacesItemId: this.store.getItem(prior.messageId ?? prior.id)?.id } : {}) });
    this.deliver();
  }

  private reconcileDecisions(): void {
    const open = this.store.listDecisions({ state: "open" });
    if (!open.some((decision) => decision.taskId)) return;
    const tasks = this.store.listTasks(), byId = new Map(tasks.map((task) => [task.id, task]));
    for (const decision of open) {
      const source = decision.taskId ? byId.get(decision.taskId) : undefined;
      const target = source?.managerTaskId && managementRoot(tasks, source.id) ? source.managerTaskId : null;
      if (target !== (decision.routedToTaskId ?? null)) {
        const next = { ...decision, routedToTaskId: target };
        this.host.transaction(() => {
          this.store.putDecision(next);
          this.routeDecision(next, true);
          this.publish({ type: "decision.upserted", decision: next });
        });
      } else if (target) this.routeDecision(decision);
    }
  }

  private reportTurn(session: Session): void {
    if (!session.taskId || session.kind !== "main" || session.archivedAt || session.runtime === "remote" || !["idle", "completed", "error", "interrupted"].includes(session.status)) return;
    const task = this.store.getTask(session.taskId);
    if (!task?.managerTaskId || !managementRoot(this.store.listTasks(), task.id)) return;
    if (task.lead && (session.botLeadTerm || this.currentTerm?.(task.id)) && this.targetSession(task.id, { allowPaused: true })?.id !== session.id) return;
    const [turn] = this.store.findItems(session.id, "turn", {}, { newest: true, limit: 1 });
    if (turn?.type !== "turn" || turn.state === "running") return;
    // Coordinators routinely finish a turn to wait for their children. Only explicit deliveries/questions
    // need the parent's attention; reporting this progress automatically creates empty polling turns.
    if (task.lead && turn.state === "completed") return;
    if (turn.state === "completed" && this.reportedDecision(task, turn)) return;
    // A question of the child's still waits for this manager: that decision is what it acts on, and a status repeating it
    // only woke the Free 主控 again (2026-11-17).
    if (turn.state === "completed" && this.store.listDecisions({ state: "open" }).some((d) => d.taskId === task.id && d.routedToTaskId === task.managerTaskId)) return;
    const latest = this.results(task.id).at(-1);
    if (latest && latest.createdAt >= turn.startedAt && latest.state === "submitted") return;
    const [last] = this.store.findItems(session.id, "agent", {}, { newest: true, limit: 1 });
    const agent = last?.type === "agent" && last.createdAt >= turn.startedAt ? last : null;
    const message = noticeData({ taskId: task.id, title: task.title, sessionId: session.id, turnId: turn.id, state: turn.state, ...(turn.state === "failed" ? { error: turn.error ?? "运行失败" } : { reply: agent?.markdown.slice(0, 6000) ?? "（暂无文字结果）" }) });
    this.queue({ id: `i-${turn.id}-manager`, sourceTaskId: task.id, targetTaskId: task.managerTaskId, direction: "up", turnId: turn.id, text: `【下级任务本轮状态】\n${message}${agent && agent.markdown.length > 6000 ? `\n【回复已截断，共 ${agent.markdown.length} 字符；用 task_read_reply 读取完整回复，itemId: ${agent.id}】` : ""}\n有具体工作时用 task_message 继续派工；交付和待决问题通过 task_workflow 核对。` });
  }

  /** A worker's question already has its own durable notification, even if the manager answered immediately. */
  private reportedDecision(task: Task, turn: Extract<SessionItem, { type: "turn" }>): boolean {
    // Codex timestamps turn boundaries to whole seconds while decisions retain milliseconds.
    const end = turn.endedAt ? Date.parse(turn.endedAt) + 1000 : Infinity;
    return this.store.listDecisions().some((d) => d.state !== "withdrawn" && d.taskId === task.id && d.sessionId === turn.sessionId && d.routedToTaskId === task.managerTaskId && d.createdAt >= turn.startedAt && Date.parse(d.createdAt) < end);
  }

  private changed(taskId: Id): void { this.publish({ type: "task.upserted", task: this.requireTask(taskId) }); }

  /** The manager sent this child work (not an inquiry) after the delivery: its own 传话 restarted the task. */
  private reopenedByManager(task: Task, latest: TaskResult): boolean {
    return this.store.listRelays().some((r) => r.fromTaskId === task.managerTaskId && r.toTaskId === task.id && r.purpose !== "inquiry" && r.createdAt >= latest.updatedAt);
  }
  private queue(notice: Notice): void {
    const notices = this.notices();
    if (notices.some((n) => n.id === notice.id)) return;
    const requiresTerm = notice.requiresTerm || !!this.currentTerm?.(notice.targetTaskId);
    this.saveNotices([...notices, { ...notice, ...(requiresTerm ? { requiresTerm } : {}), rootTaskId: notice.rootTaskId ?? managementRoot(this.store.listTasks(), notice.sourceTaskId)?.id }]);
  }

  private valid(notice: Notice): boolean {
    if (notice.expiredAt || notice.retiredAt) return false;
    const source = this.store.getTask(notice.sourceTaskId), target = this.store.getTask(notice.targetTaskId);
    if (!source || !target || source.archivedAt || target.archivedAt || source.remote || target.remote || (source.topicId && this.store.getTopic(source.topicId)?.archivedAt)) return false;
    if (notice.direction !== "user-return" && !managementRoot(this.store.listTasks(), source.id)) return false;
    if (notice.rootTaskId && managementRoot(this.store.listTasks(), source.id)?.id !== notice.rootTaskId) return false;
    if (notice.direction === "user-return" ? source.id !== target.id || !this.humanReviewable(source) : notice.direction === "up" ? source.managerTaskId !== target.id : target.managerTaskId !== source.id) return false;
    if (notice.decisionId) { const d = this.store.getDecision(notice.decisionId); if (d?.state !== "open" || d.taskId !== source.id || d.routedToTaskId !== target.id) return false; }
    if (notice.resultId) {
      const r = this.results(notice.direction === "up" ? source.id : target.id).at(-1);
      const expectedManager = notice.direction === "up" ? target.id : notice.direction === "down" ? source.id : null;
      if (r?.id !== notice.resultId || r.managerTaskId !== expectedManager || r.state !== (notice.direction === "up" ? "submitted" : "returned")) return false;
    }
    if (notice.turnId) {
      const turn = this.store.getItem(notice.turnId), latest = this.results(source.id).at(-1);
      // Also withdraw progress queued by an older Host, before inbox dispatch or manual retry.
      if (source.lead && turn?.type === "turn" && turn.state === "completed") return false;
      if (turn?.type === "turn" && turn.state === "completed" && this.reportedDecision(source, turn)) return false;
      if (turn?.type !== "turn" || this.store.getSession(turn.sessionId)?.taskId !== source.id || (turn.state === "completed" && latest && latest.createdAt >= turn.startedAt && latest.state !== "returned")) return false;
    }
    return true;
  }

  private sameTarget(notice: Notice): boolean {
    if (!notice.targetSessionId) return !notice.targetTerm;
    const session = this.store.getSession(notice.targetSessionId), term = this.currentTerm?.(notice.targetTaskId);
    if (!session || session.taskId !== notice.targetTaskId || session.archivedAt || session.writer === "archived") return false;
    if (!term) return !notice.targetTerm && !session.botLeadTerm;
    return term.sessionId === session.id && term.termId === notice.targetTerm?.termId && term.generation === notice.targetTerm.generation;
  }

  private retarget(notice: Notice): boolean {
    if (!notice.targetSessionId || this.sameTarget(notice)) return false;
    const term = this.currentTerm?.(notice.targetTaskId);
    const row = this.store.getItem(notice.messageId ?? notice.id);
    if (row?.type === "user" && (row.delivery === undefined || row.delivery === "waiting")) {
      // Delivered transport history stays attached to its actual session. Handoff reads live business state.
      this.expireNotice(notice, "原主控会话已交接，保留已送达的历史记录。");
      return true;
    }
    const requiresTerm = !!(term || notice.targetTerm || notice.requiresTerm);
    const nextSession = requiresTerm && !term ? undefined : this.targetSession(notice.targetTaskId, { allowPaused: true });
    if (!term && !nextSession && !notice.targetTerm) return true;
    // A term change can make the old session ineligible before the new one is ready. Keep an unbound durable intent.
    const successor = nextSession?.id ?? term?.termId ?? "await-session";
    const text = requiresTerm ? this.currentBusiness(notice) : notice.text;
    this.store.transaction(() => {
      this.expireNotice(notice, RETARGET_REASON);
      if (text && (row?.type !== "user" || row.delivery !== "expired" || row.deliveryReason === RETARGET_REASON)) this.queue({ id: `${notice.id}-${successor}`, sourceTaskId: notice.sourceTaskId, targetTaskId: notice.targetTaskId, rootTaskId: notice.rootTaskId, direction: notice.direction, resultId: notice.resultId, decisionId: notice.decisionId, turnId: notice.turnId, ...(requiresTerm ? { requiresTerm } : {}), text, replacesNoticeId: notice.id, replacesItemId: row?.id });
    });
    if (text) queueMicrotask(() => this.deliver());
    return true;
  }

  private deliver(): void {
    for (const notice of this.notices()) {
      if (notice.expiredAt || notice.retiredAt) continue;
      if (this.sending.has(notice.id)) continue;
      const row = this.store.getItem(notice.messageId ?? notice.id);
      // Old Hosts wrote these exact system rows as unsent. Migrate through this same terminal-state service.
      const legacyExpired = !!row && this.f.sessions.inbox.expireLegacy(row);
      if (legacyExpired) { this.expireNotice(notice, "旧管理通知已作废，保留历史且不再重放。"); continue; }
      if (!this.valid(notice)) {
        this.expireNotice(notice, "任务归属、交付或问题状态已变化；原通知永久作废。");
        continue;
      }
      if (this.retarget(notice)) continue;
      if (row?.type === "user" && (row.delivery === "expired" || (row.delivery === "held" || row.delivery === "unsent") && !this.f.sharedContext.validateMessage(row.sessionId, row.id))) {
        const view = this.f.sharedContext.get(notice.targetTaskId);
        const tokens = [...row.text.matchAll(/^\[AMO_SHARED_CONTEXT:([^\]]+)\]\r?$/gm)].map((m) => m[1]);
        const historical = this.f.sharedContext.receipts(row.sessionId).find((r) => tokens.includes(r.requirementId));
        const root = managementRoot(this.store.listTasks(), notice.sourceTaskId)?.id;
        const replacement = view.validBinding && view.binding && !!historical && historical.rootTaskId === root && view.binding.rootTaskId === root && historical.requirementId !== view.binding.id;
        this.store.transaction(() => {
          this.expireNotice(notice, "共同需求绑定已升级或失效；旧通知终止，历史正文保持冻结。");
          if (replacement) this.queue({ ...notice, id: `${notice.id}-context-${view.binding!.id}`, sent: false, error: undefined, expiredAt: undefined, expiredReason: undefined, targetSessionId: undefined, targetTerm: undefined, messageId: undefined, replacesNoticeId: notice.id, replacesItemId: row.id });
        });
        if (replacement) queueMicrotask(() => this.deliver());
        continue;
      }
      if (notice.sent || notice.error) continue;
      if (notice.resultId && notice.direction === "up" && this.store.listSessions({ taskId: notice.sourceTaskId }).some(sessionMoving)) continue;
      this.sending.add(notice.id);
      void Promise.resolve().then(async () => {
        const saved = this.notices().find((n) => n.id === notice.id);
        if (!saved || !this.valid(saved) || saved.sent || !this.sameTarget(saved)) return;
        // Never create a new session just to wake a stopped/archived one. A resumed manager receives the pending notice.
        const term = this.currentTerm?.(notice.targetTaskId);
        if (saved.requiresTerm && !term) return;
        const target = this.targetSession(notice.targetTaskId);
        if (!target) return;
        const targetTerm = term ? { termId: term.termId, generation: term.generation } : undefined;
        const original = this.store.getItem(notice.id);
        const heldIds = new Set(this.f.sessions.inbox.held(target.id).map((item) => item.id));
        const heldBatch = notice.resultId && notice.direction === "up" ? this.notices().find((n) => n.resultId && n.direction === "up" && n.targetSessionId === target.id && this.valid(n) && this.sameTarget(n) && heldIds.has(n.messageId ?? n.id)) : undefined;
        let messageId = heldBatch ? heldBatch.messageId ?? heldBatch.id : notice.messageId ?? (original && original.sessionId !== target.id ? `${notice.id}-${target.id}` : notice.id);
        const batch = notice.resultId && notice.direction === "up"
          ? this.notices().filter((n) => (!n.sent || (heldBatch && n.targetSessionId === target.id && (n.messageId ?? n.id) === messageId)) && !n.error && n.resultId && n.direction === "up" && n.targetTaskId === notice.targetTaskId && (!n.requiresTerm || term) && this.valid(n) && this.sameTarget(n) && !this.store.listSessions({ taskId: n.sourceTaskId }).some(sessionMoving))
          : [notice];
        const text = batch.length > 1 ? `【下级交付汇总】${batch.length} 个任务提交了交付。请用 task_workflow({view:"pending"}) 读取待处理结果并逐项验收或退回；证据较长时，按下列 taskId/resultId 用 task_read_result 分页读取，不必重读 full。\n${batch.map((n) => `任务 ${n.sourceTaskId}，结果 ${n.resultId}`).join("\n")}` : notice.text;
        let replacesItemId = notice.replacesItemId;
        // Inbox rows are frozen. Expanding a held batch creates a linked replacement, never rewrites history.
        if (heldBatch && batch.some((n) => !n.sent)) {
          replacesItemId = messageId;
          this.f.sessions.inbox.expire(messageId, "更多下级交付已合入新的汇总通知。");
          messageId = `${notice.id}-batch`;
        }
        // Persist membership before the asynchronous send so concurrent delivery passes share one inbox row.
        const ids = new Set(batch.map((n) => n.id));
        this.saveNotices(this.notices().map((n) => ids.has(n.id) ? { ...n, targetSessionId: target.id, targetTerm, messageId, sent: true } : n));
        try {
          await this.f.sessions.inbox.put(target.id, text, undefined, messageId, { purpose: notice.direction === "up" ? "notification" : "work", ...(replacesItemId ? { replacesItemId } : {}) });
          const row = this.store.getItem(messageId);
          if (row?.type === "user" && row.delivery === "unsent") this.patchNotice(notice.id, { error: row.deliveryReason ?? "通知未送达，请进入目标任务的会话重新发送。" });
          else this.patchNotice(notice.id, { sent: true, error: undefined });
        } catch (error) { for (const n of batch) this.patchNotice(n.id, { error: String(error) }); }
        const current = this.notices().find((n) => n.id === notice.id);
        if (current?.error) this.changed(notice.targetTaskId);
      }).catch((error: unknown) => this.log(`managed delivery: ${String(error)}`)).finally(() => {
        this.sending.delete(notice.id);
        // A binding/ownership update can arrive while put waits for a cold runtime. Reconcile that change after
        // releasing the per-notice lock; unrelated failures and missing sessions never spin in a retry loop.
        const current = this.notices().find((n) => n.id === notice.id), row = current ? this.store.getItem(current.messageId ?? current.id) : undefined;
        if (current && !current.expiredAt && !current.retiredAt && (!this.valid(current) || !this.sameTarget(current) || row?.type === "user" && row.delivery === "expired")) queueMicrotask(() => this.deliver());
      });
    }
  }

  private expireNotice(notice: Notice, reason: string): void {
    // Save the producer terminal state before emitting the row event, which can re-enter reconciliation.
    const row = this.store.getItem(notice.messageId ?? notice.id);
    if (row?.type === "user" && (row.delivery === undefined || row.delivery === "waiting")) {
      // A later business-state change cannot rewrite successful transport history as expiration.
      this.patchNotice(notice.id, { retiredAt: new Date().toISOString(), sent: true, error: undefined });
      return;
    }
    this.patchNotice(notice.id, { expiredAt: new Date().toISOString(), expiredReason: reason, error: undefined });
    if (row?.type === "user" && this.f.sharedContext.validateMessage(row.sessionId, row.id) && this.notices().some((n) => n.id !== notice.id && n.targetSessionId === notice.targetSessionId && (n.messageId ?? n.id) === row.id && this.valid(n) && this.sameTarget(n))) return;
    this.f.sessions.inbox.expire(notice.messageId ?? notice.id, reason);
  }

  private patchNotice(id: Id, patch: Partial<Notice>): void { this.saveNotices(this.notices().map((n) => n.id === id ? { ...n, ...patch } : n)); }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000) throw new HostError("bad_request", `${label}不能为空，且不能超过 20000 字符。`);
  return value.trim();
}

function resultHeader(result: TaskResult): TaskResultHeader {
  const { summary, verification, review, userReview, contextMismatch, contextResolution, worktrees: _worktrees, ...metadata } = result;
  return { ...metadata, ...(userReview ? { userReview: { state: userReview.state, reviewedAt: userReview.reviewedAt } } : {}), hasContextMismatch: !!contextMismatch, hasContextResolution: !!contextResolution, textLengths: { summary: summary.length, verification: verification.length, review: review?.length ?? 0, userReview: userReview?.review.length ?? 0 } };
}

function summaryOffset(rootTaskId: Id, cursor: string | undefined, revision: string, length: number): number {
  if (cursor === undefined) return 0;
  const match = /^([A-Za-z0-9_-]{43})\.([1-9][0-9]{0,9})$/.exec(cursor);
  const offset = Number(match?.[2]);
  if (!match || match[1] !== revision || offset >= length) throw new HostError("conflict", "管理摘要分页已过期，请从此分支的第一页重新读取。", { reason: "stale-workflow-page", rootTaskId });
  return offset;
}

function noticeData(data: object): string {
  return `以下 JSON 记录来源和业务内容。管理权限由当前会话及任期决定。\n${JSON.stringify(data)}`;
}

function submissionNotice(title: string, result: TaskResult): string {
  const { taskId, id: resultId, sessionId, summary, verification, contextBasis, prerequisiteResultIds, contextMismatch } = result;
  return `【下级任务提交交付】\n${noticeData({ taskId, title, resultId, sessionId, summary, verification, contextBasis, prerequisiteResultIds, contextMismatch })}\n使用 task_review_result 验收或退回。用 task_workflow({view:"pending"}) 核对其他待办，验收直属任务后再提交汇总。`;
}

function returnNotice(result: TaskResult): string {
  return `【${result.managerTaskId ? "直属主控" : "用户"}退回交付】\n${noticeData({ resultId: result.id, taskId: result.taskId, managerTaskId: result.managerTaskId, review: result.review })}\n请用 task_workflow 核对当前归属与结论，修改和验证后重新 task_submit_result。${result.managerTaskId ? "" : "提交后等待用户审核。"}`;
}

function decisionNotice(decision: DecisionRequest): string {
  const { id: decisionId, taskId, sessionId, question, options, detail } = decision;
  return `【直属任务请求决定】\n${noticeData({ decisionId, taskId, sessionId, question, options, detail })}\n纯技术取舍可用 task_decision_answer 回答；需要用户明确的需求含义、业务规则或数值，用 decision_request 逐层提问。`;
}
