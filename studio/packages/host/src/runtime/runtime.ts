import { EventEmitter } from "node:events";
import type { ApprovalDecision, Attachment, ChatSettings, HostEvent, Id, ModelProfile, ProfileChoices, QuestionReply, Session, SessionItem, SessionOptions, SessionRuntime, SessionStatus, SlashCommandList, SlashCommandResult, Workspace, AccountUsage, McpApply, OutsideSessionList, OutsideSessionPreview } from "@amo-studio/protocol";
import { inTurn, parseRemoteProfileId, type MessagePurpose } from "@amo-studio/protocol";
import { newId, type HostEventInput, type SessionItemInput, type Store } from "../store/store.js";
import { withDelivery } from "./items.js";
import { profileGone } from "./profiles.js";
import { consumeMessagePurpose, currentMessagePurpose, queueMessagePurpose, startTurnPurpose } from "./message-purpose.js";

// What HostService needs from a runtime, and a router that sends each call to the runtime a session (or profile)
// belongs to. Codex and Claude implement the same operations; a few are runtime-specific (see the comments).

export type SendMode = "start" | "steer" | "queue";

/** `now` (立即发送, 2026-11-02): while a turn runs, the model reads the message at once (the turn's step gives way). */
export interface SendOptions {
  /** Host-only original composer text, before role/shared context is appended. */
  skillText?: string;
  now?: boolean;
  purpose?: MessagePurpose;
  /** Host-only frozen-input guard, not accepted from HTTP. */
  beforeDispatch?: () => void;
  /** Host-only routing fields for a persisted message waiting at a purpose boundary. */
  deferredItemId?: Id;
  boundaryDispatch?: boolean;
}

export interface RuntimeEvents {
  /** Every change, already persisted (except `item.delta`, which carries the last persisted seq). */
  event: [HostEvent];
  log: [string];
  /** Transport confirmed this text entered the session; this never means the agent adopted its requirements. */
  "message-delivered": [Id, string];
}

export interface SessionRuntimeApi {
  /** Host-owned dispatch guard, rechecked after native asynchronous recovery and immediately before transport. */
  setDispatchValidation?(validate: (sessionId: Id, itemId: Id) => boolean): void;
  /** `resumeFrom` (Claude only, 接续已有会话 2026-11-05): an outside Claude session the new one goes on from (a copy of it). */
  startSession(input: { taskId: Id | null; topicId: Id | null; profileId: Id; workspace: Workspace; title?: string; text?: string; skillText?: string; options?: SessionOptions; resumeFrom?: string; beforeDispatch?: () => void }): Promise<Session>;
  /** Claude only (接续已有会话, 2026-11-05): sessions started outside Studio that a new task can go on from. */
  outsideSessions?(): Promise<OutsideSessionList>;
  /** Claude only: the end of one of those, to recognise it; null when it has no conversation. */
  outsidePreview?(ref: string): Promise<OutsideSessionPreview | null>;
  /** Claude only: throws why a new session of the profile cannot go on from that outside session. */
  checkResume?(profileId: Id, ref: string): Promise<void>;
  /** Models (with efforts) and permission settings the profile's CLI offers. */
  choices(profileId: Id): Promise<ProfileChoices>;
  /** Switches the session's model, effort or permissions (Claude: at once; Codex: from the next turn). */
  setOptions(sessionId: Id, options: SessionOptions): Promise<Session>;
  /**
   * Renames the session in its runtime (Codex thread name, Claude session title), so the CLI's own resume lists show
   * it too; the stored title follows.
   */
  rename(sessionId: Id, title: string): Promise<Session>;
  /**
   * Starts a turn; while one runs, Codex steers it and Claude queues the message for the next turn. `images` go along
   * (Codex reads them from their path, Claude gets them as image blocks); `text` may be empty when there are some.
   */
  sendMessage(sessionId: Id, text: string, images?: readonly Attachment[], options?: SendOptions): Promise<{ mode: SendMode }>;
  interrupt(sessionId: Id): Promise<void>;
  /**
   * 立即发送 (2026-11-02, Claude and Codex): a message still waiting (`delivery: "waiting"`) is read by the model now —
   * the running turn gives way, as the CLIs' Send now does. Nothing when it is not waiting any more.
   */
  sendNow?(sessionId: Id, itemId: Id): Promise<void>;
  /**
   * 重新发送 a message its process never read (`delivery: "unsent"`), or one of Studio's inbox (`held`, 2026-11-04): the same
   * item goes again, with its `images`; `now` as for sendMessage.
   */
  resend?(sessionId: Id, itemId: Id, images: readonly Attachment[], options?: SendOptions): Promise<{ mode: SendMode }>;
  fork(sessionId: Id, profileId?: Id): Promise<Session>;
  archive(sessionId: Id): Promise<Session[]>;
  unarchive(sessionId: Id): Promise<Session[]>;
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Answers a pending `question` item (stage 12): the reply must fit its source (see QuestionReply). */
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void>;
  /** A subscription's quota use, for profiles that have one; null otherwise. `refresh`: ask the account now. */
  usage?(profileId: Id, refresh: boolean): Promise<AccountUsage | AccountUsage[] | null>;
  /**
   * 远程额度 (2026-11-06): what usage() last read, from memory only — never asks the account (usage(false) still does
   * for a Claude account read never before). Null when nothing was read.
   */
  cachedUsage?(profileId: Id): AccountUsage | AccountUsage[] | null;
  /** Codex only: where an attached TUI connects. */
  attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }>;
  setWriter(sessionId: Id, writer: Session["writer"]): Session;
  /** Claude only: hand the session to `claude --resume` in a terminal (Studio read-only meanwhile). */
  handoff?(sessionId: Id): Promise<{ command: string; cwd: string; env: Record<string, string> }>;
  /** Claude only: take a handed-off session back, importing what the terminal added. */
  reclaim?(sessionId: Id): Promise<Session>;
  /** The runtime's own `/` commands and skills for the session (stage 12, S12-E); Studio's are added by the Host. */
  listCommands?(sessionId: Id): Promise<SlashCommandList>;
  /** First-message discovery in the selected project; no persisted session or model prompt. */
  listProfileCommands?(profileId: Id, workspace: Workspace): Promise<SlashCommandList>;
  /** Runs one (`compact` included); see `POST /api/sessions/:id/commands`. */
  runCommand?(sessionId: Id, name: string, args: string): Promise<SlashCommandResult>;
  /** Stops a background command (Claude only). */
  stopBackground?(sessionId: Id, taskId: string): Promise<void>;
  /** Claude only (stage 15): stop the session's loop, or switch going on by itself after a usage limit. */
  setWakeChoice?(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session>;
  /** The conversation settings changed: running sessions follow where the runtime can. */
  applyChatSettings?(settings: ChatSettings): void;
  /**
   * MCP 设置 (2026-11-04): the session's MCP may have changed (its own choices, its project's, the global ones or a
   * server's): a running process takes it as the runtime can (see McpApply). Claude and DSH.
   */
  refreshMcp?(sessionId: Id): Promise<McpApply>;
  /** Claude: the MCP servers of the session's running process as it reports them now; null when none runs. */
  mcpStatus?(sessionId: Id): Promise<Array<{ name: string; status: string; error?: string; source?: string }> | null>;
  on(event: "event", listener: (e: HostEvent) => void): unknown;
  on(event: "log", listener: (line: string) => void): unknown;
  on(event: "message-delivered", listener: (sessionId: Id, text: string) => void): unknown;
}

/** The optional operations: a router made `around` one runtime offers only those that runtime has. */
const OPTIONAL = ["usage", "cachedUsage", "handoff", "reclaim", "listCommands", "listProfileCommands", "runCommand", "stopBackground", "setWakeChoice", "applyChatSettings", "refreshMcp", "mcpStatus", "outsideSessions", "outsidePreview", "checkResume"] as const;

/**
 * Routes calls to the runtime of the session, or of the profile for new sessions. The Host's own (host-process.ts) has
 * Codex, Claude and DSH; HostService registers "remote" (copies of tasks paired devices granted this computer, 远程
 * step 2) — 2026-11-05, plans/host-structure.md 8a: it used to be a wrapper around the router.
 */
export class RuntimeRouter extends EventEmitter<RuntimeEvents> implements SessionRuntimeApi {
  private context: { task: (taskId: Id) => string; session: (sessionId: Id) => string; validate: (sessionId: Id, itemId: Id) => boolean; checkStart?: (taskId: Id, freeze: boolean) => void; defer?: (sessionId: Id, text: string, images: readonly Attachment[], options: SendOptions) => Promise<{ mode: SendMode }> } | null = null;
  private readonly purposeBoundaries = new Map<Id, Id>();
  private readonly dispatching = new Map<Id, { purpose: MessagePurpose; done: Promise<void> }>();

  /** One Host-owned context assembler for every runtime, including first messages and resumed sessions. */
  setMessageContext(context: NonNullable<RuntimeRouter["context"]>): void {
    this.context = context;
    for (const runtime of [...Object.values(this.runtimes), ...(this.fallback ? [this.fallback] : [])]) runtime.setDispatchValidation?.(context.validate);
  }

  private withContext(text: string, context: string): string {
    // A queued message keeps the version it already carries, even after another version is applied to the task.
    return !context || text.includes(context) ? text : `${text}\n\n${context}`;
  }
  /** `around`: the one runtime every session and profile goes to that no registered runtime takes. */
  private fallback: SessionRuntimeApi | null = null;

  constructor(
    private readonly store: Store,
    private readonly profiles: readonly ModelProfile[],
    private readonly runtimes: Partial<Record<SessionRuntime, SessionRuntimeApi>>,
  ) {
    super();
    for (const r of Object.values(runtimes)) this.listen(r);
  }

  /**
   * A router around a single runtime (tests give HostService one, not a router): it takes every session and profile no
   * runtime registered later takes, and what it does not offer the router does not either (features ask whether the
   * runtime has an operation).
   */
  static around(store: Store, runtime: SessionRuntimeApi): RuntimeRouter {
    const router = new RuntimeRouter(store, [], {});
    router.fallback = runtime;
    router.listen(runtime);
    for (const k of OPTIONAL) if (!runtime[k]) (router as unknown as Record<string, unknown>)[k] = undefined;
    return router;
  }

  /** One more runtime, for the sessions that name it (HostService: "remote"). */
  register(name: SessionRuntime, runtime: SessionRuntimeApi): void {
    if (this.runtimes[name]) throw new Error(`the ${name} runtime is there already`);
    this.runtimes[name] = runtime;
    if (this.context) runtime.setDispatchValidation?.(this.context.validate);
    this.listen(runtime);
  }

  private listen(r: SessionRuntimeApi): void {
    r.on("event", (e) => this.emit("event", e));
    r.on("log", (line) => this.emit("log", line));
    r.on("message-delivered", (sessionId, text) => this.emit("message-delivered", sessionId, text));
  }

  private byRuntime(runtime: SessionRuntime): SessionRuntimeApi {
    const r = this.runtimes[runtime] ?? this.fallback;
    if (!r) throw new Error(`the ${runtime} runtime is not available in this Host`);
    return r;
  }

  private forSession(sessionId: Id): SessionRuntimeApi {
    const s = this.store.getSession(sessionId);
    if (!s) {
      // Around one runtime: it says what is wrong itself, as it did when it was called directly.
      if (this.fallback) return this.fallback;
      throw new Error(`session ${sessionId} not found`);
    }
    return this.byRuntime(s.runtime);
  }

  /** The runtime of a profile: its own, "remote" for a remote copy's model (remoteProfileId), or the one runtime. */
  private forProfile(profileId: Id): SessionRuntimeApi | undefined {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (profile) return this.runtimes[profile.runtime] ?? this.fallback ?? undefined;
    if (parseRemoteProfileId(profileId) && this.runtimes.remote) return this.runtimes.remote;
    return this.fallback ?? undefined;
  }

  private requireProfileRuntime(profileId: Id): SessionRuntimeApi {
    const profile = this.profiles.find((p) => p.id === profileId);
    if (profile) return this.byRuntime(profile.runtime);
    const r = this.forProfile(profileId);
    if (!r) throw new Error(`unknown profile ${profileId}`);
    return r;
  }

  /** Claude's operations that are not about one session (接续已有会话). */
  private get claude(): SessionRuntimeApi | undefined {
    return this.runtimes.claude ?? this.fallback ?? undefined;
  }

  startSession(input: Parameters<SessionRuntimeApi["startSession"]>[0]) {
    if (input.taskId) this.context?.checkStart?.(input.taskId, true);
    const context = input.taskId ? this.context?.task(input.taskId) ?? "" : "";
    const text = input.text && input.taskId ? this.withContext(input.text, context) : input.text;
    const beforeDispatch = this.frozenInputGuard(text ?? "", context, () => input.taskId ? this.context?.task(input.taskId) ?? "" : "", () => { if (input.taskId) this.context?.checkStart?.(input.taskId, false); }, input.beforeDispatch);
    return this.requireProfileRuntime(input.profileId).startSession({ ...input, ...(text !== undefined ? { text, skillText: input.skillText ?? input.text ?? "" } : {}), beforeDispatch });
  }
  sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}) {
    const taskId = this.store.getSession(sessionId)?.taskId;
    if (taskId) this.context?.checkStart?.(taskId, false);
    const context = this.context?.session(sessionId) ?? "", input = this.withContext(text, context);
    options = { ...options, skillText: options.skillText ?? text };
    const beforeDispatch = this.frozenInputGuard(input, context, () => this.context?.session(sessionId) ?? "", () => { if (taskId) this.context?.checkStart?.(taskId, false); }, options.beforeDispatch);
    const session = this.store.getSession(sessionId), purpose = options.purpose ?? "work";
    if (session?.runtime !== "remote" && (this.dispatching.has(sessionId) || this.purposeBoundaries.has(sessionId) || (session && inTurn(session.status) && purpose !== currentMessagePurpose(this.store, sessionId)))) {
      if (!this.context?.defer) throw Object.assign(new Error("当前回合用途不同，请等这一轮结束后再发送。"), { code: "conflict" });
      return this.context.defer(sessionId, input, images, { ...options, purpose });
    }
    return this.dispatchMessage(sessionId, purpose, () => this.forSession(sessionId).sendMessage(sessionId, input, images, { ...options, purpose, beforeDispatch }));
  }
  private frozenInputGuard(input: string, context: string, currentContext: () => string, checkStart: () => void, previous?: () => void): () => void {
    const tokens = (value: string) => [...value.matchAll(/^\[AMO_SHARED_CONTEXT:([^\]]+)\]\r?$/gm)].map((match) => match[1]);
    const expected = tokens(context);
    return () => {
      previous?.(); checkStart();
      const current = tokens(currentContext());
      if (JSON.stringify(current) !== JSON.stringify(expected) || tokens(input).some((token) => !current.includes(token))) throw Object.assign(new Error("共同需求要求或管理归属已变化，这次待发送输入已失效，请重新发送。"), { code: "conflict" });
    };
  }
  private prepareMessagePurpose(sessionId: Id, purpose: MessagePurpose): void {
    const session = this.store.getSession(sessionId);
    queueMessagePurpose(this.store, sessionId, purpose, !!session && inTurn(session.status));
  }
  /** An idle session may already be recovering inside an awaited native send. Reserve it before that first await. */
  private dispatchMessage(sessionId: Id, purpose: MessagePurpose, send: () => Promise<{ mode: SendMode }>): Promise<{ mode: SendMode }> {
    const owner = this.store.getSession(sessionId);
    if (!owner || owner.runtime === "remote") return send();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    let observed = inTurn(owner.status), returned = false, released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.off("event", listener);
      this.dispatching.delete(sessionId);
      finish();
      const session = this.store.getSession(sessionId);
      if (session) this.emit("event", this.store.appendEvent({ type: "session.upserted", session }));
    };
    const listener = (event: HostEvent) => {
      if (event.type !== "session.upserted" || event.session.id !== sessionId) return;
      const current = this.store.getSession(sessionId);
      // A turn row precedes setStatus(running) in Codex. Releasing there would reenter the inbox while still idle.
      if (current && (inTurn(current.status) || current.status === "error" || current.status === "interrupted" || current.status === "completed")) { observed = true; if (returned) release(); }
    };
    this.dispatching.set(sessionId, { purpose, done });
    this.on("event", listener);
    return (async () => {
      try {
        this.prepareMessagePurpose(sessionId, purpose);
        const result = await send();
        // RPC acknowledgement can precede turn/started. A second input must not race that notification either.
        returned = true;
        if (result.mode !== "start" || observed) release();
        return result;
      } catch (error) { release(); throw error; }
    })();
  }
  outsideSessions(): Promise<OutsideSessionList> {
    const r = this.claude;
    if (!r?.outsideSessions) return Promise.resolve({ sessions: [], unavailable: "这个 Studio 没有 Claude" });
    return r.outsideSessions();
  }
  outsidePreview(ref: string): Promise<OutsideSessionPreview | null> {
    const r = this.claude;
    return r?.outsidePreview ? r.outsidePreview(ref) : Promise.resolve(null);
  }
  async checkResume(profileId: Id, ref: string): Promise<void> {
    const r = this.claude;
    if (!r?.checkResume) throw Object.assign(new Error("这个 Studio 没有 Claude"), { code: "bad_request" });
    return r.checkResume(profileId, ref);
  }
  sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const item = this.store.getItem(itemId);
    if (item?.type === "user" && item.delivery === "expired") throw Object.assign(new Error(item.deliveryReason || "这条消息已过期，不能重新发送。"), { code: "conflict" });
    const r = this.forSession(sessionId);
    if (!r.sendNow) throw Object.assign(new Error("这种会话不能立即发送：消息会在这一轮结束后发出"), { code: "bad_request" });
    if (this.context && !this.context.validate(sessionId, itemId)) throw Object.assign(new Error("共同需求通知已失效，请读取当前任务的共同需求。"), { code: "conflict" });
    const taskId = this.store.getSession(sessionId)?.taskId;
    if (taskId) this.context?.checkStart?.(taskId, false);
    return r.sendNow(sessionId, itemId);
  }
  resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const r = this.forSession(sessionId);
    if (!r.resend) throw Object.assign(new Error("这种会话不能重新发送消息"), { code: "bad_request" });
    if (this.context && !this.context.validate(sessionId, itemId)) throw Object.assign(new Error("共同需求通知已失效，请读取当前任务的共同需求。"), { code: "conflict" });
    const taskId = this.store.getSession(sessionId)?.taskId;
    if (taskId) this.context?.checkStart?.(taskId, false);
    const item = this.store.getItem(itemId);
    if (item?.type === "user" && item.delivery === "expired") throw Object.assign(new Error(item.deliveryReason || "这条消息已过期，不能重新发送。"), { code: "conflict" });
    const session = this.store.getSession(sessionId);
    const pendingDispatch = session?.runtime !== "remote" ? this.dispatching.get(sessionId) : undefined;
    if (pendingDispatch) {
      if (options.now) return pendingDispatch.done.then(() => this.resend(sessionId, itemId, images, options));
      if (item?.type === "user" && item.delivery === "unsent" && this.context?.defer) return this.context.defer(sessionId, item.text, images, { ...options, purpose: item.messagePurpose ?? "work", deferredItemId: itemId });
      return Promise.resolve({ mode: "queue" });
    }
    if (session?.runtime !== "remote" && !options.boundaryDispatch && this.purposeBoundaries.has(sessionId)) return Promise.resolve({ mode: "queue" });
    if (session?.runtime !== "remote" && session && inTurn(session.status) && item?.type === "user" && item.sessionId === sessionId && (item.delivery === "held" || item.delivery === "unsent") && (item.messagePurpose ?? "work") !== currentMessagePurpose(this.store, sessionId)) {
      if (options.now) return this.crossPurposeBoundary(sessionId, itemId, images, options);
      if (item.delivery === "unsent" && this.context?.defer) return this.context.defer(sessionId, item.text, images, { ...options, purpose: item.messagePurpose ?? "work", deferredItemId: itemId });
      return Promise.resolve({ mode: "queue" });
    }
    if (item?.type === "user" && item.sessionId === sessionId && (item.delivery === "held" || item.delivery === "unsent")) {
      const text = item.text.includes("[AMO_SHARED_CONTEXT:") ? item.text : this.withContext(item.text, this.context?.session(sessionId) ?? "");
      if (text !== item.text) this.emit("event", this.store.appendEvent({ type: "item.updated", item: this.store.replaceItem({ ...item, text }) }));
    }
    const send = () => r.resend!(sessionId, itemId, images, { ...options, purpose: item?.type === "user" ? item.messagePurpose ?? "work" : options.purpose ?? "work" });
    return (item?.type === "user" && item.sessionId === sessionId && (item.delivery === "held" || item.delivery === "unsent") ? this.dispatchMessage(sessionId, item.messagePurpose ?? "work", send) : send()).catch((error: unknown) => {
      const latest = this.store.getItem(itemId);
      if (latest?.type === "user" && (latest.delivery === "held" || latest.delivery === "unsent")) this.emit("event", this.store.appendEvent({ type: "item.updated", item: this.store.replaceItem({ ...latest, delivery: "unsent", deliveryReason: error instanceof Error ? error.message : String(error) }) }));
      throw error;
    });
  }
  private async crossPurposeBoundary(sessionId: Id, itemId: Id, images: readonly Attachment[], options: SendOptions): Promise<{ mode: SendMode }> {
    this.purposeBoundaries.set(sessionId, itemId);
    let cleanup: () => void = () => undefined;
    const ended = new Promise<void>((resolve, reject) => {
      const listener = (event: HostEvent) => { if (event.type === "session.upserted" && event.session.id === sessionId && !inTurn(event.session.status)) resolve(); };
      this.on("event", listener);
      const timer = setTimeout(() => reject(Object.assign(new Error("旧回合尚未结束，消息仍在等待；请稍后重试立即发送。"), { code: "conflict" })), STOP_GRACE_MS);
      timer.unref?.();
      cleanup = () => { clearTimeout(timer); this.off("event", listener); };
      const current = this.store.getSession(sessionId); if (!current || !inTurn(current.status)) resolve();
    });
    try {
      await Promise.all([ended, this.forSession(sessionId).interrupt(sessionId)]);
      return await this.resend(sessionId, itemId, images, { ...options, now: false, boundaryDispatch: true });
    } finally {
      cleanup();
      this.purposeBoundaries.delete(sessionId);
      const session = this.store.getSession(sessionId);
      if (session) this.emit("event", this.store.appendEvent({ type: "session.upserted", session }));
    }
  }
  choices(profileId: Id) {
    return this.requireProfileRuntime(profileId).choices(profileId);
  }
  setOptions(sessionId: Id, options: SessionOptions) {
    return this.forSession(sessionId).setOptions(sessionId, options);
  }
  async usage(profileId: Id, refresh: boolean): Promise<AccountUsage | AccountUsage[] | null> {
    const r = this.forProfile(profileId);
    return r?.usage ? r.usage(profileId, refresh) : null;
  }
  cachedUsage(profileId: Id): AccountUsage | AccountUsage[] | null {
    const r = this.forProfile(profileId);
    return r?.cachedUsage ? r.cachedUsage(profileId) : null;
  }
  rename(sessionId: Id, title: string) {
    return this.forSession(sessionId).rename(sessionId, title);
  }
  interrupt(sessionId: Id) {
    return this.forSession(sessionId).interrupt(sessionId);
  }
  fork(sessionId: Id, profileId?: Id) {
    return this.forSession(sessionId).fork(sessionId, profileId);
  }
  archive(sessionId: Id) {
    return this.forSession(sessionId).archive(sessionId);
  }
  unarchive(sessionId: Id) {
    return this.forSession(sessionId).unarchive(sessionId);
  }
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision) {
    return this.forSession(sessionId).respondApproval(sessionId, approvalId, decision);
  }
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply) {
    return this.forSession(sessionId).answerQuestion(sessionId, itemId, reply);
  }
  attachInfo(sessionId: Id) {
    return this.forSession(sessionId).attachInfo(sessionId);
  }
  setWriter(sessionId: Id, writer: Session["writer"]) {
    return this.forSession(sessionId).setWriter(sessionId, writer);
  }
  handoff(sessionId: Id) {
    const r = this.forSession(sessionId);
    if (!r.handoff) throw new Error("this runtime does not hand sessions to a terminal");
    return r.handoff(sessionId);
  }
  async reclaim(sessionId: Id): Promise<Session> {
    const r = this.forSession(sessionId);
    return r.reclaim ? r.reclaim(sessionId) : r.setWriter(sessionId, "workbench");
  }
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const r = this.forSession(sessionId);
    return r.listCommands ? r.listCommands(sessionId) : { commands: [] };
  }
  async listProfileCommands(profileId: Id, workspace: Workspace): Promise<SlashCommandList> {
    const r = this.requireProfileRuntime(profileId);
    return r.listProfileCommands ? r.listProfileCommands(profileId, workspace) : { commands: [], note: "这个模型的技能列表需在会话启动后读取" };
  }
  runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const r = this.forSession(sessionId);
    if (!r.runCommand) throw new Error("this runtime has no commands");
    return r.runCommand(sessionId, name, args);
  }
  stopBackground(sessionId: Id, taskId: string): Promise<void> {
    const r = this.forSession(sessionId);
    if (!r.stopBackground) throw new Error("this runtime has no background commands");
    return r.stopBackground(sessionId, taskId);
  }
  setWakeChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    const r = this.forSession(sessionId);
    if (!r.setWakeChoice) throw new Error("this runtime has no loop");
    return r.setWakeChoice(sessionId, choice);
  }
  applyChatSettings(settings: ChatSettings): void {
    for (const r of Object.values(this.runtimes)) r.applyChatSettings?.(settings);
    this.fallback?.applyChatSettings?.(settings);
  }
  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const r = this.forSession(sessionId);
    return r.refreshMcp ? r.refreshMcp(sessionId) : "codex-restart";
  }
  async mcpStatus(sessionId: Id): Promise<Array<{ name: string; status: string; error?: string; source?: string }> | null> {
    const r = this.forSession(sessionId);
    return r.mcpStatus ? r.mcpStatus(sessionId) : null;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewItemBody = DistributiveOmit<SessionItemInput, "id" | "sessionId" | "createdAt">;

export interface NewSessionInput {
  taskId: Id | null;
  topicId: Id | null;
  parentId: Id | null;
  kind: Session["kind"];
  profileId: Id;
  workspaceId: Id;
  title: string;
  runtimeRef: string;
  options?: SessionOptions;
}

/**
 * A runtime's persistence helpers, bound, for the parts it is split into (stage 16): they write through the runtime, so
 * every change is still stored, published and emitted the same way.
 */
export interface RuntimeCore {
  readonly store: Store;
  now(): Date;
  log(line: string): void;
  messageDelivered(sessionId: Id, text: string): void;
  messagePurposeConsumed(sessionId: Id, itemId: Id, running?: boolean): void;
  requireSession(id: Id): Session;
  createSession(input: NewSessionInput): Session;
  updateSession(id: Id, patch: Parameters<Store["updateSession"]>[1]): Session;
  setStatus(id: Id, status: SessionStatus): void;
  appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem;
  updateItem(itemId: Id, fn: (item: SessionItem) => SessionItem): void;
  emitTransient(event: HostEventInput): void;
}

/** How long 停止 waits on the runtime before Studio stops waiting (each runtime's own way; see armStopGrace). */
export const STOP_GRACE_MS = 15_000;

/**
 * Shared persistence helpers (every change is stored, turned into a Host event and emitted), and what every runtime
 * does the same way (2026-11-04, plans/done/message-delivery.md: each had its own copy, a little different): whether a
 * session takes messages, archiving, settling what a cut-off turn left open, and the 停止 fallback.
 */
export abstract class RuntimeBase extends EventEmitter<RuntimeEvents> {
  private dispatchValidation: ((sessionId: Id, itemId: Id) => boolean) | null = null;
  setDispatchValidation(validate: (sessionId: Id, itemId: Id) => boolean): void { this.dispatchValidation = validate; }
  protected assertCurrentMessage(sessionId: Id, itemId: Id): void {
    const row = this.store.getItem(itemId);
    let reason = row?.type === "user" && row.delivery === "expired" ? row.deliveryReason || "这条消息已过期，不能重新发送。" : "";
    if (row?.type !== "user" || row.sessionId !== sessionId) reason = "这条待送消息已不存在或不属于当前会话。";
    if (!reason && this.dispatchValidation) {
      try { if (!this.dispatchValidation(sessionId, itemId)) reason = "这条待送消息已失效或过期，请按当前任务要求重新发送。"; }
      catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    if (!reason) return;
    if (row?.type === "user" && row.sessionId === sessionId && row.delivery !== "expired") this.updateItem(itemId, (current) => current.type === "user" && current.delivery !== "expired" ? { ...current, delivery: "expired", deliveryReason: reason, deliveryEndedAt: new Date().toISOString() } : current);
    throw Object.assign(new Error(reason), { code: "conflict" });
  }
  protected constructor(
    protected readonly store: Store,
    protected readonly runtimeName: SessionRuntime,
    protected readonly now: () => Date = () => new Date(),
    private readonly knownProfiles: readonly ModelProfile[] = [],
  ) {
    super();
  }

  /**
   * The session, when it can take a message: not archived, not handed to a terminal (Claude's 在终端打开), its model
   * channel still there (profileGone says why not), started in its runtime.
   */
  protected writable(id: Id): Session {
    const s = this.requireSession(id);
    if (s.archivedAt || s.writer === "archived") throw Object.assign(new Error("这个会话已归档，不能再发消息"), { code: "read_only" });
    if (s.writer === "terminal-handoff") throw Object.assign(new Error("这个会话交给终端了（在终端打开）：收回到 Studio 后才能在这里发消息"), { code: "read_only" });
    if (!this.knownProfiles.some((p) => p.id === s.profileId)) throw profileGone(s.profileId);
    if (!s.runtimeRef) throw new Error(`session ${id} has no ${this.runtimeName} session yet`);
    return s;
  }

  /** Archives the session with what hangs under it (branches, subagents); each runtime then closes its own. */
  protected archiveTree(sessionId: Id): Session[] {
    const changed = this.store.archiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  protected unarchiveTree(sessionId: Id): Session[] {
    const changed = this.store.unarchiveSubtree(sessionId);
    for (const s of changed) this.publish({ type: "session.upserted", session: s });
    return changed;
  }

  /**
   * What a turn cut off from outside (a Host restart, the runtime's process gone) left open, closed: the turn
   * (interrupted), streaming text, tools (failed — they may have run part way, so not 「未执行」), background commands,
   * compaction, messages the model never read (unsent: 重新发送), and with `approvals` the ones still pending
   * (resolved-elsewhere: the person did not decline them). Messages held in Studio's inbox stay: they are Studio's to
   * send. Returns whether a running turn was cut off.
   */
  protected settleLeftovers(sessionId: Id, opts: { approvals?: boolean } = {}): boolean {
    let cut = false;
    const at = this.now().toISOString();
    for (const item of this.store.listUnfinishedItems(sessionId)) {
      if (item.type === "turn" && item.state === "running") {
        cut = true;
        this.updateItem(item.id, (it) => (it.type === "turn" && it.state === "running" ? { ...it, state: "interrupted", endedAt: at } : it));
      } else if (item.type === "agent" && item.streaming) this.updateItem(item.id, (it) => (it.type === "agent" ? { ...it, streaming: false } : it));
      else if (item.type === "reasoning" && item.streaming) this.updateItem(item.id, (it) => (it.type === "reasoning" ? { ...it, streaming: false } : it));
      else if (item.type === "tool" && item.status === "running") this.updateItem(item.id, (it) => (it.type === "tool" ? { ...it, status: "failed" } : it));
      else if (item.type === "background" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "background" ? { ...it, state: "stopped" } : it));
      else if (item.type === "compaction" && item.state === "running") this.updateItem(item.id, (it) => (it.type === "compaction" ? { ...it, state: "failed" } : it));
      else if (item.type === "user" && item.delivery === "waiting") this.updateItem(item.id, (it) => (it.type === "user" ? withDelivery(it, "unsent") : it));
      else if (opts.approvals && item.type === "approval" && item.state === "pending") this.updateItem(item.id, (it) => (it.type === "approval" ? { ...it, state: "resolved-elsewhere" } : it));
    }
    return cut;
  }

  /**
   * 停止's fallback (2026-11-01 for Claude, 2026-11-04 for all): when the runtime has not ended the turn `ms` after
   * 停止 (`stillRunning`), `giveUp` ends it Studio's way (closing a process, or settling the turn here) and the session
   * says so — it is not left 正在工作 until a restart.
   */
  protected armStopGrace(sessionId: Id, ms: number, stillRunning: () => boolean, giveUp: () => void, what: string): void {
    setTimeout(() => {
      if (!stillRunning()) return;
      this.emit("log", `${sessionId}: the ${this.runtimeName} turn did not stop within ${ms} ms; ${what}`);
      giveUp();
    }, ms).unref?.();
  }

  /** The helpers for the runtime's parts; overrides (an appendItem that adds the turn) apply. */
  protected makeCore(): RuntimeCore {
    return {
      store: this.store,
      now: () => this.now(),
      log: (line) => this.emit("log", line),
      messageDelivered: (sessionId, text) => { this.emit("message-delivered", sessionId, text); },
      messagePurposeConsumed: (sessionId, itemId, running) => this.messagePurposeConsumed(sessionId, itemId, running),
      requireSession: (id) => this.requireSession(id),
      createSession: (input) => this.createSession(input),
      updateSession: (id, patch) => this.updateSession(id, patch),
      setStatus: (id, status) => this.setStatus(id, status),
      appendItem: (sessionId, body, raw) => this.appendItem(sessionId, body, raw),
      updateItem: (itemId, fn) => this.updateItem(itemId, fn),
      emitTransient: (event) => this.emitTransient(event),
    };
  }

  protected requireSession(id: Id): Session {
    const s = this.store.getSession(id);
    if (!s) throw new Error(`session ${id} not found`);
    return s;
  }

  protected createSession(input: NewSessionInput): Session {
    const s = this.store.createSession({ ...input, runtime: this.runtimeName, status: "idle", writer: "workbench" });
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  protected updateSession(id: Id, patch: Parameters<Store["updateSession"]>[1]): Session {
    const s = this.store.updateSession(id, patch);
    this.publish({ type: "session.upserted", session: s });
    return s;
  }

  protected setStatus(id: Id, status: SessionStatus): void {
    const s = this.store.getSession(id);
    if (s && s.status !== status) this.updateSession(id, { status });
  }

  protected appendItem(sessionId: Id, body: NewItemBody, raw?: { method: string; itemId?: string; turnId?: string }): SessionItem {
    const purpose = body.type === "turn" && body.state === "running" ? { messagePurpose: startTurnPurpose(this.store, sessionId, body.turnId) } : {};
    const item = this.store.appendItem({
      ...body,
      ...purpose,
      id: newId("i"),
      sessionId,
      createdAt: this.now().toISOString(),
      ...(raw ? { raw: { runtime: this.runtimeName, ...raw } } : {}),
    } as SessionItemInput);
    this.publish({ type: "item.appended", item });
    return item;
  }

  protected updateItem(itemId: Id, fn: (item: SessionItem) => SessionItem): void {
    const current = this.store.getItem(itemId);
    if (!current) return;
    const next = fn(current);
    if (next === current) return;
    this.publish({ type: "item.updated", item: this.store.replaceItem(next) });
  }

  protected messagePurposeConsumed(sessionId: Id, itemId: Id, running = true): void {
    const row = this.store.getItem(itemId), session = this.store.getSession(sessionId);
    if (row?.type !== "user" || row.delivery === "expired" || row.sessionId !== sessionId) return;
    const purpose = consumeMessagePurpose(this.store, sessionId, row.messagePurpose ?? "work", running);
    const [turn] = this.store.findItems(sessionId, "turn", { state: "running" }, { newest: true, limit: 1 });
    if (turn?.type === "turn" && turn.messagePurpose !== purpose) this.publish({ type: "item.updated", item: this.store.replaceItem({ ...turn, messagePurpose: purpose }) });
    if (session && inTurn(session.status)) this.publish({ type: "session.upserted", session });
  }

  protected publish(event: HostEventInput): HostEvent {
    const persisted = this.store.appendEvent(event);
    this.emit("event", persisted);
    return persisted;
  }

  protected emitTransient(event: HostEventInput): void {
    this.emit("event", { ...event, seq: this.store.lastEventSeq() } as HostEvent);
  }
}
