import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Id, Session, SessionGoal, SessionGoalState, SessionGoalUpdate } from "@amo-studio/protocol";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import { localCommandText } from "./commands.js";
import { queueMessagePurpose } from "../message-purpose.js";
import { withTimeout } from "./probe.js";

const NOTE = "Claude 使用原生 Goal 检查完成条件；暂停或清除会中断当前回复，继续会重新开启保存的目标。原生不提供 Token 预算。";
const CLOSED_REASON = "Claude 进程已退出，原生目标仍保留；点击继续执行重新开始，或清除目标。";
const unsupported = (message: string) => Object.assign(new Error(message), { code: "bad_request" });
type GoalRow = { condition: string; met: boolean; sentinel?: boolean; failed?: boolean; reason?: string; iterations?: number; durationMs?: number; tokens?: number; at?: number };
type Pending = { uuid: string; args: string; started: boolean; settled: Promise<string>; queued: () => void; resolve: (text: string) => void; reject: (error: Error) => void };

/** Bounded incremental reads of Claude's structured native Goal attachments, including CLI versions that omit active_goal from SDK stdout. */
export class GoalJournal {
  private file: string | undefined;
  private offset = 0;
  private rest = "";
  private decoder = new StringDecoder("utf8");
  constructor(private readonly home: string, private readonly ref: string) {}
  read(): GoalRow[] {
    const roots = join(this.home, "projects");
    if (!this.file && existsSync(roots) && /^[\w-]+$/.test(this.ref)) {
      this.file = readdirSync(roots, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(roots, d.name, `${this.ref}.jsonl`)).find(existsSync);
    }
    if (!this.file || !existsSync(this.file)) return [];
    const size = statSync(this.file).size;
    if (size < this.offset) { this.offset = 0; this.rest = ""; this.decoder = new StringDecoder("utf8"); }
    if (size === this.offset) return [];
    const start = Math.max(this.offset, size - 2 * 1024 * 1024), buffer = Buffer.alloc(size - start);
    const fd = openSync(this.file, "r");
    let n: number;
    try { n = readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    if (start > this.offset) this.decoder = new StringDecoder("utf8");
    let text = (start === this.offset ? this.rest : "") + this.decoder.write(buffer.subarray(0, n));
    if (start > this.offset) text = text.slice(text.indexOf("\n") + 1);
    this.offset = start + n;
    const lines = text.split("\n"); this.rest = lines.pop() ?? "";
    return lines.flatMap((line) => {
      try { const row = JSON.parse(line) as { timestamp?: string; attachment?: { type?: string } & GoalRow }; const at = row.timestamp ? Date.parse(row.timestamp) : NaN; return row.attachment?.type === "goal_status" && typeof row.attachment.condition === "string" ? [{ ...row.attachment, ...(Number.isFinite(at) ? { at } : {}) }] : []; }
      catch { return []; }
    });
  }
}

/** Native /goal commands, never a Host-generated work loop. User actions complete only after the local command acknowledgement. */
export class ClaudeGoals {
  private readonly pending = new Map<Id, Pending>();
  private readonly versions = new Map<Id, number>();
  private readonly queues = new Map<Id, Promise<unknown>>();
  private readonly journals = new Map<Id, GoalJournal>();
  private readonly polls = new Map<Id, ReturnType<typeof setInterval>>();
  private readonly supported = new WeakMap<Live, boolean>();
  private readonly clearing = new Set<Id>();
  private readonly metrics = new Map<Id, { tokens: boolean; elapsed: boolean }>();
  private readonly reads = new Map<Id, Promise<SessionGoalState>>();
  private readonly acknowledgedAt = new Map<Id, number>();
  private disposed = false;
  constructor(private readonly core: ClaudeCore, private readonly writable: (id: Id) => Session, private readonly onSettled: (id: Id, live: Live) => void = () => undefined) {}

  state(id: Id): SessionGoalState {
    const goal = this.core.store.getSession(id)?.goal ?? null;
    const terminal = goal?.status === "complete" || goal?.status === "blocked", metrics = this.metrics.get(id);
    return { goal, capabilities: { tokenBudget: false, roundBudget: false, pause: true, tokens: terminal && !!metrics?.tokens, elapsed: terminal && !!metrics?.elapsed }, note: NOTE };
  }

  get(id: Id): Promise<SessionGoalState> {
    if (this.disposed) return Promise.resolve({ ...this.state(id), unavailable: "Claude 会话服务已关闭。" });
    const pending = this.reads.get(id);
    if (pending) return pending;
    const read = this.read(id);
    this.reads.set(id, read);
    void read.finally(() => { if (this.reads.get(id) === read) this.reads.delete(id); }).catch(() => undefined);
    return read;
  }
  private async read(id: Id): Promise<SessionGoalState> {
    const session = this.core.requireSession(id);
    if (session.kind === "sub") return { ...this.state(id), unavailable: "Claude 子 agent 共用父会话，不能单独控制 Goal。" };
    if (session.goal?.status === "active" && !this.core.live.has(id) && (session.writer === "workbench" || session.archivedAt)) this.closed(id);
    this.refresh(id);
    // Journal/events own an active Goal. A local /goal read can otherwise queue behind a model request before
    // its first SDK stream event, delaying the person's next pause/clear behind that same work.
    if (session.archivedAt || session.writer !== "workbench" || this.pending.has(id) || this.core.live.get(id)?.running || this.core.requireSession(id).goal?.status === "active") return this.state(id);
    try { await this.command(id, "", false); }
    catch (error) { if (String(error).includes("不支持原生 /goal")) return { ...this.state(id), unavailable: String((error as Error).message) }; throw error; }
    this.refresh(id);
    return this.state(id);
  }

  set(id: Id, input: SessionGoalUpdate, beforeDispatch?: () => void): Promise<SessionGoalState> {
    if (input.tokenBudget !== undefined || input.roundBudget !== undefined) return Promise.reject(unsupported("Claude 原生 Goal 不提供 Token 或轮次预算。"));
    if (input.status === "paused") return this.pause(id);
    const version = this.versions.get(id) ?? 0;
    return this.serial(id, async () => {
      const check = () => { this.assertOpen(); this.writable(id); beforeDispatch?.(); if (version !== (this.versions.get(id) ?? 0)) throw unsupported("会话已停止，这次待开启的 Goal 已取消。"); };
      check();
      const objective = (input.objective ?? this.core.requireSession(id).goal?.objective ?? "").trim();
      if (!objective || [...objective].length > 4000 || /^(?:clear|off)$/i.test(objective)) throw unsupported("请填写有效目标；clear 和 off 是 Claude 的清除命令，不能作为目标。");
      this.refresh(id);
      if (this.core.requireSession(id).goal?.status === "active" && this.core.requireSession(id).goal?.objective === objective) return this.state(id);
      await this.command(id, objective, false, check);
      this.refresh(id);
      return this.state(id);
    });
  }

  async pause(id: Id): Promise<SessionGoalState> {
    this.writable(id);
    this.invalidate(id);
    await this.reads.get(id)?.catch(() => undefined);
    const activation = this.pending.get(id);
    if (activation && activation.args !== "clear") {
      // A dispatched local setter must be consumed before clear. Moving clear ahead of a still-queued setter
      // would allow that setter to re-enable the hook after Stop. A concurrent state read must settle as well.
      await activation.settled.catch(() => undefined);
      if (this.pending.get(id) === activation) this.pending.delete(id);
    }
    const goal = this.core.requireSession(id).goal ?? (activation?.args ? this.goal(id, activation.args) : null);
    if (!goal || (goal.status !== "active" && goal.lastReason !== CLOSED_REASON)) return this.state(id);
    this.clearing.add(id);
    try {
      await this.command(id, "clear", true);
      this.refresh(id);
      this.record(id, { ...goal, status: "paused", updatedAt: this.seconds() });
      return this.state(id);
    } finally { this.clearing.delete(id); }
  }

  async clear(id: Id): Promise<SessionGoalState> {
    this.writable(id);
    this.invalidate(id);
    await this.reads.get(id)?.catch(() => undefined);
    const activation = this.pending.get(id);
    if (activation && activation.args !== "clear") {
      await activation.settled.catch(() => undefined);
      if (this.pending.get(id) === activation) this.pending.delete(id);
    }
    this.clearing.add(id);
    try {
      await this.command(id, "clear", true);
      this.refresh(id);
      this.record(id, null);
      return this.state(id);
    } finally { this.clearing.delete(id); }
  }

  invalidate(id: Id): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
  }

  activeOrPending(id: Id): boolean { const goal = this.core.store.getSession(id)?.goal; return goal?.status === "active" || goal?.lastReason === CLOSED_REASON || !!this.pending.get(id)?.args && this.pending.get(id)?.args !== "clear"; }

  closed(id: Id): void {
    this.refresh(id);
    const goal = this.core.store.getSession(id)?.goal;
    if (goal?.status === "active") this.record(id, { ...goal, status: "blocked", lastReason: CLOSED_REASON, updatedAt: this.seconds() });
    this.pending.get(id)?.reject(new Error("Claude 进程已退出，Goal 操作未能确认。"));
  }

  /** Returns true only for internal local /goal output, which must not create a phantom work turn during a read. */
  observe(id: Id, live: Live, message: SDKMessage): boolean {
    if (this.disposed) return false;
    const m = message as unknown as Record<string, unknown>;
    if (m.parent_tool_use_id) return false;
    const pending = this.pending.get(id);
    if (m.type === "command_lifecycle" && pending && m.command_uuid === pending.uuid) {
      if (m.state === "queued") pending.queued();
      if (m.state === "started") pending.started = true;
      if (m.state === "cancelled") pending.reject(new Error("Claude 取消了 Goal 命令。"));
    }
    const local = m.local_command_run as { command?: string; args?: string } | undefined;
    if (local?.command === "goal" && typeof m.local_command_source === "string") {
      const text = localCommandText(m.local_command_source), args = (local.args ?? "").trim();
      this.localResult(id, args, text, typeof m.timestamp === "string" ? Date.parse(m.timestamp) : this.core.now().getTime());
      if (pending?.started && pending.args === args) {
        if (/^Goal set:|^Goal cleared:|^Goal active:|^No goal set/.test(text)) pending.resolve(text);
        else pending.reject(new Error(text || "Claude 未确认 Goal 操作。"));
        if (args) this.core.appendItem(id, { type: "command", name: "goal", output: text }, { method: "goal/local-command" });
        return true;
      }
    }
    if (m.type === "active_goal") {
      const value = m.value as { condition?: string; iterations?: number; last_reason?: string } | null;
      if (value?.condition && this.core.requireSession(id).goal?.lastReason !== CLOSED_REASON) this.record(id, { ...this.goal(id, value.condition), iterations: value.iterations ?? 0, ...(value.last_reason ? { lastReason: value.last_reason } : {}) });
      // A null event alone does not distinguish completion from a user clear; the journal does.
      this.refresh(id);
    }
    if (m.type === "result") {
      this.refresh(id);
      const timer = setTimeout(() => this.refresh(id), 100); timer.unref?.();
    }
    if (m.type === "stream_event" && (m.event as { type?: string } | undefined)?.type === "message_start") {
      const goal = this.core.requireSession(id).goal;
      if (goal?.status === "blocked" && goal.lastReason === CLOSED_REASON) this.record(id, this.goal(id, goal.objective));
    }
    return false;
  }

  refresh(id: Id): void {
    if (this.disposed) return;
    const session = this.core.store.getSession(id);
    if (!session?.runtimeRef) return;
    let journal = this.journals.get(id);
    if (!journal) { journal = new GoalJournal(this.core.homeOf(id).dir, session.runtimeRef); this.journals.set(id, journal); }
    try {
      for (const row of journal.read()) {
        if (this.clearing.has(id)) continue;
        // Native JSONL flush can lag behind stdout. A prior clear/evaluation must never replace a newer
        // acknowledged Goal, even when it reused the exact same condition.
        if (row.at !== undefined && row.at <= (this.acknowledgedAt.get(id) ?? -Infinity)) continue;
        if (row.sentinel) {
          const current = this.core.requireSession(id).goal;
          // The native clear acknowledgement can reach stdout before its transcript flush. Keep the paused
          // objective when that delayed user-clear sentinel arrives; it is not a native completion result.
          if (row.met) { if (!(current?.status === "paused" && current.objective === row.condition)) this.record(id, null); }
          else if (!((current?.status === "paused" || current?.lastReason === CLOSED_REASON) && current.objective === row.condition)) this.record(id, this.goal(id, row.condition));
        } else if (row.met || row.failed) {
          this.metrics.set(id, { tokens: typeof row.tokens === "number", elapsed: typeof row.durationMs === "number" });
          this.record(id, { ...this.goal(id, row.condition), status: row.met ? "complete" : "blocked", iterations: row.iterations ?? 0, tokensUsed: row.tokens ?? 0, timeUsedSeconds: Math.max(0, (row.durationMs ?? 0) / 1000), ...(row.reason ? { lastReason: row.reason } : {}) });
        }
      }
    } catch (error) { this.core.log(`could not read Claude Goal state for ${id}: ${String(error)}`); }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.polls.values()) clearInterval(timer);
    this.polls.clear();
    for (const [id, pending] of this.pending) { this.invalidate(id); pending.reject(new Error("Claude Goal 会话已关闭。")); }
    this.pending.clear();
    for (const id of this.queues.keys()) this.invalidate(id);
  }

  private localResult(id: Id, args: string, text: string, at: number): void {
    if (args && Number.isFinite(at)) this.acknowledgedAt.set(id, Math.max(at, this.acknowledgedAt.get(id) ?? 0));
    if (/^Goal set:/.test(text)) this.record(id, this.goal(id, args));
    else if (/^Goal cleared:|^No goal set/.test(text)) {
      const old = this.core.requireSession(id).goal;
      if (!this.clearing.has(id) && (old?.status === "active" || /^(clear|off)$/i.test(args))) this.record(id, null);
    } else if (/^Goal active:/.test(text)) {
      const old = this.core.requireSession(id).goal;
      if (old?.status === "blocked" && old.lastReason === CLOSED_REASON) return;
      const objective = old?.objective && text.startsWith(`Goal active: ${old.objective}`) ? old.objective : text.replace(/^Goal active:\s*/, "").replace(/\s*\((?:not yet evaluated|\d+.*)\)\s*$/, "");
      if (objective && !this.clearing.has(id)) this.record(id, { ...this.goal(id, objective), ...(old?.iterations === undefined ? {} : { iterations: old.iterations }) });
    }
  }
  private goal(id: Id, objective: string): SessionGoal {
    const s = this.core.requireSession(id), old = s.goal?.objective === objective ? s.goal : null;
    return { threadId: s.runtimeRef!, objective, status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: old?.createdAt ?? this.seconds(), updatedAt: this.seconds(), iterations: 0 };
  }
  private seconds(): number { return Math.floor(this.core.now().getTime() / 1000); }
  private record(id: Id, goal: SessionGoal | null): void {
    if (!this.core.store.getSession(id)) return;
    if (JSON.stringify(this.core.requireSession(id).goal ?? null) !== JSON.stringify(goal)) {
      this.core.updateSession(id, { goal });
      this.core.emitTransient({ type: "session.goal", sessionId: id, goal });
    }
    if (!this.disposed && goal?.status === "active" && !this.polls.has(id)) { const timer = setInterval(() => this.refresh(id), 500); timer.unref?.(); this.polls.set(id, timer); }
    if (goal?.status !== "active") { clearInterval(this.polls.get(id)); this.polls.delete(id); }
    const live = this.core.live.get(id);
    if (goal?.status !== "active" && live && !live.running) this.onSettled(id, live);
  }
  private serial<T>(id: Id, action: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).then(action, action);
    this.queues.set(id, next);
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }

  private async command(id: Id, args: string, now: boolean, check?: () => void): Promise<void> {
    this.assertOpen();
    const session = this.writable(id);
    if (session.kind === "sub") throw unsupported("Claude 子 agent 不能单独控制 Goal。");
    await this.core.closing.get(id);
    this.assertOpen();
    check?.();
    const live = this.core.ensureLive(this.writable(id));
    await withTimeout(live.ready, 15000);
    this.assertOpen();
    if (!this.supported.has(live)) this.supported.set(live, (await withTimeout(live.q.supportedCommands(), 15000)).some((command) => command.name === "goal"));
    this.assertOpen();
    if (!this.supported.get(live)) throw unsupported("当前 Claude Code 不支持原生 /goal，请先更新 Claude Code。");
    check?.();
    if (args && args !== "clear" && live.running) throw unsupported("请等当前回复结束，或先停止，再开启 Claude Goal。");
    if (this.pending.has(id)) throw unsupported("Goal 操作尚未完成，请稍后重试。");
    const uuid = randomUUID();
    let queued!: () => void;
    const atCli = new Promise<void>((resolve) => { queued = resolve; });
    let resolve!: (text: string) => void, reject!: (error: Error) => void;
    const result = new Promise<string>((ok, fail) => { resolve = ok; reject = fail; });
    // Observe rejections immediately even while Send now is waiting for the queued acknowledgement.
    void result.catch(() => undefined);
    const pending: Pending = { uuid, args, started: false, settled: result, queued, resolve, reject };
    this.pending.set(id, pending);
    const timer = setTimeout(() => reject(new Error("Claude 未及时确认 Goal 命令，请刷新状态后重试。")), 15000);
    try {
      this.core.clearIdle(live);
      if (args && args !== "clear") queueMessagePurpose(this.core.store, id, "work", live.running);
      live.push({ content: `/goal${args ? ` ${args}` : ""}`, uuid });
      // A native Goal can start a model request before the SDK reports message_start. Its clear command still
      // needs Send now in that gap, rather than waiting behind the invisible work until it completes.
      if (now) {
        await Promise.race([atCli, result.then(() => undefined)]);
        if (!pending.started) {
          live.givingWay = true;
          const request = (live.q as unknown as { request?: (input: Record<string, unknown>) => Promise<{ response?: { send_now?: unknown } } | undefined> }).request;
          try {
            if (live.capabilities.has("interrupt_send_now_v1") && request) {
              const answer = await request.call(live.q, { subtype: "interrupt", send_now: true, message_uuid: uuid });
              if (answer?.response?.send_now !== "stopped") live.givingWay = false;
            } else await live.q.interrupt();
          } catch (error) { live.givingWay = false; throw error; }
        }
      }
      await result;
    } finally { clearTimeout(timer); if (this.pending.get(id) === pending) this.pending.delete(id); }
  }
  private assertOpen(): void { if (this.disposed) throw unsupported("Claude 会话服务已关闭，Goal 操作已取消。"); }
}
