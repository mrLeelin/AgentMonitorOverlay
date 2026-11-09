import { managementRoot, taskManagement, type DecisionRequest, type Id, type Session, type Task, type TaskResult, type TaskWorkflow } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { HostError, sessionMoving } from "../../core/shared.js";
import { newId } from "../../store/store.js";

const RESULTS_KEY = "task-results:";
const OUTBOX_KEY = "orchestration.outbox";
type Notice = { id: Id; sourceTaskId: Id; targetTaskId: Id; text: string; targetSessionId?: Id; messageId?: Id; sent?: boolean; error?: string; decisionId?: Id; resultId?: Id; turnId?: Id; direction: "up" | "down" };

/** The management tree runs work; the inbox remains the sole automatic conversation delivery path. */
export class OrchestrationFeature extends Feature<"tasks" | "sessions" | "collab" | "sharedContext"> {
  private readonly sending = new Set<Id>();

  workflow(taskId: Id): TaskWorkflow {
    this.requireTask(taskId);
    const tasks = this.store.listTasks();
    const ids = new Set([taskId, ...taskManagement(tasks, taskId).descendants.map((t) => t.id)]);
    return {
      rootTaskId: managementRoot(tasks, taskId)?.id ?? null,
      results: [...ids].flatMap((id) => this.results(id)).filter((r) => !this.store.getTask(r.taskId)?.archivedAt),
      decisions: this.store.listDecisions({ state: "open" }).filter((d) => d.routedToTaskId === taskId),
      deliveryIssues: this.notices().filter((n) => ids.has(n.sourceTaskId) || ids.has(n.targetTaskId)).flatMap((n) => {
        if (!this.valid(n)) return [];
        const row = this.store.getItem(n.messageId ?? n.id);
        const unsent = row?.type === "user" && row.delivery === "unsent";
        return unsent || (!row && n.error) ? [{ id: n.id, taskId: n.targetTaskId, detail: n.error || "通知未送达，请进入目标任务的会话重新发送。" }] : [];
      }),
    };
  }

  results(taskId: Id): TaskResult[] { return JSON.parse(this.store.getKv(RESULTS_KEY + taskId)?.value ?? "[]") as TaskResult[]; }
  private saveResults(taskId: Id, results: TaskResult[]): void { this.store.setKv(RESULTS_KEY + taskId, JSON.stringify(results)); }
  private notices(): Notice[] { return JSON.parse(this.store.getKv(OUTBOX_KEY)?.value ?? "[]") as Notice[]; }
  private saveNotices(notices: Notice[]): void { this.store.setKv(OUTBOX_KEY, JSON.stringify(notices)); }

  private own(sessionId: Id): { session: Session; task: Task } {
    const session = this.requireSession(sessionId);
    const task = session.taskId ? this.requireTask(session.taskId) : null;
    if (!task || task.archivedAt || task.remote || session.archivedAt || session.kind === "sub" || session.writer === "archived" || !managementRoot(this.store.listTasks(), task.id)) throw new HostError("bad_request", "此操作需要有效管理树中的本地任务会话。");
    if (task.topicId) this.requireLiveTopic(task.topicId);
    return { session, task };
  }

  private ready(task: Task): void {
    const children = this.store.listTasks().filter((t) => t.managerTaskId === task.id && !t.archivedAt);
    const unfinished = children.filter((t) => {
      const result = this.results(t.id).at(-1);
      return t.column !== "done" || result?.state !== "accepted" || result.managerTaskId !== task.id || !this.f.sharedContext.isResultCurrent(t.id, result);
    });
    if (unfinished.length) throw new HostError("conflict", `请先验收直属任务：${unfinished.map((t) => t.title || t.id).join("、")}`);
    const ids = new Set([task.id, ...taskManagement(this.store.listTasks(), task.id).descendants.map((t) => t.id)]);
    if (this.store.listDecisions({ state: "open" }).some((d) => d.taskId && ids.has(d.taskId))) throw new HostError("conflict", "本任务或下辖还有未处理的业务问题，请先解决再交付。");
  }

  private assertReviewSettled(taskId: Id, callerSessionId: Id, selfRoot: boolean): void {
    // The root resolves its own pending final delivery from a tool in the current turn.
    // Other sessions of that root, and every session of a reviewed child, must still be settled.
    if (this.store.listSessions({ taskId }).some((s) => !(selfRoot && s.id === callerSessionId) && sessionMoving(s))) throw new HostError("conflict", "执行任务仍在工作，请等本轮结束后再验收。");
  }

  submit(sessionId: Id, summaryIn: unknown, verificationIn: unknown, input?: Pick<TaskResult, "contextBasis" | "prerequisiteResultIds">): TaskResult {
    const { task } = this.own(sessionId);
    const summary = requiredText(summaryIn, "交付摘要"), verification = requiredText(verificationIn, "验证证据");
    this.ready(task);
    const basis = this.f.sharedContext.captureBasis(sessionId, input);
    const results = this.results(task.id);
    const previous = results.at(-1);
    if (previous && (previous.state === "submitted" || (previous.state === "accepted" && task.column === "done")) && previous.summary === summary && previous.verification === verification && previous.managerTaskId === (task.managerTaskId ?? null) && JSON.stringify(previous.contextBasis) === JSON.stringify(basis.contextBasis) && JSON.stringify(previous.prerequisiteResultIds) === JSON.stringify(basis.prerequisiteResultIds)) return previous;
    if (previous?.state === "submitted") throw new HostError("conflict", "交付已提交，等待直属主控验收；需修改时由主控先退回。");
    const at = new Date().toISOString();
    const result: TaskResult = { id: newId("result"), taskId: task.id, sessionId, managerTaskId: task.managerTaskId ?? null, summary, verification, ...basis, state: task.managerTaskId || basis.contextMismatch ? "submitted" : "accepted", createdAt: at, updatedAt: at };
    this.store.transaction(() => {
      if (result.state === "accepted") this.f.sharedContext.assertAcceptable(task.id, result);
      this.saveResults(task.id, [...results, result]);
      if (task.managerTaskId) this.queue({ id: `i-${result.id}-submit`, sourceTaskId: task.id, targetTaskId: task.managerTaskId, direction: "up", resultId: result.id, text: `【下级任务提交交付】「${task.title}」（${task.id}）\n结果 ${result.id}\n${summary}\n\n验证：${verification}${result.contextBasis ? `\n需求依据：${result.contextBasis.contextId} v${result.contextBasis.version}` : ""}${result.prerequisiteResultIds?.length ? `\n前置结果：${result.prerequisiteResultIds.join("、")}` : ""}${result.contextMismatch ? `\n待处理差异：${result.contextMismatch}` : ""}\n\n请先用 task_workflow 读取最新结果，再用 task_review_result 验收或退回。提交不代表已完成；直属任务全部验收后再提交你自己的汇总。` });
    });
    this.f.tasks.updateTask(task.id, { column: result.state === "submitted" ? "review" : "done" });
    this.changed(task.id);
    this.deliver();
    return result;
  }

  review(sessionId: Id, resultId: Id, accept: boolean, reviewIn: unknown, contextExplanation?: string): TaskResult {
    const { task: manager } = this.own(sessionId);
    if (!manager.lead) throw new HostError("bad_request", "只有直属主控能够验收交付。");
    const review = requiredText(reviewIn, "验收结论或退回原因");
    const child = this.store.listTasks().find((t) => (t.managerTaskId === manager.id || (t.id === manager.id && !manager.managerTaskId)) && !t.archivedAt && this.results(t.id).some((r) => r.id === resultId));
    if (!child) throw new HostError("bad_request", "结果不属于你的有效直属任务，归属可能已变更。");
    const results = this.results(child.id), latest = results.at(-1)!;
    const expectedManager = child.id === manager.id ? null : manager.id;
    if (latest.id !== resultId || latest.managerTaskId !== expectedManager) throw new HostError("conflict", "只能验收最新且仍归你管理的交付。");
    const state = accept ? "accepted" : "returned";
    if (latest.state === state && latest.review === review) return latest;
    if (latest.state !== "submitted") throw new HostError("conflict", "此交付已经处理，请读取最新状态。");
    const selfRoot = child.id === manager.id && expectedManager === null;
    if (accept) {
      this.assertReviewSettled(child.id, sessionId, selfRoot);
      this.ready(child);
    }
    const next = this.store.transaction(() => {
      // Acceptance is based on the requirement and ownership read inside the write transaction.
      const current = this.requireTask(child.id), currentManager = this.requireTask(manager.id), currentResults = this.results(child.id), currentLatest = currentResults.at(-1);
      if (current.archivedAt || (current.managerTaskId ?? null) !== expectedManager || !currentManager.lead || !managementRoot(this.store.listTasks(), current.id) || currentLatest?.id !== resultId || currentLatest.state !== "submitted" || currentLatest.managerTaskId !== expectedManager) throw new HostError("conflict", "交付或任务归属已变化，请重新读取后验收。");
      if (accept) { this.assertReviewSettled(current.id, sessionId, selfRoot); this.ready(current); }
      const contextResolution = accept ? this.f.sharedContext.assertAcceptable(current.id, currentLatest, contextExplanation) : undefined;
      const next: TaskResult = { ...currentLatest, state, review, ...(contextResolution ? { contextResolution } : {}), updatedAt: new Date().toISOString() };
      this.saveResults(child.id, [...currentResults.slice(0, -1), next]);
      if (!accept) this.queue({ id: `i-${next.id}-return`, sourceTaskId: manager.id, targetTaskId: child.id, direction: "down", resultId, text: `【直属主控退回交付】结果 ${resultId}\n${review}\n\n请读取 task_workflow 确认当前归属与最新结论，修改和验证后重新 task_submit_result。` });
      return next;
    });
    this.f.tasks.updateTask(child.id, { column: accept ? "done" : "doing" });
    this.changed(child.id);
    this.deliver();
    return next;
  }

  answerDecision(sessionId: Id, decisionId: Id, answer: unknown): DecisionRequest {
    const { task } = this.own(sessionId);
    const decision = this.store.getDecision(decisionId);
    const source = decision?.taskId ? this.store.getTask(decision.taskId) : undefined;
    if (!task.lead || !decision || decision.routedToTaskId !== task.id || source?.managerTaskId !== task.id || !managementRoot(this.store.listTasks(), source.id)) throw new HostError("bad_request", "此问题不属于你当前管理的直属任务。");
    return this.f.collab.answerDecision(decisionId, requiredText(answer, "决定"));
  }

  watch(): void {
    this.host.on("event", (event) => {
      if (event.type === "decision.upserted" && event.decision.state === "open" && event.decision.routedToTaskId) this.routeDecision(event.decision);
      if (event.type === "task.upserted") {
        this.reconcileDecisions();
        const results = this.results(event.task.id), latest = results.at(-1);
        if (latest?.managerTaskId && latest.managerTaskId !== event.task.managerTaskId && latest.state !== "returned") {
          this.saveResults(event.task.id, [...results.slice(0, -1), { ...latest, state: "returned", review: "直属主控已变更，请向新主控重新提交交付。", updatedAt: new Date().toISOString() }]);
        } else if (latest?.state === "accepted" && event.task.column !== "done" && !event.task.archivedAt) {
          this.saveResults(event.task.id, [...results.slice(0, -1), { ...latest, state: "returned", review: "交付后任务重新开始，须重新提交验证和验收。", updatedAt: new Date().toISOString() }]);
          if (event.task.managerTaskId) {
            this.queue({ id: `i-${latest.id}-reopened`, sourceTaskId: event.task.id, targetTaskId: event.task.managerTaskId, direction: "up", text: `【下级任务重新开始】「${event.task.title}」之前的验收已失效，请等待最新交付并重新验收。` });
            const manager = this.store.getTask(event.task.managerTaskId);
            if (manager?.column === "done" && !manager.archivedAt) this.f.tasks.updateTask(manager.id, { column: "doing" });
          }
        }
        this.deliver();
      }
      if (event.type === "session.upserted") { this.reportTurn(event.session); this.deliver(); }
    });
    // Only explicit pending work resumes; installation never replays historical session completions.
    this.reconcileDecisions();
    this.deliver();
  }

  private routeDecision(decision: DecisionRequest): void {
    if (!decision.taskId || !decision.routedToTaskId) return;
    this.queue({ id: `i-${decision.id}-${decision.routedToTaskId}`, sourceTaskId: decision.taskId, targetTaskId: decision.routedToTaskId, direction: "up", decisionId: decision.id, text: `【直属任务请求决定】${decision.question}\n${decision.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n问题 ${decision.id}\n\n用 task_workflow 查看最新待决问题，用 task_decision_answer 回答。你解决不了时，用 decision_request 向你的直属主控提出问题；只有总主控向人提出业务问题。` });
    this.deliver();
  }

  private reconcileDecisions(): void {
    for (const decision of this.store.listDecisions({ state: "open" })) {
      if (!decision.routedToTaskId) continue;
      const source = decision.taskId ? this.store.getTask(decision.taskId) : undefined;
      const target = source && managementRoot(this.store.listTasks(), source.id) ? source.managerTaskId ?? null : null;
      if (target !== decision.routedToTaskId) {
        const next = { ...decision, routedToTaskId: target };
        this.store.putDecision(next);
        this.publish({ type: "decision.upserted", decision: next });
      } else this.routeDecision(decision);
    }
  }

  private reportTurn(session: Session): void {
    if (!session.taskId || session.kind !== "main" || session.archivedAt || session.runtime === "remote" || !["idle", "completed", "error", "interrupted"].includes(session.status)) return;
    const task = this.store.getTask(session.taskId);
    if (!task?.managerTaskId || !managementRoot(this.store.listTasks(), task.id)) return;
    const [turn] = this.store.findItems(session.id, "turn", {}, { newest: true, limit: 1 });
    if (turn?.type !== "turn" || turn.state === "running") return;
    const latest = this.results(task.id).at(-1);
    if (latest && latest.createdAt >= turn.startedAt && latest.state === "submitted") return;
    const [last] = this.store.findItems(session.id, "agent", {}, { newest: true, limit: 1 });
    const reply = last?.type === "agent" && last.createdAt >= turn.startedAt ? last.markdown.slice(0, 6000) : "（暂无文字结果）";
    this.queue({ id: `i-${turn.id}-manager`, sourceTaskId: task.id, targetTaskId: task.managerTaskId, direction: "up", turnId: turn.id, text: `【下级任务本轮状态】「${task.title}」（${task.id}）：${turn.state}\n${turn.state === "failed" ? turn.error ?? "运行失败" : reply}\n\n这只是本轮回复，不等于任务验收完成。先用 task_workflow 查看交付与待决问题，必要时 task_message 继续派工。` });
  }

  private changed(taskId: Id): void { this.publish({ type: "task.upserted", task: this.requireTask(taskId) }); }
  private queue(notice: Notice): void {
    const notices = this.notices();
    if (notices.some((n) => n.id === notice.id)) return;
    this.saveNotices([...notices, notice]);
  }

  private valid(notice: Notice): boolean {
    const source = this.store.getTask(notice.sourceTaskId), target = this.store.getTask(notice.targetTaskId);
    if (!source || !target || source.archivedAt || target.archivedAt || !managementRoot(this.store.listTasks(), source.id)) return false;
    if (notice.direction === "up" ? source.managerTaskId !== target.id : target.managerTaskId !== source.id) return false;
    if (notice.decisionId) { const d = this.store.getDecision(notice.decisionId); if (d?.state !== "open" || d.routedToTaskId !== target.id) return false; }
    if (notice.resultId) {
      const r = this.results(notice.direction === "up" ? source.id : target.id).at(-1);
      if (r?.id !== notice.resultId || r.state !== (notice.direction === "up" ? "submitted" : "returned")) return false;
    }
    if (notice.turnId) {
      const turn = this.store.getItem(notice.turnId), latest = this.results(source.id).at(-1);
      if (turn?.type !== "turn" || (turn.state === "completed" && latest && latest.createdAt >= turn.startedAt && latest.state !== "returned")) return false;
    }
    return true;
  }

  private deliver(): void {
    for (const notice of this.notices()) {
      if (this.sending.has(notice.id)) continue;
      if (!this.valid(notice)) {
        if (notice.targetSessionId) {
          const row = this.store.getItem(notice.messageId ?? notice.id);
          if (row?.type === "user" && row.delivery === "held") this.publish({ type: "item.updated", item: this.store.replaceItem({ ...row, delivery: "unsent", text: "【管理通知已失效】任务归属或问题状态已变化，请以 task_workflow 最新内容为准。" }) });
        }
        continue;
      }
      const previous = notice.targetSessionId ? this.store.getSession(notice.targetSessionId) : undefined;
      if (notice.targetSessionId && (!previous || previous.archivedAt || previous.writer === "archived")) {
        const row = this.store.getItem(notice.messageId ?? notice.id);
        // A notice already consumed by the model must never replay in another conversation.
        if (row?.type === "user" && row.delivery !== "held" && row.delivery !== "unsent") continue;
        if (row?.type === "user" && row.delivery === "held") this.publish({ type: "item.updated", item: this.store.replaceItem({ ...row, delivery: "unsent", text: "【管理通知已转交新会话】旧会话已归档，以任务当前主会话中的通知为准。" }) });
        Object.assign(notice, { sent: false, error: undefined, targetSessionId: undefined, messageId: undefined });
        this.patchNotice(notice.id, notice);
      }
      if (notice.sent || notice.error) continue;
      if (notice.resultId && notice.direction === "up" && this.store.listSessions({ taskId: notice.sourceTaskId }).some(sessionMoving)) continue;
      this.sending.add(notice.id);
      void Promise.resolve().then(async () => {
        if (!this.valid(notice)) return;
        // Never create a new session just to wake a stopped/archived one. A resumed manager receives the pending notice.
        const target = this.store.listSessions({ taskId: notice.targetTaskId }).filter((s) => s.kind === "main" && !s.archivedAt && s.runtime !== "remote" && s.writer !== "archived" && s.writer !== "terminal-handoff").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!target) return;
        const original = this.store.getItem(notice.id);
        const messageId = notice.messageId ?? (original && original.sessionId !== target.id ? `${notice.id}-${target.id}` : notice.id);
        this.patchNotice(notice.id, { targetSessionId: target.id, messageId });
        try {
          await this.f.sessions.inbox.put(target.id, notice.text, undefined, messageId);
          const row = this.store.getItem(messageId);
          if (row?.type === "user" && row.delivery === "unsent") this.patchNotice(notice.id, { error: "通知未送达，请进入目标任务的会话重新发送。" });
          else this.patchNotice(notice.id, { sent: true, error: undefined });
        } catch (error) { this.patchNotice(notice.id, { error: String(error) }); }
        const current = this.notices().find((n) => n.id === notice.id);
        if (current?.error) this.changed(notice.targetTaskId);
      }).catch((error: unknown) => this.log(`managed delivery: ${String(error)}`)).finally(() => this.sending.delete(notice.id));
    }
  }

  private patchNotice(id: Id, patch: Partial<Notice>): void { this.saveNotices(this.notices().map((n) => n.id === id ? { ...n, ...patch } : n)); }
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 20_000) throw new HostError("bad_request", `${label}不能为空，且不能超过 20000 字符。`);
  return value.trim();
}
