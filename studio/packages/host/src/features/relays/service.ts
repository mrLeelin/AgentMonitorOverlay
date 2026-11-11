import { RELAY_TEXT_MAX, type Id, type Relay, type Session } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { managesTask, roleFacts } from "../../core/role.js";

/** How long a decided relay stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;

/**
 * 传话 (stage 16, from the stage 15 design): a 主控 (or a topic's own session) asks Studio to say something in another
 * managed task's session automatically. Topic sessions retain the confirmation workflow. Dispatch and receipts
 * use stable inbox ids so a restart cannot duplicate a delivered message.
 */
export class RelaysFeature extends Feature<"collab" | "sessions" | "tasks"> {
  private readonly delivering = new Map<Id, Promise<Relay>>();

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

  private requireRelay(id: Id): Relay {
    const relay = this.store.getRelay(id);
    if (!relay) throw new HostError("not_found", `relay ${id} not found`);
    return relay;
  }

  private save(relay: Relay): Relay {
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
    const relay = this.save({ id: newId("relay"), fromSessionId, fromTaskId: facts.task?.id ?? null, toTaskId: target.id, text, purpose, state: "pending", createdAt: new Date().toISOString(), decidedAt: null });
    if (facts.role === "lead" || target.relayAuto) void Promise.resolve().then(() => this.deliver(relay.id)).catch(() => undefined);
    return relay;
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
    const message = [
      `【主控「${lead?.title || "主控"}」传话】`,
      relay.text,
      "",
      relay.purpose === "inquiry" ? "（这是主控通过 AMO Studio 发来的只读询问：仅回答问题，不继续实施、不重新提交交付，也不撤销已有验收。）" : `（这是主控通过 AMO Studio 传来的。完成工作后用 task_submit_result 提交成果，由直属主控验收；日常补充用 mailbox_send 给${relay.fromTaskId ? `任务 ${relay.fromTaskId}` : `会话 ${relay.fromSessionId}`}。）`,
    ].join("\n");
    try {
      if (!target || target.archivedAt) throw new HostError("bad_request", "the task is gone or archived");
      if (!managesTask(this.host, relay.fromSessionId, target.id)) throw new HostError("bad_request", "任务归属已变更，原主控不再管理此任务。");
      const session = latestMain(this.store.listSessions({ taskId: target.id }));
      let sessionId: Id;
      let held = false;
      if (session) {
        // The session's inbox (2026-11-04): it goes in once the session's turn is over, not into the running one.
        held = !(await this.f.sessions.inbox.put(session.id, message, relay.fromSessionId, `i-relay-${relay.id}`, { purpose: relay.purpose ?? "work" })).delivered;
        sessionId = session.id;
      } else {
        const workspace = this.requireWorkspace(target.workspaceId);
        const profileId = from?.profileId ?? this.profiles[0]!.id;
        sessionId = (await this.f.tasks.startSession({ taskId: target.id, topicId: null }, workspace, { profileId })).id;
        held = !(await this.f.sessions.inbox.put(sessionId, message, relay.fromSessionId, `i-relay-${relay.id}`, { purpose: relay.purpose ?? "work" })).delivered;
      }
      const row = this.store.getItem(`i-relay-${relay.id}`);
      if (row?.type === "user" && row.delivery === "unsent") throw new HostError("conflict", row.deliveryReason || "消息运行时发送失败，请在会话中查看原因并重试。");
      if (row?.type === "user" && row.delivery === "expired") {
        const expired = this.save({ ...this.requireRelay(id), state: "expired", decidedAt: new Date().toISOString(), sessionId, error: row.deliveryReason });
        this.tellLead(relay, `这份传话已过期：${row.deliveryReason || "任务归属或要求已变化"}。请以当前任务通知和 task_workflow 为准。`);
        return expired;
      }
      const delivered = this.save({ ...this.requireRelay(id), state: "delivered", decidedAt: new Date().toISOString(), sessionId });
      this.tellLead(relay, held ? `传话已放进「${target.title || "未命名任务"}」的会话，它这一轮做完就送进去。` : `传话已送到「${target.title || "未命名任务"}」。`);
      return delivered;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed = this.save({ ...this.requireRelay(id), state: "failed", decidedAt: new Date().toISOString(), error });
      this.tellLead(relay, `传话没能送到「${target?.title || relay.toTaskId}」：${error}`);
      return failed;
    }
  }

  dismiss(id: Id): Relay {
    const relay = this.requireRelay(id);
    if (relay.state !== "pending") throw new HostError("conflict", "this relay was decided already");
    const dismissed = this.save({ ...relay, state: "dismissed", decidedAt: new Date().toISOString() });
    const target = this.store.getTask(relay.toTaskId);
    this.tellLead(relay, `人没有让你的传话送到「${target?.title || relay.toTaskId}」。`);
    return dismissed;
  }

  private tellLead(relay: Relay, text: string): void {
    try {
      this.f.collab.sendMail(null, { kind: "session", sessionId: relay.fromSessionId }, text);
      if (relay.fromTaskId) void this.f.sessions.inbox.put(relay.fromSessionId, text, undefined, `i-relay-receipt-${relay.id}`, { purpose: "notification", rebaseOnContextUpgrade: true }).catch((error: unknown) => this.log(`relay receipt: ${String(error)}`));
    } catch {
      // The 主控's session is gone: the relay still records what happened.
    }
  }
}

/** The task's main session it was last working in (not archived, not handed to a terminal). */
function latestMain(sessions: readonly Session[]): Session | undefined {
  return sessions
    .filter((s) => s.kind === "main" && !s.archivedAt && s.writer !== "archived")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
