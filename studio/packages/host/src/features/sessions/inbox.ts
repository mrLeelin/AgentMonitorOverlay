import { inTurn, managementRoot, splitAnnotationRefs, splitFileRefItems, splitRoleUpdate, type DecisionRequest, type Id, type MessageImage, type MessagePurpose, type Session, type SessionItem } from "@amo-studio/protocol";
import { newId, type SessionItemInput } from "../../store/store.js";
import { currentMessagePurpose, keepsAcceptance } from "../../runtime/message-purpose.js";
import { personsMessage } from "../../runtime/items.js";
import { Feature, type FeatureHost } from "../../core/feature.js";
import type { SessionsFeature } from "./service.js";
import { HostError, isRemoteCopy } from "../../core/shared.js";
import { managesTask } from "../../core/role.js";
import { BotLeadStore } from "../../store/bot-leads.js";

// 会话收件箱 (2026-11-04, plans/done/message-delivery.md): messages from agents and from Studio itself — a 中转 reply, 值守
// going on in a session, 传话 (task_message), a forwarded mail, session_send, session_start's report — go into the
// conversation at once as a row `delivery: "held"` (「等这一轮结束后送进去」) and are sent once the session is free: not in
// a turn, not waiting on the person, not handed to a terminal. Before, each place called sendMessage as the person's
// messages do: steered into a Codex turn mid-step, queued in memory only for DSH (and lost on an error), and a 中转
// reply that could not go in was lost after the relay had marked it taken. Only session_send waited, in its own kv.
//
// The row is the message (the store keeps it); kv `sessions.inbox` lists the sessions that have some, so a Host
// restart goes on sending. One that cannot go in becomes 没送到 with a line saying why (重新发送 tries again); an
// archived session's become 没送到 too. A copy of a remote session is not held here: its rows are the other computer's.

const INBOX_KEY = "sessions.inbox";
const PAUSED_KEY = "sessions.inbox.paused";
/** session_send's queue before the inbox (2026-11-01..11-04): session id → texts. Moved into the inbox at start. */
const PEER_QUEUE_KEY = "sessions.peer-queue";
/** How long the next held message waits for the turn the first one started to show (see deliver). */
const TURN_SEEN_MS = 3000;

interface InboxMessageOptions {
  botLetter?: import("@amo-studio/protocol").BotLetter;
  purpose?: MessagePurpose;
  replacesItemId?: Id;
  rebaseOnContextUpgrade?: boolean;
  images?: MessageImage[];
  answersDecisionId?: Id;
  fromPerson?: boolean;
  /** The text already ends with the session's role update (SessionsFeature.sendMessage wrote it); not stored. */
  roleIncluded?: boolean;
  afterTurn?: boolean;
  queuedSkillText?: string;
  queuedFromDevice?: { account: string; device: string };
}

export class SessionInbox extends Feature<"sharedContext"> {
  /** Keep durable messages held while a managed session's runtime is blocked or being reconciled. */
  canAutoDispatch: (sessionId: Id) => boolean = () => true;
  /** Durable producers recheck ownership/state immediately before dispatch or manual retry. */
  validateProducerMessage: (item: SessionItem) => void = () => undefined;
  constructor(
    host: FeatureHost<"sharedContext">,
    /** The feature the inbox is part of (it sends through it). */
    private readonly sessions: SessionsFeature,
  ) {
    super(host);
  }

  private known: Set<Id> | null = null;
  /** One delivery at a time per session; `again`: something came meanwhile, look once more after it. */
  private readonly flushing = new Map<Id, Promise<void>>();
  private readonly dispatchingItems = new Set<Id>();
  private readonly again = new Set<Id>();
  /**
   * Sessions the person stopped (2026-11-04, the user): what is held waits for their next message, and goes in with it,
   * or for 立即发送 — a session stopped on purpose is not started again by a reply arriving, including after restart.
   */
  private paused: Set<Id> | null = null;
  private readonly contextQueueing = new Set<Id>();
  /**
   * Sessions whose running turn refused a message joining it (2026-11-17: a review or a compaction takes none): the rest
   * waits for that turn to end. Cleared once the session is free.
   */
  private readonly refused = new Set<Id>();

  private pauses(): Set<Id> {
    if (!this.paused) {
      try {
        const value: unknown = JSON.parse(this.store.getKv(PAUSED_KEY)?.value ?? "[]");
        this.paused = new Set(Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []);
      } catch { this.paused = new Set(); }
    }
    return this.paused;
  }
  /** Paused sessions already told so in a notice. */
  private readonly told = new Set<Id>();

  isPaused(sessionId: Id): boolean {
    return this.pauses().has(sessionId);
  }

  /** 停止 by the person: hold what comes until they write again. */
  pause(sessionId: Id): void {
    this.pauses().add(sessionId);
    this.store.setKv(PAUSED_KEY, JSON.stringify([...this.pauses()]));
    this.told.delete(sessionId);
    if (this.held(sessionId).length) this.tellPaused(sessionId);
  }

  /** The person wrote again: what is held goes in now, with their message (queued or steered as theirs would be). */
  resume(sessionId: Id): void {
    if (!this.pauses().delete(sessionId)) return;
    this.store.setKv(PAUSED_KEY, JSON.stringify([...this.pauses()]));
    this.told.delete(sessionId);
    void this.flush(sessionId, true).catch(() => undefined);
  }

  private tellPaused(sessionId: Id): void {
    const s = this.store.getSession(sessionId);
    if (!s || this.told.has(sessionId)) return;
    this.told.add(sessionId);
    const message = "你停下了这个会话：排队的消息会等你恢复会话后再送。想现在送某一条，可以点它旁边的「立即发送」。";
    this.publish({ type: "item.appended", item: this.store.appendItem(this.row(s, { type: "notice", level: "info", message }, "inbox/paused")) });
  }

  /**
   * A message from an agent or from Studio into `sessionId`: shown at once, sent now when the session is free, else
   * when it is. `delivered`: it went in now; `waiting`: how many of the session's are still held.
   */
  async put(sessionId: Id, text: string, relayFromSessionId?: Id, messageId?: Id, options: InboxMessageOptions = {}): Promise<{ delivered: boolean; waiting: number }> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt || s.writer === "archived") throw new HostError("read_only", "这个会话已归档，不能再往里发消息");
    if (s.kind === "sub") throw new HostError("read_only", "子 agent 不能单独接收消息");
    if (!text.trim() && !options.images?.length) throw new HostError("bad_request", "text is required");
    if (isRemoteCopy(s)) {
      await this.sessions.sendMessage(sessionId, text);
      return { delivered: true, waiting: 0 };
    }
    // Durable producers may retry after a Host restart: the same inbox row must not start another turn.
    const existing = messageId ? this.store.getItem(messageId) : undefined;
    if (existing && (existing.sessionId !== sessionId || existing.type !== "user")) throw new HostError("conflict", "inbox message id belongs to another message");
    // The person's message, and any message SessionsFeature.sendMessage queued, already has the current role appended.
    const role = options.fromPerson || options.roleIncluded ? undefined : this.sessions.roleUpdate(sessionId);
    // A durable id freezes its text, purpose and requirement. A replacement always has a new id and source link.
    const item = existing ?? this.append(s, this.sessions.withContext(sessionId, role ? this.sessions.withRole(text, role.lines) : text), relayFromSessionId, messageId, options);
    if (!existing) role?.told();
    this.remember(sessionId);
    if (this.pauses().has(sessionId)) this.tellPaused(sessionId);
    await this.flush(sessionId);
    const now = this.store.getItem(item.id);
    return { delivered: now?.type === "user" && (now.delivery === undefined || now.delivery === "waiting"), waiting: this.held(sessionId).length };
  }

  /** 立即发送 on a held row: it goes now — into the running turn as the person's would, which then gives way to it. */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId || item.delivery !== "held") return;
    this.checkSource(item);
    const rt = this.runtime;
    if (!rt.resend) throw new HostError("bad_request", "this Host cannot send a held message");
    if (this.dispatchingItems.has(itemId)) throw new HostError("conflict", "这条消息正在发送，请稍后再试。");
    this.dispatchingItems.add(itemId);
    try { await this.wrap(() => rt.resend!(sessionId, itemId, this.sessions.retainedImages(item), { now: true })); }
    finally { this.dispatchingItems.delete(itemId); }
  }

  changeQueued(sessionId: Id, itemId: Id, edit?: { text: string; originalText: string }): void {
    const session = this.requireSession(sessionId);
    const item = this.store.getItem(itemId);
    if (session.archivedAt || session.writer === "archived" || session.writer === "terminal-handoff") throw new HostError("read_only", "会话当前不可修改。");
    if (item?.type !== "user" || item.sessionId !== sessionId || item.delivery !== "held" || !item.fromPerson || !item.afterTurn || this.dispatchingItems.has(itemId)) throw new HostError("conflict", "消息已不在排队中，请刷新后重试。");
    if (!edit) {
      this.publish({ type: "item.updated", item: this.store.replaceItem({ ...item, delivery: "expired", queueCancelled: true, deliveryReason: "已删除排队消息", deliveryEndedAt: new Date().toISOString() }) });
      return;
    }
    const own = splitRoleUpdate(item.text).text;
    if (item.text !== edit.originalText) throw new HostError("conflict", "消息已变化，请重新打开编辑。");
    if (!edit.text.trim()) throw new HostError("bad_request", "消息不能为空。");
    if (item.images?.length || item.queuedSkillText || splitAnnotationRefs(own).refs.length || splitFileRefItems(own).refs.length || /\n\n(?:提到的(?:任务|会话|项目)：|子会话的(?:开法|设定)（|「@快速提交」)|\[AMO_SHARED_CONTEXT:/u.test(own) || !item.text.startsWith(own)) throw new HostError("bad_request", "含附件或特殊引用的排队消息暂不支持编辑。");
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...item, text: edit.text + item.text.slice(own.length) }) });
  }

  retainForLeadHandoff(sessionId: Id, itemId: Id): void {
    const session = this.requireSession(sessionId);
    const task = session.taskId ? this.store.getTask(session.taskId) : undefined;
    const terms = new BotLeadStore(this.store);
    if (!task || task.archivedAt || session.archivedAt || session.writer !== "workbench" ||
        (!terms.pendingUpgrade(task.id) && (!task.lead || terms.currentTerm(task.id)))) {
      throw new HostError("conflict", "该会话当前没有待交接的主控。");
    }
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId || !item.fromPerson || (item.delivery !== "held" && item.delivery !== "unsent") || this.dispatchingItems.has(itemId)) {
      throw new HostError("conflict", "请选择尚未送出的用户消息。");
    }
    this.expire(itemId, "留作主控交接。");
  }

  cancelBotRequest(sessionId: Id, itemId: Id): void {
    const item = this.store.getItem(itemId);
    if (!itemId.startsWith("bot-request:") || item?.type !== "user" || item.sessionId !== sessionId || item.delivery !== "held" || this.dispatchingItems.has(itemId)) {
      throw new HostError("conflict", "这条消息正在发送，请稍后再试。");
    }
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...item, delivery: "expired", queueCancelled: true, deliveryReason: "已停止群组回复", deliveryEndedAt: new Date().toISOString() }) });
  }

  isDispatching(sessionId: Id): boolean {
    return [...this.dispatchingItems].some((id) => this.store.getItem(id)?.sessionId === sessionId);
  }

  /** Watches sessions get free; sends what the last Host left held, and moves session_send's old queue in. */
  watch(): void {
    this.migratePeerQueue();
    // New sessions get the frozen context in their first runtime input. Queuing a second automatic input during
    // session creation can race that first turn; task changes still enqueue notices for every existing session.
    const resumed = new Set(this.store.listSessions().map((s) => s.id));
    this.host.on("event", (e) => {
      if (e.type === "session.upserted" && this.ids().has(e.session.id)) void this.flush(e.session.id).catch(() => undefined);
      if (e.type === "item.updated" && e.item.type === "user" && e.item.delivery === "held") this.heldAgain(e.item.sessionId);
      if (e.type === "session.upserted" && resumed.has(e.session.id)) this.queueContext(e.session);
      if (e.type === "task.upserted") for (const session of this.store.listSessions()) { this.reconcile(session.id); if (session.taskId === e.task.id) this.queueContext(session); }
    });
    for (const session of this.store.listSessions()) {
      this.reconcile(session.id);
      // Held again by a runtime starting up (what the last Host's turns took in and never read), before this listened.
      if (!isRemoteCopy(session) && this.held(session.id).length) this.remember(session.id);
    }
    for (const id of this.ids()) void this.flush(id).catch(() => undefined);
    for (const session of this.store.listSessions()) this.queueContext(session);
  }

  /**
   * A message back in the inbox (2026-11-17): a runtime took it in and it was never read — 停止, a restart, a dropped
   * app-server — so it goes again by the inbox's rules, not started again by the runtime nor left 没送到.
   */
  private heldAgain(sessionId: Id): void {
    const s = this.store.getSession(sessionId);
    if (!s || isRemoteCopy(s)) return;
    this.remember(sessionId);
    void this.flush(sessionId).catch(() => undefined);
  }

  private queueContext(session: Session): void {
    if (session.kind !== "main" || session.archivedAt || session.writer === "archived" || isRemoteCopy(session) || this.sessions.startingTaskSession(session.taskId) || this.contextQueueing.has(session.id) || !this.canAutoDispatch(session.id)) return;
    const notices = this.f.sharedContext.pendingNotifications(session.id);
    if (!notices.length) return;
    // The first work input can carry the same frozen context while its native echo is still on the way.
    if (inTurn(session.status) || this.runtime.hasPendingDispatch?.(session.id)) {
      const [first] = this.store.findItems(session.id, "user", {}, { limit: 1 });
      if (first?.type === "user" && (first.delivery === undefined || first.delivery === "waiting") &&
          !first.id.startsWith("i-context-") && notices.every((notice) => first.text.includes(notice.text))) return;
    }
    this.contextQueueing.add(session.id);
    void (async () => {
      for (const notice of notices) {
        this.f.sharedContext.markQueued(session.id, notice.id);
        await this.put(session.id, notice.text, undefined, notice.id, { purpose: "notification" });
      }
    })().catch((error: unknown) => this.log(`shared context inbox: ${String(error)}`)).finally(() => {
      this.contextQueueing.delete(session.id);
      // apply can arrive while put awaits a runtime. Replay only a newly selected requirement, never the same held row.
      const current = this.store.getSession(session.id);
      if (current && this.f.sharedContext.pendingNotifications(session.id).some((n) => !notices.some((old) => old.id === n.id))) this.queueContext(current);
    });
  }

  /** The session's held rows, oldest first. */
  held(sessionId: Id): SessionItem[] {
    return this.store.findItems(sessionId, "user", { delivery: "held" });
  }

  /** `withTurn`: also into a turn already running (the person's message that ended a pause). */
  flush(sessionId: Id, withTurn = false): Promise<void> {
    const running = this.flushing.get(sessionId);
    if (running) {
      this.again.add(sessionId);
      return running;
    }
    const p = this.deliver(sessionId, withTurn).finally(() => {
      this.flushing.delete(sessionId);
      if (this.again.delete(sessionId)) void this.flush(sessionId).catch(() => undefined);
    });
    this.flushing.set(sessionId, p);
    return p;
  }

  private async deliver(sessionId: Id, withTurn = false): Promise<void> {
    this.reconcile(sessionId);
    const s = this.store.getSession(sessionId);
    const held = s ? this.held(sessionId) : [];
    if (!s || !held.length) return this.forget(sessionId);
    if (s.archivedAt || s.writer === "archived") {
      for (const it of held) this.mark(it.id, "unsent");
      return this.forget(sessionId);
    }
    if (this.pauses().has(sessionId) || !this.canAutoDispatch(sessionId)) return;
    const busy = !free(s) && !(withTurn && s.status === "running" && writable(s));
    if (!busy) this.refused.delete(sessionId);
    // Busy: only the direct manager's work 传话 and answers go in, into a running work turn the runtime can steer
    // (2026-11-17, plans/done/lead-instructions-mid-turn.md); and while only the person's answer is awaited (Codex's
    // 等待回答 with no turn running), the person's own messages, which answer it (2026-11-17: one they wrote during the
    // turn that asked waited behind the card). The rest still waits for the session to be free.
    const joining = busy && this.joinsRunningTurn(s);
    const answering = busy && !joining && writable(s) && this.runtime.betweenTurns?.(s.id) === true;
    if (busy && !joining && !answering) return;
    const rt = this.runtime;
    const goes = (row: SessionItem | undefined): row is Extract<SessionItem, { type: "user" }> => row?.type === "user" && row.delivery === "held" && (!joining || this.fromDirectManager(s, row)) && (!answering || personsMessage(row));
    // The first starts a turn; the others follow it at once (queued at the CLI, steered in, or DSH's next turn) — once
    // the turn is seen to run: Codex tells it (turn/started) only after its turn/start, and a second turn/start before
    // that would not be a steer.
    let before: number | null = null;
    for (const it of held) {
      if (!this.canAutoDispatch(sessionId)) break;
      if (!goes(this.store.getItem(it.id))) continue; // without waiting for the last one's turn (2026-11-17)
      if (before !== null) await this.turnSeen(sessionId, before);
      const current = this.store.getItem(it.id);
      if (!goes(current)) continue;
      const latest = this.store.getSession(sessionId) ?? s;
      // A queued follow-up waits for each native turn, including the turn started by the previous inbox row.
      if (current.afterTurn && (this.pauses().has(sessionId) || (inTurn(latest.status) && !this.runtime.betweenTurns?.(sessionId)))) continue;
      // Joining: rechecked for each, as the person may have stopped the session, or its turn ended, meanwhile.
      if (joining && !this.joinsRunningTurn(this.store.getSession(sessionId) ?? s)) break;
      // A native Goal can start its next work turn by itself. Keep read-only questions/notifications held until
      // it pauses or ends, instead of changing that autonomous work's purpose or marking the message as failed.
      if (this.store.getSession(sessionId)?.goal?.status === "active" && (current.messagePurpose === "inquiry" || current.messagePurpose === "notification")) continue;
      before = current.seq;
      try {
        this.checkSource(current);
        if (!rt.resend) throw new Error("this Host cannot send a held message");
        if (this.dispatchingItems.has(it.id)) continue;
        this.dispatchingItems.add(it.id);
        try { await rt.resend(sessionId, it.id, this.sessions.retainedImages(current)); }
        finally { this.dispatchingItems.delete(it.id); }
      } catch (err) {
        before = null; // No turn was started by a failed dispatch; do not delay the next independent message.
        const why = err instanceof Error ? err.message : String(err);
        if (this.store.getItem(it.id)?.type === "user" && (this.store.getItem(it.id) as Extract<SessionItem, { type: "user" }>).delivery === "expired") continue;
        // Joining only brings a message in sooner (2026-11-17): refused by that turn, it waits for the turn to end as
        // before, instead of becoming 没送到 — and nothing more tries that turn.
        if (joining) { this.refused.add(sessionId); this.hold(it.id); continue; }
        this.mark(it.id, "unsent", why);
        this.publish({ type: "item.appended", item: this.store.appendItem(this.row(s, { type: "notice", level: "warning", message: `这条消息没能送进会话：${why}。可以点它下面的「重新发送」再试。` }, "inbox/failed")) });
      }
    }
    if (!this.held(sessionId).length) this.forget(sessionId);
  }

  /**
   * A running turn the direct manager's work 传话 and answers may join (2026-11-17, plans/done/lead-instructions-mid-turn.md):
   * the runtime can steer into it (Codex), the person did not stop the session, no Goal runs on, the turn may write
   * (not an inquiry or a notification), and it did not refuse one already.
   */
  joinsRunningTurn(s: Session): boolean {
    return s.status === "running" && writable(s) && !this.pauses().has(s.id) && !this.refused.has(s.id) && s.goal?.status !== "active" && !keepsAcceptance(currentMessagePurpose(this.store, s.id)) && this.runtime.steerable?.(s.id) === true;
  }

  /** The direct manager's answer to the session's decision, which can join its running turn now (collab, 2026-11-17). */
  joinsWithAnswer(s: Session, decision: DecisionRequest): boolean {
    return this.managerAnswer(s, decision) && this.joinsRunningTurn(s);
  }

  /** The direct manager's work 传话 to this session, or its answer to this session's decision. */
  private fromDirectManager(s: Session, item: Extract<SessionItem, { type: "user" }>): boolean {
    const managerTaskId = s.taskId ? this.store.getTask(s.taskId)?.managerTaskId : undefined;
    if (!managerTaskId || keepsAcceptance(item.messagePurpose ?? "work")) return false;
    if (item.relayFromSessionId) return this.store.getSession(item.relayFromSessionId)?.taskId === managerTaskId;
    const decision = item.answersDecisionId ? this.store.getDecision(item.answersDecisionId) : undefined;
    return !!decision && this.managerAnswer(s, decision);
  }

  private managerAnswer(s: Session, decision: DecisionRequest): boolean {
    const managerTaskId = s.taskId ? this.store.getTask(s.taskId)?.managerTaskId : undefined;
    return !!managerTaskId && decision.state === "answered" && decision.routedToTaskId === managerTaskId;
  }

  /** Back to held: a message a running turn refused, to go in once the turn is over. */
  private hold(itemId: Id): void {
    const it = this.store.getItem(itemId);
    if (it?.type !== "user" || (it.delivery !== "unsent" && it.delivery !== "waiting")) return;
    const { deliveryReason: _why, ...rest } = it;
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...rest, delivery: "held" }) });
  }

  /**
   * Until the turn the message at `afterSeq` started shows: the session in a turn, or a turn row after the message (a
   * short turn may be over already) — or TURN_SEEN_MS passed (none started).
   */
  private async turnSeen(sessionId: Id, afterSeq: number): Promise<void> {
    const end = Date.now() + TURN_SEEN_MS;
    while (Date.now() < end) {
      const s = this.store.getSession(sessionId);
      if (!s || inTurn(s.status)) return;
      const [turn] = this.store.findItems(sessionId, "turn", {}, { newest: true, limit: 1 });
      if (turn && turn.seq > afterSeq) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Rechecked at actual dispatch, including held messages surviving a Host restart or manual retry. */
  checkSource(item: SessionItem): void {
    this.validateProducerMessage(item);
    if (item.type === "user" && item.delivery === "expired") throw new HostError("read_only", item.deliveryReason ?? "这条通知已过期，不能重新发送。");
    if (!this.f.sharedContext.validateMessage(item.sessionId, item.id)) { this.expire(item.id, "共同需求通知已失效，请读取当前任务的共同需求。"); throw new HostError("read_only", "共同需求通知已失效，请读取当前任务的共同需求。"); }
    if (item.type !== "user" || !item.relayFromSessionId) return;
    const taskId = this.store.getSession(item.sessionId)?.taskId;
    if (!taskId || !managesTask(this.host, item.relayFromSessionId, taskId)) { this.expire(item.id, "原主控已不在此任务的管理范围，这条待送传话已失效；请由当前主控重新发送。"); throw new HostError("read_only", "原主控已不在此任务的管理范围，这条待送传话已失效；请由当前主控重新发送。"); }
  }

  /** Permanent transport terminal state; frozen historical text remains inspectable. */
  expire(itemId: Id, reason: string): void {
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.delivery === "expired" || (item.delivery !== "held" && item.delivery !== "unsent")) return;
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...item, delivery: "expired", deliveryReason: reason, deliveryEndedAt: new Date().toISOString() }) });
  }

  /** The previous Host's exact system representation is already a permanent revocation, not reissuable work. */
  expireLegacy(item: SessionItem): boolean {
    if (item.type !== "user" || item.raw?.method !== "user/inbox" || !["held", "unsent", "expired"].includes(item.delivery ?? "") || (item.text !== "【管理通知已失效】任务归属或问题状态已变化，请以 task_workflow 最新内容为准。" && item.text !== "【管理通知已转交新会话】旧会话已归档，以任务当前主会话中的通知为准。")) return false;
    this.expire(item.id, "旧管理通知已作废或转交，保留历史且禁止重新发送。");
    return true;
  }

  /** Validate even while paused/busy. Only an explicit same-tree upgrade can replace still-authorised relay work. */
  reconcile(sessionId: Id): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    for (const item of [...this.store.findItems(sessionId, "user", { delivery: "held" }), ...this.store.findItems(sessionId, "user", { delivery: "unsent" })]) {
      if (item.type !== "user" || (item.delivery !== "held" && item.delivery !== "unsent")) continue;
      if (this.expireLegacy(item)) continue;
      // Recognise durable system producers before validating the version, including same-version old rows.
      const automatic = !item.relayFromSessionId && (item.rebaseOnContextUpgrade || this.store.listTaskPlans().some((p) => p.fromSessionId === sessionId && p.fromTaskId === session.taskId && item.id.startsWith(`i-taskplan-${p.id}-`)) || this.store.listRelays().some((r) => r.fromSessionId === sessionId && r.fromTaskId === session.taskId && item.id.startsWith(`i-relay-receipt-${r.id}`)));
      if (!item.messagePurpose && (automatic || item.id.startsWith("i-context-") && this.f.sharedContext.validateMessage(sessionId, item.id))) this.store.replaceItem({ ...item, messagePurpose: "notification", ...(automatic ? { rebaseOnContextUpgrade: true } : {}) });
      const token = [...item.text.matchAll(/^\[AMO_SHARED_CONTEXT:([^\]]+)\]\r?$/gm)].map((m) => m[1]);
      const validSource = !item.relayFromSessionId || !!session.taskId && managesTask(this.host, item.relayFromSessionId, session.taskId);
      if (validSource && this.f.sharedContext.validateMessage(sessionId, item.id)) continue;
      const view = session.taskId ? this.f.sharedContext.get(session.taskId) : null;
      const old = this.f.sharedContext.receipts(sessionId).find((r) => token.includes(r.requirementId));
      const root = session.taskId ? managementRoot(this.store.listTasks(), session.taskId)?.id : undefined;
      // Legacy receipt rows can be recognised by their persisted producer, never by guessing message intent.
      const replace = (!!item.relayFromSessionId || automatic) && validSource && view?.validBinding && view.binding && !!old && old.rootTaskId === root && view.binding.rootTaskId === root && old.requirementId !== view.binding.id;
      this.store.transaction(() => {
        this.expire(item.id, validSource ? "共同需求已升级或原绑定已失效；此通知保留为历史。" : "原主控已不在当前管理范围；此通知永久撤回。");
        if (replace && !session.archivedAt && session.writer !== "archived") {
          const start = item.text.search(/^\[AMO_SHARED_CONTEXT:/m);
          const business = start < 0 ? item.text : item.text.slice(0, start).trimEnd();
          void this.put(sessionId, business, item.relayFromSessionId, `${item.id}-context-${view.binding!.id}`, { purpose: automatic ? "notification" : item.messagePurpose, replacesItemId: item.id, images: item.images, ...(automatic ? { rebaseOnContextUpgrade: true } : {}) }).catch((error: unknown) => this.log(`replacement inbox: ${String(error)}`));
        }
      });
    }
  }

  private append(s: Session, text: string, relayFromSessionId?: Id, messageId?: Id, options: InboxMessageOptions = {}): SessionItem {
    const { images, replacesItemId, rebaseOnContextUpgrade, answersDecisionId, fromPerson, afterTurn, queuedSkillText, queuedFromDevice } = options;
    const row = this.row(s, { type: "user", text, delivery: "held", messagePurpose: options.purpose ?? "work", images: images?.length ? images : undefined, replacesItemId, rebaseOnContextUpgrade, relayFromSessionId, answersDecisionId, fromPerson, afterTurn, queuedSkillText, queuedFromDevice, ...(options.botLetter ? { botLetter: options.botLetter } : {}) }, "user/inbox");
    const item = this.store.appendItem({ ...row, ...(messageId ? { id: messageId } : {}) });
    this.publish({ type: "item.appended", item });
    return item;
  }

  /** A row of Studio's own in the session; in the turn running now, if one is (the transcript groups rows by turn). */
  private row(s: Session, body: Record<string, unknown>, method: string): SessionItemInput {
    const [turn] = this.store.findItems(s.id, "turn", { state: "running" }, { newest: true, limit: 1 });
    const turnId = turn?.type === "turn" ? turn.turnId : undefined;
    return { ...body, id: newId("i"), sessionId: s.id, createdAt: new Date().toISOString(), raw: { runtime: s.runtime, method, ...(turnId ? { turnId } : {}) } } as SessionItemInput;
  }

  private mark(itemId: Id, delivery: "unsent", reason = "会话已归档，消息未发送。"): void {
    const it = this.store.getItem(itemId);
    if (it?.type !== "user" || it.delivery !== "held") return;
    this.publish({ type: "item.updated", item: this.store.replaceItem({ ...it, delivery, deliveryReason: reason }) });
  }

  private ids(): Set<Id> {
    if (!this.known) {
      try {
        const list = JSON.parse(this.store.getKv(INBOX_KEY)?.value ?? "[]") as unknown;
        this.known = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
      } catch {
        this.known = new Set();
      }
    }
    return this.known;
  }

  private remember(sessionId: Id): void {
    const ids = this.ids();
    if (ids.has(sessionId)) return;
    ids.add(sessionId);
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  private forget(sessionId: Id): void {
    const ids = this.ids();
    if (!ids.delete(sessionId)) return;
    this.store.setKv(INBOX_KEY, JSON.stringify([...ids]));
  }

  /** session_send's own queue (kv `sessions.peer-queue`), left by a Host before the inbox: its texts become held rows. */
  private migratePeerQueue(): void {
    const kv = this.store.getKv(PEER_QUEUE_KEY);
    if (!kv?.value) return;
    let queue: Record<Id, string[]> = {};
    try {
      queue = JSON.parse(kv.value) as Record<Id, string[]>;
    } catch {
      // Unreadable: nothing to move.
    }
    for (const [sessionId, texts] of Object.entries(queue)) {
      const s = this.store.getSession(sessionId);
      if (!s || s.archivedAt || !Array.isArray(texts)) continue;
      for (const text of texts) if (typeof text === "string" && text.trim()) this.append(s, text);
      this.remember(sessionId);
    }
    this.store.setKv(PEER_QUEUE_KEY, "");
  }
}

/** Free for a message of an agent's: not in a turn or waiting on the person, and Studio may write to it. */
function free(s: Session): boolean {
  return !inTurn(s.status) && writable(s);
}

function writable(s: Session): boolean {
  return s.writer === "workbench" || s.writer === "terminal-shared";
}
