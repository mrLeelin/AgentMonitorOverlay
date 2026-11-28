import { RELAY_TEXT_MAX, type Id, type Relay, type Session, type SessionItem, type Task } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError, sessionMoving } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { managesTask, roleFacts } from "../../core/role.js";

/** How long a decided relay stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;
const RELAY_ITEM_PREFIX = "i-relay-";

type PrerequisiteRestart = { bindingId: Id; previousSessionId: Id; previous: Id[]; next: Id[]; opening?: true; needsCheck?: true };
type StoredRelay = Relay & { prerequisiteRestart?: PrerequisiteRestart };
type Delivery = { sessionId: Id; held: boolean };
const sameIds = (a: readonly Id[], b: readonly Id[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * 传话 (stage 16, from the stage 15 design): a 主控 (or a topic's own session) asks Studio to say something in another
 * managed task's session automatically. Topic sessions retain the confirmation workflow. Dispatch and receipts
 * use stable inbox ids so a restart cannot duplicate a delivered message. Successful receipts stay in mail;
 * only actionable failures/refusals enter the lead's model inbox.
 */
export class RelaysFeature extends Feature<"collab" | "sessions" | "sharedContext" | "taskPlans" | "tasks"> {
  private readonly delivering = new Map<Id, Promise<Relay>>();
  private readonly recovering = new Set<Id>();
  private readonly awaitingCheck = new Set<Id>();

  /** Classify interrupted reopens and retire old success-only wakeups before inbox recovery. */
  prepareInbox(): void {
    const relays: StoredRelay[] = this.store.listRelays();
    for (const relay of relays) {
      if (relay.prerequisiteRestart && relay.sessionId) {
        if (relay.prerequisiteRestart.needsCheck) this.awaitingCheck.add(relay.sessionId);
        else if (relay.state === "pending" || relay.state === "delivered") this.prepareRestartRecovery(relay, relay.sessionId, relay.prerequisiteRestart);
      }
      if (relay.state !== "delivered" || !relay.fromTaskId) continue;
      const receiptId = `i-relay-receipt-${relay.id}`;
      for (const item of [...this.store.findItems(relay.fromSessionId, "user", { delivery: "held" }), ...this.store.findItems(relay.fromSessionId, "user", { delivery: "unsent" })]) {
        if (item.type === "user" && !item.relayFromSessionId && (item.id === receiptId || item.id.startsWith(`${receiptId}-context-`))) this.f.sessions.inbox.expire(item.id, "传话成功回执仅供查看，不再自动唤醒主控；实际答复仍会另行通知。");
      }
    }
  }

  private prepareRestartRecovery(relay: StoredRelay, sessionId: Id, restart: PrerequisiteRestart): void {
    const messageId = RELAY_ITEM_PREFIX + relay.id;
    const row = this.store.getItem(messageId);
    if (row?.type === "user" && (row.delivery === "expired" || (relay.state === "delivered" && row.delivery === undefined))) return;
    const session = this.store.getSession(sessionId);
    // put persists a user row before any first-turn RPC. An empty session can safely get a new native thread.
    if (!row && relay.state === "pending" && session?.runtime === "codex" && this.isEmptyReplacement(session)) {
      this.recovering.add(sessionId);
      return;
    }
    if (!row && relay.state === "pending" && session?.runtime !== "codex") return;
    const error = "Host 中断后无法确认重开首轮是否已发送。请打开传话回执关联的会话核对首轮及工作结果，确认需要继续后从原任务开启新会话。";
    this.awaitingCheck.add(sessionId);
    this.host.transaction(() => {
      this.f.sessions.inbox.expire(messageId, error);
      this.save({ ...relay, prerequisiteRestart: { ...restart, needsCheck: true }, state: "failed", decidedAt: new Date().toISOString(), error });
      if (this.store.getSession(relay.fromSessionId)) {
        this.f.collab.sendMail(null, { kind: "session", sessionId: relay.fromSessionId },
          `【重开首轮待核对】${error}\n传话 ${relay.id}\n任务 ${relay.toTaskId}\n会话 ${sessionId}`);
      }
    });
  }

  canAutoDispatch(sessionId: Id): boolean { return !this.recovering.has(sessionId) && !this.awaitingCheck.has(sessionId); }

  assertSessionReady(sessionId: Id): void {
    if (this.recovering.has(sessionId)) throw new HostError("conflict", "这次前置换版重开正在恢复空会话，请等待传话回执。");
  }

  private isEmptyReplacement(session: Session): boolean {
    return !!session.runtimeRef && !session.archivedAt && session.status === "idle" && session.writer === "workbench" && !sessionMoving(session) &&
      !this.store.findItems(session.id, "user", {}, { limit: 1 }).length && !this.store.findItems(session.id, "turn", {}, { limit: 1 }).length &&
      !this.store.findItems(session.id, "background", { state: "running" }, { limit: 1 }).length;
  }

  /** Resume owned dispatches that were persisted before a Host interruption. */
  watch(): void {
    for (const relay of this.store.listRelays()) {
      if (relay.state === "pending" && relay.fromTaskId && this.store.getTask(relay.fromTaskId)?.lead) void this.deliver(relay.id).catch(() => undefined);
    }
  }

  list(): Relay[] {
    const since = Date.now() - DECIDED_SHOWN_MS;
    return this.store.listRelays().filter((r) => r.state === "pending" || Date.parse(r.decidedAt ?? r.createdAt) > since);
  }

  private requireRelay(id: Id): StoredRelay {
    const relay = this.store.getRelay(id);
    if (!relay) throw new HostError("not_found", `relay ${id} not found`);
    return relay;
  }

  private save(relay: StoredRelay): Relay {
    this.store.putRelay(relay);
    this.publish({ type: "relay.upserted", relay });
    return relay;
  }

  /** An authorised lead dispatches directly; topic-only coordination still waits for confirmation. */
  send(fromSessionId: Id, input: { taskId?: unknown; text?: unknown; purpose?: unknown }): Relay {
    const facts = roleFacts(this.host, fromSessionId);
    if (facts.role !== "lead" && facts.role !== "topic") throw new HostError("bad_request", "只有主控（或专题会话）能传话：要找别的任务，用 mailbox_send 留言。");
    const target = this.store.getTask(String(input.taskId ?? ""));
    if (!target || target.archivedAt) throw new HostError("bad_request", `task ${String(input.taskId)} not found`);
    if (target.id === facts.task?.id) throw new HostError("bad_request", "传话是给别的任务的");
    // A task of the topic, or one its canvas shows as a reference card (2026-10-17).
    if (!managesTask(this.host, fromSessionId, target.id)) throw new HostError("bad_request", `任务 ${target.id} 不在你的管理范围；平级协作请用 mailbox_send。`);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new HostError("bad_request", "text is required");
    if (text.length > RELAY_TEXT_MAX) throw new HostError("bad_request", `text is limited to ${RELAY_TEXT_MAX} characters`);
    const purpose = input.purpose ?? "work";
    if (purpose !== "inquiry" && purpose !== "work" && purpose !== "reopen") throw new HostError("bad_request", "purpose must be inquiry, work or reopen");
    // Work that would start the task, or reopen it, waits for its prerequisites (2026-11-17, plans/done/task-dependencies.md).
    this.f.taskPlans.checkDispatch(target.id, purpose);
    const restart = purpose === "reopen" ? this.boundRestart(fromSessionId, target, text) : undefined;
    if (restart && "id" in restart) return restart;
    const relay = this.save({ id: newId("relay"), fromSessionId, fromTaskId: facts.task?.id ?? null, toTaskId: target.id, text, purpose, state: "pending", createdAt: new Date().toISOString(), decidedAt: null,
      ...(restart ? { prerequisiteRestart: restart } : {}),
    });
    if (facts.role === "lead" || target.relayAuto) void Promise.resolve().then(() => this.deliver(relay.id)).catch(() => undefined);
    return relay;
  }

  private boundRestart(fromSessionId: Id, target: Task, text: string): StoredRelay | PrerequisiteRestart | undefined {
    const previous = this.f.sharedContext.prerequisites(target.id);
    const binding = this.f.sharedContext.binding(target.id);
    if (!binding || !previous.length) return undefined;
    const next = this.f.sharedContext.startPrerequisites(target.id)!;
    const retries: StoredRelay[] = this.store.listRelays();
    const retry = retries.find((r) => r.fromSessionId === fromSessionId && r.toTaskId === target.id && r.text === text &&
      (r.state === "pending" || r.sessionId && r.state !== "expired") && r.prerequisiteRestart?.bindingId === binding.id && sameIds(r.prerequisiteRestart.next, next));
    if (retry) {
      this.assertDirectManager(fromSessionId, target.id);
      return retry;
    }
    if (retries.some((r) => r.toTaskId === target.id && r.state === "pending" && r.prerequisiteRestart)) throw new HostError("conflict", "该任务正在处理前置换版重开，请等待当前传话回执。");
    if (previous.every((id) => next.includes(id))) return undefined;
    this.assertDirectManager(fromSessionId, target.id);
    if (this.f.tasks.hasStartingSession(target.id)) throw new HostError("conflict", "任务已有会话正在启动，请等其安定后再重开。");
    const previousSession = this.liveSessions(target.id).filter((s) => s.kind === "main" && !s.parentId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!previousSession) return undefined; // With no active conversation the normal first-start path already freezes the current basis.
    this.assertSettled(target.id, previousSession);
    return { bindingId: binding.id, previousSessionId: previousSession.id, previous, next };
  }

  private assertDirectManager(sessionId: Id, taskId: Id): Task {
    const target = this.requireTask(taskId);
    const actor = this.store.getSession(sessionId);
    if (!actor || roleFacts(this.host, sessionId).role !== "lead" || !actor.taskId || target.managerTaskId !== actor.taskId || !managesTask(this.host, sessionId, taskId)) {
      throw new HostError("read_only", "只有当前直属主控可以按换版后的前置重新开始这个任务。");
    }
    return target;
  }

  private liveSessions(taskId: Id): Session[] {
    return this.store.listSessions({ taskId }).filter((s) => !s.archivedAt && s.writer !== "archived");
  }

  private assertSettled(taskId: Id, previous: Session, replacementId?: Id): Session[] {
    const sessions = this.liveSessions(taskId).filter((s) => s.id !== replacementId);
    if (this.f.sessions.inbox.isPaused(previous.id) || sessions.some((s) => sessionMoving(s) || this.runtime.hasPendingDispatch?.(s.id) ||
      this.store.findItems(s.id, "background", { state: "running" }).length)) {
      throw new HostError("conflict", "任务仍在运行、交接或已暂停收件，请等原会话安定、恢复收件后再重开。");
    }
    return sessions;
  }

  private assertRestartBasis(relay: StoredRelay, basis: PrerequisiteRestart, installed: boolean): Task {
    const task = this.assertDirectManager(relay.fromSessionId, relay.toTaskId);
    this.f.taskPlans.checkDispatch(task.id, "reopen");
    const context = this.f.sharedContext;
    const required = installed ? basis.next : basis.previous;
    if (context.binding(task.id)?.id !== basis.bindingId || !sameIds(context.prerequisites(task.id), required) ||
      !sameIds(context.startPrerequisites(task.id) ?? [], basis.next)) {
      throw new HostError("conflict", "前置交付或共同需求已变化，请核对当前依据后重新派工。");
    }
    return task;
  }

  private async restartSession(relay: StoredRelay, basis: PrerequisiteRestart, deliver: (session: Session) => Promise<Delivery>): Promise<Delivery> {
    if (relay.sessionId) {
      this.assertRestartBasis(relay, basis, true);
      const session = this.requireSession(relay.sessionId);
      if (!this.recovering.has(session.id)) return deliver(session);
      if (this.f.tasks.hasStartingSession(relay.toTaskId)) throw new HostError("conflict", "任务已有会话正在启动，请等其安定后再重开。");
      const check = () => {
        const task = this.assertRestartBasis(relay, basis, true);
        const current = this.requireSession(session.id);
        if (this.requireRelay(relay.id).state !== "pending" || current.runtimeRef !== session.runtimeRef || current.profileId !== session.profileId ||
            current.workspaceId !== task.workspaceId || !this.isEmptyReplacement(current) || this.f.sessions.inbox.isPaused(current.id) ||
            this.runtime.hasPendingDispatch?.(current.id) || this.liveSessions(task.id).some((entry) => entry.id !== current.id && entry.kind === "main")) {
          throw new HostError("conflict", "恢复前会话已变化，请核对回执关联会话后继续。");
        }
      };
      return this.f.tasks.startRelayReplacement(session, check, (replacement) => {
        this.recovering.delete(replacement.id);
        return deliver(replacement);
      }, session.id);
    }
    if (basis.opening) throw new HostError("conflict", "上一次重开在会话创建期间中断，请核对任务会话后重新派工。");
    if (this.f.tasks.hasStartingSession(relay.toTaskId)) throw new HostError("conflict", "任务已有会话正在启动，请等其安定后再重开。");
    const previous = this.requireSession(basis.previousSessionId);
    const check = (replacementId?: Id) => {
      const task = this.assertRestartBasis(relay, basis, false);
      if (this.requireRelay(relay.id).state !== "pending") throw new HostError("conflict", "这次重开已撤销。");
      const sessions = this.assertSettled(task.id, previous, replacementId);
      if (!sessions.some((s) => s.id === previous.id) || task.workspaceId !== previous.workspaceId || previous.runtime === "remote" || previous.botLeadTerm) {
        throw new HostError("conflict", "原执行会话或任务工作区已变更，请核对后重新派工。");
      }
      return sessions;
    };
    check();
    this.save({ ...relay, prerequisiteRestart: { ...basis, opening: true } });
    return this.f.tasks.startRelayReplacement(previous, check, async (session) => {
      let archived: Session[];
      try {
        archived = this.host.transaction(() => {
          const old = check(session.id).filter((s) => !s.parentId).flatMap((s) => this.store.archiveSubtree(s.id));
          for (const entry of old) {
            this.f.sharedContext.recordReplacedSession(entry.id, basis.previous);
            this.publish({ type: "session.upserted", session: entry });
          }
          this.f.sharedContext.setPrerequisites(relay.toTaskId, basis.next);
          this.save({ ...relay, sessionId: session.id });
          return old;
        });
      } catch (error) {
        // This empty session never acquired the new basis or accepted work.
        void this.f.sessions.archive(session.id).catch((cause: unknown) => this.log(`replacement archive: ${String(cause)}`));
        throw error;
      }
      void this.runtime.finishArchive?.(archived).catch((error: unknown) => this.log(`replacement archive: ${String(error)}`));
      return deliver(session);
    });
  }

  validateMessage(item: SessionItem): void {
    if (item.type !== "user" || !item.relayFromSessionId || !item.id.startsWith(RELAY_ITEM_PREFIX)) return;
    const relay: StoredRelay | undefined = this.store.getRelay(item.id.slice(RELAY_ITEM_PREFIX.length));
    if (!relay?.prerequisiteRestart || relay.sessionId !== item.sessionId) return;
    if (relay.prerequisiteRestart.needsCheck) throw new HostError("conflict", relay.error || "请先核对重开首轮是否已送达。");
    try {
      this.assertRestartBasis(relay, relay.prerequisiteRestart, true);
    } catch (error) {
      this.f.sessions.inbox.expire(item.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** The person said yes (or the task takes relays): into the task's session. */
  deliver(id: Id): Promise<Relay> {
    const existing = this.delivering.get(id);
    if (existing) return existing;
    const pending = this.deliverOnce(id).finally(() => this.delivering.delete(id));
    this.delivering.set(id, pending);
    return pending;
  }

  private async deliverOnce(id: Id): Promise<Relay> {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending") throw new HostError("conflict", "this relay was decided already");
    const target = this.store.getTask(relay.toTaskId);
    const from = this.store.getSession(relay.fromSessionId);
    const lead = relay.fromTaskId ? this.store.getTask(relay.fromTaskId) : undefined;
    // 2026-11-17 (the Free 主控): a 主控's 传话 no longer points to mailbox_send. Its 13 mails went unread, as mail wakes
    // no one, while the child slept and read its mailbox over and over for a reply.
    const message = [
      `【主控「${lead?.title || "主控"}」传话】`,
      relay.text,
      "",
      relay.purpose === "inquiry" ? "（这是主控通过 AMO Studio 发来的只读询问：仅回答问题，不继续实施、不重新提交交付，也不撤销已有验收。）"
        : relay.fromTaskId ? "（这是主控通过 AMO Studio 传来的。完成工作后用 task_submit_result 提交成果，由直属主控验收；要主控拍板的事用 decision_request。主控之后的指示和答复可能直接插进你正在做的这一轮，读到就按最新的做。日常进展写在本轮回复里，本轮结束会自动报给主控；等答复时结束本轮，答复会自动送回来，不要 sleep 或反复读信箱。）"
        : `（这是主控通过 AMO Studio 传来的。完成工作后用 task_submit_result 提交成果，由直属主控验收；日常补充用 mailbox_send 给会话 ${relay.fromSessionId}。）`,
    ].join("\n");
    try {
      if (!target || target.archivedAt) throw new HostError("bad_request", "the task is gone or archived");
      if (!managesTask(this.host, relay.fromSessionId, target.id)) throw new HostError("bad_request", "任务归属已变更，原主控不再管理此任务。");
      const messageId = RELAY_ITEM_PREFIX + relay.id;
      const deliver = async (session: Session): Promise<Delivery> => {
        if (!managesTask(this.host, relay.fromSessionId, target.id)) throw new HostError("bad_request", "任务归属已变更，原主控不再管理此任务。");
        const held = !(await this.f.sessions.inbox.put(session.id, message, relay.fromSessionId, messageId, { purpose: relay.purpose ?? "work" })).delivered;
        return { sessionId: session.id, held };
      };
      // A dependency may be creating its session while no row exists yet; distinct relays also share that start.
      const { sessionId, held } = relay.prerequisiteRestart
        ? await this.restartSession(relay, relay.prerequisiteRestart, deliver)
        : await deliver(await this.f.tasks.ensureMainSession(target.id, from?.profileId ?? this.profiles[0]!.id));
      const row = this.store.getItem(messageId);
      if (row?.type === "user" && row.delivery === "unsent") throw new HostError("conflict", row.deliveryReason || "消息运行时发送失败，请在会话中查看原因并重试。");
      if (row?.type === "user" && row.delivery === "expired") {
        const expired = this.save({ ...this.requireRelay(id), state: "expired", decidedAt: new Date().toISOString(), sessionId, error: row.deliveryReason });
        this.tellLead(expired, `这份传话已过期：${row.deliveryReason || "任务归属或要求已变化"}。请以当前任务通知和 task_workflow 为准。`);
        return expired;
      }
      const delivered = this.save({ ...this.requireRelay(id), state: "delivered", decidedAt: new Date().toISOString(), sessionId });
      // Joined the running turn (2026-11-17): in, but not read until the model's next step.
      const steered = row?.type === "user" && row.delivery === "waiting";
      this.tellLead(delivered, held ? `传话已放进「${target.title || "未命名任务"}」的会话，它这一轮做完就送进去。` : steered ? `传话已插进「${target.title || "未命名任务"}」正在做的这一轮，它做完手上这一步就会读到。` : `传话已送到「${target.title || "未命名任务"}」。`);
      return delivered;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const latest = this.requireRelay(id);
      if (latest.state !== "pending") return latest;
      const failed = this.save({ ...latest, state: "failed", decidedAt: new Date().toISOString(), error });
      this.tellLead(failed, `传话没能送到「${target?.title || relay.toTaskId}」：${error}`);
      return failed;
    } finally {
      if (relay.sessionId) this.recovering.delete(relay.sessionId);
    }
  }

  dismiss(id: Id): Relay {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending") throw new HostError("conflict", "this relay was decided already");
    const dismissed = this.save({ ...relay, state: "dismissed", decidedAt: new Date().toISOString() });
    const target = this.store.getTask(relay.toTaskId);
    this.tellLead(dismissed, `人没有让你的传话送到「${target?.title || relay.toTaskId}」。`);
    return dismissed;
  }

  private tellLead(relay: Relay, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: relay.fromSessionId }, text);
      if (relay.fromTaskId && relay.state !== "delivered") void this.f.sessions.inbox.put(relay.fromSessionId, text, undefined, `i-relay-receipt-${relay.id}`, { purpose: "notification", rebaseOnContextUpgrade: true }).catch((error: unknown) => this.log(`relay receipt: ${String(error)}`));
    } catch {
      // The 主控's session is gone: the relay still records what happened.
    }
  }
}
