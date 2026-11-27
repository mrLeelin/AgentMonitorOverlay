import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { inTurn, type ApprovalDecision, type Attachment, type Id, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionReply, type Session, type SessionOptions, type SlashCommand, type SlashCommandList, type SlashCommandResult, type UserDelivery, type Workspace, type AccountUsage, type codex } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { codexThreadParams, profileGone, type CodexConfig } from "../profiles.js";
import { McpIdentities } from "../../mcp/identity.js";
import { botSessionPrompt, botSessionPromptKey, botTaskInstructions, isBotTask, isReadOnlyTask, newChatOptions, updatedChatOptions } from "../../features/bots/data.js";
import { LEAD_MANAGEMENT_TOOLS } from "../../mcp/names.js";
import { codexAutoCompactConfig } from "../compact.js";
import { CODEX_DEFAULT_PERMISSION, codexPermission, codexPermissions } from "../choices.js";
import { RuntimeBase, STOP_GRACE_MS, type ForkTarget, type InterruptOptions, type ReplyOnlyInput, type RuntimeEvents, type SendOptions, type SessionRuntimeApi } from "../runtime.js";
import { personsMessage, unreadDelivery, withDelivery } from "../items.js";
import { isBotConversationInput, queueMessagePurpose } from "../message-purpose.js";
import type { CodexServerHandle } from "./server-manager.js";
import { codexUsage, reviewTarget, STANDARD_TIER, toModelOption, type CodexModel, type CodexSkill, type GetAccountRateLimitsResponse } from "./account.js";
import { CodexAsks } from "./asks.js";
import { CodexEvents } from "./events.js";
import { newSessionState, type CodexCore, type SessionState } from "./state.js";
import type { SessionGoal, SessionGoalState, SessionGoalUpdate } from "@amo-studio/protocol";
import { RpcError } from "./rpc-client.js";
import { codexReplyOnly } from "./reply-only.js";
import type { BalanceAsk } from "../balance.js";
import { CodexTurnCharges } from "./turn-charges.js";

export { codexRetry, codexUsage, fastTier, reviewTarget } from "./account.js";
export { describePlan, describeReview, describeTool, inputQuestions } from "./describe.js";

// Drives Codex sessions through app-server and turns its events into Studio sessions and items.
// Behaviour follows studio/spikes/RESULTS.md: approvals are broadcast and first-answer-wins, forks must carry an explicit
// provider, parent/child links are only available when threads start, and subagent events arrive on the parent's
// connection.
// Stage 16 split the runtime: this file keeps the operations and the servers; what their notifications become is
// CodexEvents' (events.ts), approvals and questions CodexAsks' (asks.ts).

/** What the runtime needs from the server manager; CodexServerManager satisfies it, tests can fake it. */
export interface CodexServers {
  ensure(profileId: string): Promise<CodexServerHandle>;
  on(event: "ready", listener: (handle: CodexServerHandle) => void): unknown;
}

export interface CodexRuntimeOptions {
  store: Store;
  servers: CodexServers;
  profiles: readonly ModelProfile[];
  balanceFor?: (profileId: Id) => BalanceAsk | null;
  now?: () => Date;
  /** 停止 not answered by the app-server this long: Studio takes the turn as stopped (default STOP_GRACE_MS). */
  stopGraceMs?: number;
  /**
   * Tests only: fixed approval policy and sandbox for every session. Otherwise each session's permission option
   * decides (choices.ts; default "ask": outside the Windows sandbox, every command except known-safe reads waits for
   * the person — user decision 2026-10-13, spikes/RESULTS.md s9-02). Applied at thread start, on resume and on every
   * turn, so older threads and switched options follow it.
   */
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Set when app-servers have the AMO MCP: every thread then names its session to it (spikes/RESULTS.md section j). */
  identities?: McpIdentities;
  /**
   * The AMO role card for a thread about to start (2026-10-17): its developer instructions, so a Codex session knows
   * its place from the first turn, as a Claude one does from its MCP server's instructions. `roleGiven` notes that the
   * session was told (later changes then come with its next message).
   */
  roleInstructions?: (draft: { taskId: Id | null; topicId: Id | null; workspaceId: Id }) => string | undefined;
  roleGiven?: (sessionId: Id) => void;
}

/** Every change, already persisted (except `item.delta`, which carries the last persisted seq), and log lines. */
export type CodexRuntimeEvents = RuntimeEvents;

export class CodexRuntime extends RuntimeBase {
  async replyOnly(input: ReplyOnlyInput): Promise<string> {
    const profile = this.profile(input.profileId);
    const { client } = await this.options.servers.ensure(profile.id);
    return codexReplyOnly(client, profile, input);
  }

  private readonly state = new Map<Id, SessionState>();
  private readonly attached = new WeakSet<CodexServerHandle["client"]>();
  /** A connection is usable for turns only after its persisted threads have been loaded again. */
  private readonly restoring = new WeakMap<CodexServerHandle["client"], Promise<void>>();
  private readonly usageCache = new Map<Id, AccountUsage>();
  private readonly modelCache = new Map<Id, { at: number; models: ModelOption[] }>();
  private readonly listingModels = new Map<string, Promise<ModelOption[]>>();
  /** skills/list per profile and folder. */
  private readonly skillCache = new Map<string, { at: number; skills: CodexSkill[] }>();
  private readonly asks: CodexAsks;
  private readonly events: CodexEvents;
  private readonly turnCharges?: CodexTurnCharges;
  private readonly goalRevisions = new Map<Id, number>();
  private readonly goalMutations = new Map<Id, Promise<unknown>>();
  private readonly goalStopVersions = new Map<Id, number>();

  constructor(private readonly options: CodexRuntimeOptions) {
    super(options.store, "codex", options.now, options.profiles);
    const core: CodexCore = {
      ...this.makeCore(),
      sessionState: (id) => this.sessionState(id),
      knownState: (id) => this.state.get(id),
      findByThread: (threadId) => this.findByThread(threadId),
      handleFor: (profileId) => this.handleFor(profileId),
      profile: (id) => this.profile(id),
    };
    this.asks = new CodexAsks(core);
    if (options.balanceFor) this.turnCharges = new CodexTurnCharges(options.balanceFor);
    this.events = new CodexEvents(
      core,
      this.asks,
      (profileId, limits) => {
        const profile = this.options.profiles.find((p) => p.id === profileId);
        if (profile && profile.provider === null) this.usageCache.set(profile.id, codexUsage(profile, limits));
      },
      (sessionId) => void this.afterTurn(sessionId),
      this.turnCharges,
    );
    this.asks.cancelStale();
    // Sessions not running any more (the last Host stopped mid-turn): close what that turn left open.
    for (const s of this.store.listSessions()) {
      if (s.runtime === "codex" && !inTurn(s.status)) this.settleTurn(s.id, false);
    }
    options.servers.on("ready", (handle) => {
      this.attach(handle);
      void this.restore(handle).catch((err: unknown) => this.emit("log", `resubscribe failed: ${String(err)}`));
    });
  }

  /** Approvals waiting in the session (their request ids). */
  pendingApprovals(sessionId: Id): string[] {
    return this.asks.pendingApprovals(sessionId);
  }

  // ---- operations -------------------------------------------------------------------------------------------------

  /** Creates a main session in a task and starts its Codex thread; sends `text` as the first turn when given. */
  async startSession(input: Parameters<SessionRuntimeApi["startSession"]>[0]): Promise<Session> {
    const profile = this.profile(input.profileId);
    const handle = await this.handleFor(profile.id);
    const bot = isBotTask(this.store, input.taskId);
    const token = this.options.identities?.issue(bot);
    const options = newChatOptions(this.store, input.taskId, profile.id, "codex", input.options);
    const role = token && !bot ? this.options.roleInstructions?.({ taskId: input.taskId, topicId: input.topicId, workspaceId: input.workspace.id }) : undefined;
    const persona = input.developerInstructions ?? role ?? botTaskInstructions(this.store, input.taskId);
    const developerInstructions = [persona, input.botSkillPrompt].filter(Boolean).join("\n\n");
    const params = this.threadParams(profile, token);
    const cwd = input.cwd ?? input.workspace.path;
    const lead = await this.leadConfig(handle, input.taskId, cwd);
    const permissions = this.permissions(options, input.taskId);
    const started = await handle.client.request("thread/start", {
      cwd,
      ...permissions,
      ...params,
      ...(lead.config ? { config: { ...params.config, ...lead.config } } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    });
    const session = this.findByThread(started.thread.id) ?? this.createSession({
      taskId: input.taskId,
      topicId: input.topicId,
      parentId: null,
      kind: "main",
      profileId: profile.id,
      workspaceId: input.workspace.id,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      title: input.title ?? "",
      runtimeRef: started.thread.id,
      options,
    }, input.botSkillPrompt ? developerInstructions : undefined);
    if (lead.config && permissions.sandbox === "read-only" && permissions.approvalPolicy === "never") this.store.setKv(`codex-lead-readonly:${session.id}`, started.thread.id);
    if (token) this.options.identities!.bind(token, session.id);
    if (role) this.options.roleGiven?.(session.id);
    if (input.text) await this.sendMessage(session.id, input.text, [], { beforeDispatch: input.beforeDispatch, ...(input.skillText !== undefined ? { skillText: input.skillText } : {}) });
    return this.store.getSession(session.id)!;
  }

  /**
   * Starts a turn, or steers the running one; images go as `localImage` input (app-server reads the file). A steered
   * message shows at once as `waiting` (2026-11-02: before, it showed only once read, and a 停止 before that lost it
   * unseen); `now` (立即发送) then makes the turn give way to it.
   */
  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: "start" | "steer" }> {
    return this.send(sessionId, text, images, [], options);
  }

  /** `extra`: more input (a skill); `again`: the row of a message sent again (重新发送), reused instead of a new one. */
  private async send(sessionId: Id, text: string, images: readonly Attachment[], extra: readonly codex.v2.UserInput[], options: SendOptions = {}, again?: Id): Promise<{ mode: "start" | "steer" }> {
    return this.withGoalMutation(sessionId, () => this.sendUnlocked(sessionId, text, images, extra, options, again));
  }

  private async sendUnlocked(sessionId: Id, text: string, images: readonly Attachment[], extra: readonly codex.v2.UserInput[], options: SendOptions, again?: Id): Promise<{ mode: "start" | "steer" }> {
    const session = this.writable(sessionId);
    this.checkGoalPurpose(session, options.purpose);
    this.requireLeadThread(session);
    const handle = await this.handleFor(session.profileId);
    this.requireLeadThread(this.writable(sessionId));
    this.checkGoalPurpose(this.requireSession(sessionId), options.purpose);
    options.beforeDispatch?.();
    if (again) this.assertCurrentMessage(sessionId, again);
    const st = this.sessionState(sessionId);
    // Mentions inserted by either composer must carry the same native skill input as /skill commands.
    // RuntimeRouter supplies the original composer text; examples in appended role/business data are not selections.
    const skillText = options.skillText ?? (again ? "" : text.split(/\r?\n\r?\n(?=\[AMO_SHARED_CONTEXT:)/, 1)[0]!);
    const names = new Set([...skillText.matchAll(/(?:^|\s)\$([A-Za-z0-9][\w:.-]*)/g)].map((match) => match[1]!));
    const firstSkill = /^\s*\/([A-Za-z0-9][\w:.-]*)(?:\s|$)/.exec(skillText)?.[1];
    if (firstSkill) names.add(firstSkill);
    const mentioned: codex.v2.UserInput[] = [];
    if (names.size) {
      const supplied = new Set(extra.flatMap((input) => input.type === "skill" ? [input.name] : []));
      for (const skill of await this.skills(session).catch(() => [])) {
        if (names.has(skill.name) && !supplied.has(skill.name)) { mentioned.push({ type: "skill", name: skill.name, path: skill.path }); supplied.add(skill.name); }
      }
    }
    const input: codex.v2.UserInput[] = [...(text ? [{ type: "text" as const, text, text_elements: [] }] : []), ...images.map((a) => ({ type: "localImage" as const, path: a.path })), ...extra, ...mentioned];
    if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
    // The person's next message is the answer to request_user_input_async (the card, or typed by hand) — theirs only
    // (2026-11-17): one the inbox brought from an agent or Studio closed the card as answered while nobody had.
    if (!again || personsMessage(this.store.getItem(again))) this.asks.closeAsync(sessionId);
    const setDelivery = (itemId: Id, delivery: UserDelivery | undefined) => this.updateItem(itemId, (it) => (it.type === "user" ? withDelivery(it, delivery) : it));
    let row = again;
    if (st.activeTurnId) {
      // Studio's row from the start; Codex echoes the id back with the message once it read it (events.ts).
      const clientId = randomUUID();
      if (row) setDelivery(row, "waiting");
      else {
        const pictures = images.map((a) => ({ id: a.id, path: a.path }));
        row = this.appendItem(sessionId, { type: "user", text, ...(options.purpose ? { messagePurpose: options.purpose } : {}), ...(pictures.length ? { images: pictures } : {}), delivery: "waiting" }, { method: "user/steer", turnId: st.activeTurnId }).id;
      }
      const entry = { itemId: row, kind: "steer" as const, input };
      st.sent.set(clientId, entry);
      try {
        this.assertCurrentMessage(sessionId, row);
        options.beforeDispatch?.();
        await handle.client.request("turn/steer", { threadId: session.runtimeRef!, expectedTurnId: st.activeTurnId, input, clientUserMessageId: clientId });
        // An async question answered while its turn still runs: the session runs again (unless something else waits).
        if (this.store.getSession(sessionId)?.status === "awaiting-answer") this.asks.afterAnswer(sessionId);
        if (options.now) await this.sendNow(sessionId, row);
        return { mode: "steer" };
      } catch (err) {
        // The turn ended meanwhile and afterTurn took the message on to the next turn: it is on its way.
        if (st.sent.get(clientId) !== entry) return { mode: "start" };
        st.sent.delete(clientId);
        // The turn ended as the message went out (its turn/completed not handled yet): it starts the next turn instead
        // of failing (2026-10-21: "turn/steer: no active turn to steer").
        if (!/no active turn/i.test(err instanceof Error ? err.message : String(err))) {
          setDelivery(row, "unsent");
          throw err;
        }
      }
    }
    // A row shown already goes with an id, so its echo settles it rather than adding another.
    const clientId = row ? randomUUID() : undefined;
    if (row && clientId) {
      st.sent.set(clientId, { itemId: row, kind: "start", input });
    }
    // Status and the active turn come from turn/started and turn/completed: a short turn can finish before this
    // response arrives, so setting them here would leave the session stuck in "running".
    try {
      const tier = await this.serviceTier(session);
      this.requireLeadThread(this.writable(sessionId));
      if (row) { this.assertCurrentMessage(sessionId, row); setDelivery(row, undefined); }
      options.beforeDispatch?.();
      const purpose = options.purpose ?? "work";
      queueMessagePurpose(this.store, sessionId, purpose, false, !!row && isBotConversationInput(this.store.getItem(row)));
      await handle.client.request("turn/start", { threadId: session.runtimeRef!, input, ...(clientId ? { clientUserMessageId: clientId } : {}), ...this.turnOptions(this.requireSession(sessionId).options, session.taskId, purpose), ...tier });
    } catch (err) {
      if (row && clientId) {
        st.sent.delete(clientId);
        setDelivery(row, "unsent");
      }
      throw err;
    }
    return { mode: "start" };
  }

  /**
   * 立即发送 (2026-11-02): Codex reads a steered message at its next step — while a command runs, only once it is done.
   * As the TUI's "press esc to interrupt and send immediately": the turn is interrupted, and the messages it did not
   * read go on as the next turn (afterTurn).
   */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    const session = this.writable(sessionId);
    const st = this.sessionState(sessionId);
    const waiting = [...st.sent.values()].some((m) => m.itemId === itemId && m.kind === "steer");
    if (!waiting || !st.activeTurnId || !session.runtimeRef) return;
    const handle = await this.handleFor(session.profileId);
    this.assertCurrentMessage(sessionId, itemId);
    await handle.client.request("turn/interrupt", { threadId: session.runtimeRef, turnId: st.activeTurnId });
  }

  /** 重新发送 (2026-11-02): a message Codex never read goes again, as the same row; also a held one of Studio's inbox. */
  async resend(sessionId: Id, itemId: Id, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: "start" | "steer" }> {
    this.writable(sessionId);
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId) throw Object.assign(new Error(`message ${itemId} not found`), { code: "not_found" });
    if (item.delivery !== "unsent" && item.delivery !== "held") return { mode: this.sessionState(sessionId).activeTurnId ? "steer" : "start" };
    return this.send(sessionId, item.text, images, [], options, itemId);
  }

  /**
   * A turn ended with steered messages it never read (stopped, given way to 立即发送, or ended as they came): Codex has
   * dropped them, so they go on as the next turn, as the TUI does — the first starts it, the rest are steered into it.
   * 2026-11-02, the user: a message waiting when 停止 is pressed is sent, not lost (as the Claude Code CLI does too).
   * The person's messages only (2026-11-17): one the inbox brought (a 传话, an answer…) goes back to it, held, and is
   * sent by its rules — after 停止, with the person's next message; before, it started the stopped session again.
   */
  private async afterTurn(sessionId: Id): Promise<void> {
    return this.withGoalMutation(sessionId, () => this.afterGoalTurn(sessionId));
  }

  private async afterGoalTurn(sessionId: Id): Promise<void> {
    const st = this.sessionState(sessionId);
    const steered = [...st.sent].filter(([, m]) => m.kind === "steer");
    if (!steered.length) return;
    for (const [clientId] of steered) st.sent.delete(clientId);
    const left = steered.filter(([, m]) => {
      if (personsMessage(this.store.getItem(m.itemId))) return true;
      this.updateItem(m.itemId, (it) => (it.type === "user" ? withDelivery(it, "held") : it));
      return false;
    });
    if (!left.length) return;
    const lost = (from: number) => {
      for (const [, m] of left.slice(from)) this.updateItem(m.itemId, (it) => (it.type === "user" ? withDelivery(it, "unsent") : it));
    };
    const session = this.store.getSession(sessionId);
    if (!session?.runtimeRef || session.archivedAt || session.writer !== "workbench") return lost(0);
    try { this.requireLeadThread(session); } catch { return lost(0); }
    const [firstId, first] = left[0]!;
    // The rest stay waiting (fresh entries, so a later afterTurn taking them on is seen): steered into the new turn
    // below, or on to the one after it when that turn ends first (its afterTurn).
    const rest = left.slice(1).map(([clientId, m]) => [clientId, { ...m }] as const);
    st.sent.set(firstId, { ...first, kind: "start" });
    for (const [clientId, m] of rest) st.sent.set(clientId, m);
    let handle: CodexServerHandle;
    try {
      handle = await this.handleFor(session.profileId);
      const tier = await this.serviceTier(session);
      this.requireLeadThread(this.writable(sessionId));
      this.assertCurrentMessage(sessionId, first.itemId);
      const firstRow = this.store.getItem(first.itemId);
      this.checkGoalPurpose(this.requireSession(sessionId), firstRow?.type === "user" ? firstRow.messagePurpose : undefined);
      queueMessagePurpose(this.store, sessionId, firstRow?.type === "user" ? firstRow.messagePurpose ?? "work" : "work", false, isBotConversationInput(firstRow));
      this.updateItem(first.itemId, (it) => (it.type === "user" ? withDelivery(it, undefined) : it));
      await handle.client.request("turn/start", { threadId: session.runtimeRef, input: first.input, clientUserMessageId: firstId, ...this.turnOptions(this.requireSession(sessionId).options, session.taskId, firstRow?.type === "user" ? firstRow.messagePurpose ?? "work" : "work"), ...tier });
    } catch (err) {
      this.emit("log", `could not send the unread messages of ${sessionId}: ${String(err)}`);
      for (const [clientId] of left) st.sent.delete(clientId);
      return lost(0);
    }
    for (const [clientId, m] of rest) {
      if (st.sent.get(clientId) !== m) continue;
      // The new turn is over already (a short one): what is left starts the next.
      if (!st.activeTurnId) return void this.afterTurn(sessionId);
      try {
        this.assertCurrentMessage(sessionId, m.itemId);
        await handle.client.request("turn/steer", { threadId: session.runtimeRef, expectedTurnId: st.activeTurnId, input: m.input, clientUserMessageId: clientId });
      } catch {
        if (!st.activeTurnId && st.sent.get(clientId) === m) void this.afterTurn(sessionId);
        return;
      }
    }
  }

  /** Switches model, effort or permissions; Codex applies them from the next turn (a running turn keeps its own). */
  /** Options go with the next turn; 完全访问 also accepts what the running turn is waiting for (asks.ts). */
  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    return this.withGoalMutation(sessionId, async () => {
      const session = this.requireSession(sessionId);
      options = updatedChatOptions(this.store, session, options);
      // Serialize even the first Goal activation with option edits: neither may capture the other's old permissions.
      if (session.goal) {
        const handle = await this.handleFor(session.profileId);
        await this.syncGoalSettings(handle, { ...this.writable(sessionId), options });
      }
      const updated = this.updateSession(sessionId, { options });
      if (options.permission === "full-auto") await this.asks.acceptAll(sessionId);
      return updated;
    });
  }

  async getGoal(sessionId: Id): Promise<SessionGoalState> {
    const s = this.requireSession(sessionId);
    if (s.runtime !== "codex") return { goal: null, unavailable: "这个 Agent 尚未接入原生 Goal。" };
    if (s.kind === "sub") return { goal: null, unavailable: "Codex 子 agent 的生命周期由父会话管理，不能单独控制 Goal。" };
    if (!s.runtimeRef) return { goal: null, unavailable: "Codex 会话尚未建立。" };
    return this.readGoal(await this.handleFor(s.profileId), s);
  }

  setGoal(sessionId: Id, input: SessionGoalUpdate, beforeDispatch?: () => void): Promise<SessionGoalState> {
    if (input.roundBudget !== undefined) return Promise.reject(Object.assign(new Error("Codex Goal 不支持续跑轮数上限，请使用 Token 预算。"), { code: "bad_request" }));
    const stopVersion = this.goalStopVersions.get(sessionId) ?? 0;
    const check = () => {
      if (input.status !== "paused" && stopVersion !== (this.goalStopVersions.get(sessionId) ?? 0)) throw Object.assign(new Error("会话已停止，这次待开启的 Goal 已取消。"), { code: "bad_request" });
      beforeDispatch?.();
    };
    return this.withGoalMutation(sessionId, async () => {
      check();
      let s = this.goalWritable(sessionId);
      const handle = await this.handleFor(s.profileId);
      s = this.goalWritable(sessionId);
      check();
      if (input.status !== "paused") {
        await this.syncGoalSettings(handle, s);
        this.goalWritable(sessionId);
        check();
        queueMessagePurpose(this.store, sessionId, "work", inTurn(this.requireSession(sessionId).status) && !this.betweenTurns(sessionId));
      }
      const revision = this.goalRevisions.get(sessionId) ?? 0;
      const result = await handle.client.request("thread/goal/set", { threadId: s.runtimeRef!, ...input, origin: "user" });
      if ((this.goalRevisions.get(sessionId) ?? 0) === revision) this.recordGoal(sessionId, result.goal);
      return { goal: this.requireSession(sessionId).goal ?? null };
    });
  }

  clearGoal(sessionId: Id): Promise<SessionGoalState> {
    return this.withGoalMutation(sessionId, async () => {
      const s = this.goalWritable(sessionId), handle = await this.handleFor(s.profileId);
      this.goalWritable(sessionId);
      const revision = this.goalRevisions.get(sessionId) ?? 0;
      await handle.client.request("thread/goal/clear", { threadId: s.runtimeRef!, origin: "user" });
      if ((this.goalRevisions.get(sessionId) ?? 0) === revision) this.recordGoal(sessionId, null);
      return { goal: this.requireSession(sessionId).goal ?? null };
    });
  }

  private goalWritable(sessionId: Id): Session {
    const s = this.writable(sessionId);
    if (s.runtime !== "codex") throw Object.assign(new Error("这个 Agent 尚未接入原生 Goal。"), { code: "bad_request" });
    if (s.kind === "sub") throw Object.assign(new Error("Codex 子 agent 的生命周期由父会话管理，不能单独控制 Goal。"), { code: "bad_request" });
    this.requireLeadThread(s);
    return s;
  }

  private checkGoalPurpose(session: Session, purpose?: SendOptions["purpose"]): void {
    if (session.goal?.status === "active" && (purpose === "inquiry" || purpose === "notification")) throw Object.assign(new Error("Goal 正在持续执行，请先暂停续跑，再发起只读询问或通知。"), { code: "bad_request" });
  }

  private withGoalMutation<T>(sessionId: Id, operation: () => Promise<T>): Promise<T> {
    const next = (this.goalMutations.get(sessionId) ?? Promise.resolve()).then(operation, operation);
    this.goalMutations.set(sessionId, next);
    void next.finally(() => { if (this.goalMutations.get(sessionId) === next) this.goalMutations.delete(sessionId); }).catch(() => undefined);
    return next;
  }

  private recordGoal(sessionId: Id, goal: SessionGoal | null): void {
    this.goalRevisions.set(sessionId, (this.goalRevisions.get(sessionId) ?? 0) + 1);
    const s = this.store.getSession(sessionId);
    if (!s || (goal && goal.threadId !== s.runtimeRef)) return;
    if (JSON.stringify(s.goal ?? null) !== JSON.stringify(goal)) this.updateSession(sessionId, { goal });
    this.publish({ type: "session.goal", sessionId, goal });
  }

  private async readGoal(handle: CodexServerHandle, session: Session): Promise<SessionGoalState> {
    const revision = this.goalRevisions.get(session.id) ?? 0;
    try {
      const result = await handle.client.request("thread/goal/get", { threadId: session.runtimeRef! }, { timeoutMs: 5000 });
      if ((this.goalRevisions.get(session.id) ?? 0) === revision) this.recordGoal(session.id, result.goal);
      return { goal: this.requireSession(session.id).goal ?? null };
    } catch (err) {
      if ((err instanceof RpcError && err.code === -32601) || /goals feature is disabled|does not support goals/i.test(String(err))) {
        this.recordGoal(session.id, null);
        return { goal: null, unavailable: "当前 Codex CLI 未提供 Goal，或尚未启用 Goals 功能。" };
      }
      throw err;
    }
  }

  private async syncGoalSettings(handle: CodexServerHandle, session: Session): Promise<void> {
    const choices = await this.choices(session.profileId);
    const model = session.options.model ? choices.models.find((m) => m.id === session.options.model) : choices.models.find((m) => m.isDefault);
    const options = { ...session.options, ...(model ? { model: model.id, effort: session.options.effort ?? model.defaultEffort } : {}) };
    const { summary: _summary, ...settings } = this.turnOptions(options, session.taskId);
    await handle.client.updateThreadSettings({ threadId: session.runtimeRef!, ...settings, ...(await this.serviceTier(session)) });
  }

  /** Stopping or archiving is also a request to stop the next automatic Goal round. */
  private async pauseGoal(sessionId: Id): Promise<void> {
    // Stop takes precedence over queued settings/activation, including a settings RPC still awaiting its event.
    this.goalStopVersions.set(sessionId, (this.goalStopVersions.get(sessionId) ?? 0) + 1);
    const s = this.requireSession(sessionId);
    // Native children may exist only as parent activity; like resume/archive, Goal control belongs to the parent.
    if (s.kind === "sub") return;
    if (!s.runtimeRef) return;
    const handle = await this.handleFor(s.profileId);
    const state = await this.readGoal(handle, s);
    if (state.goal?.status !== "active") return;
    const result = await handle.client.request("thread/goal/set", { threadId: s.runtimeRef, status: "paused", origin: "user" }, { timeoutMs: 5000 });
    this.recordGoal(sessionId, result.goal);
  }

  /**
   * The ChatGPT login's quota (the profile with no provider of its own): `account/rateLimits/read`, kept up to date by
   * `account/rateLimits/updated`. Without `refresh` only what was read before (no app-server is started for it).
   */
  async usage(profileId: Id, refresh: boolean): Promise<AccountUsage | null> {
    const profile = this.profile(profileId);
    if (profile.provider !== null) return null;
    if (refresh) {
      try {
        const handle = await this.handleFor(profileId);
        const r = (await handle.client.request("account/rateLimits/read", { excludeResetCreditDetails: true })) as unknown as GetAccountRateLimitsResponse;
        this.usageCache.set(profileId, codexUsage(profile, r.rateLimits));
      } catch (err) {
        this.usageCache.set(profileId, { profileId, label: profile.label, windows: [], note: `读不到用量：${String((err as Error).message ?? err)}`, updatedAt: new Date().toISOString() });
      }
    }
    return this.usageCache.get(profileId) ?? { profileId, label: profile.label, windows: [], note: "展开刷新后显示", updatedAt: null };
  }

  /** 远程额度 (2026-11-06): only what was read before (account/rateLimits/updated, or a refresh). */
  cachedUsage(profileId: Id): AccountUsage | null {
    return this.usageCache.get(profileId) ?? null;
  }

  /** `thread/name/set`: the name the TUI and `codex resume` show as well. */
  async rename(sessionId: Id, title: string): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.runtimeRef) {
      const handle = await this.handleFor(session.profileId);
      await handle.client.request("thread/name/set", { threadId: session.runtimeRef, name: title });
    }
    return this.updateSession(sessionId, { title });
  }

  /** Models (from the profile's app-server, `model/list`) and permission settings. */
  async choices(profileId: Id): Promise<ProfileChoices> {
    const profile = this.profile(profileId);
    // Keyed by the profile's own model too: a channel's model changed in 设置 → 模型 is the default at once.
    const cacheKey = `${profileId}|${profile.model ?? ""}`;
    const cached = this.modelCache.get(cacheKey);
    // An older list is answered at once and asked again behind it (2026-10-23: 开始 and 新会话 waited for it).
    if (cached && Date.now() - cached.at >= 10 * 60_000) this.listModels(profile, cacheKey).catch((err: unknown) => this.emit("log", `could not list the models of ${profileId}: ${String(err)}`));
    const models = cached ? cached.models : await this.listModels(profile, cacheKey);
    return { profileId, models, permissions: codexPermissions(), defaultPermission: CODEX_DEFAULT_PERMISSION, source: "cli" };
  }

  /** The profile's models from its app-server (`model/list`) into the cache; one ask at a time per key. */
  private listModels(profile: ModelProfile, cacheKey: string): Promise<ModelOption[]> {
    let asking = this.listingModels.get(cacheKey);
    if (!asking) {
      asking = (async () => {
        const handle = await this.handleFor(profile.id);
        const r = (await handle.client.request("model/list", { includeHidden: false })) as unknown as { data: CodexModel[] };
        const models = r.data.map((m) => toModelOption(m, profile));
        // A profile pinned to a model the list does not show (hidden, or a custom catalog) still offers it.
        if (profile.model && !models.some((m) => m.id === profile.model)) models.unshift({ id: profile.model, label: profile.model, efforts: [], isDefault: true });
        this.modelCache.set(cacheKey, { at: Date.now(), models });
        return models;
      })().finally(() => this.listingModels.delete(cacheKey));
      this.listingModels.set(cacheKey, asking);
    }
    return asking;
  }

  /**
   * 等待回答 with no turn running: request_user_input_async questions a finished turn left open (events.ts,
   * turn/completed). The router lets a message start the next turn then (2026-11-17, the Free 主控).
   */
  betweenTurns(sessionId: Id): boolean {
    // A turn row still running is a turn this Host took over after a restart: activeTurnId comes only with turn/started.
    return this.store.getSession(sessionId)?.status === "awaiting-answer" && !this.sessionState(sessionId).activeTurnId && !this.asks.waiting(sessionId) && !this.store.findItems(sessionId, "turn", { state: "running" }, { limit: 1 }).length;
  }

  /**
   * A message can join the running turn: it is one this Host follows (turn/started gave its id), so turn/steer has it —
   * not a review or a compaction, which Codex keeps to themselves (activeTurnNotSteerable, 2026-11-17).
   */
  steerable(sessionId: Id): boolean {
    const st = this.sessionState(sessionId);
    return !!st.activeTurnId && !st.reviewTurns.has(st.activeTurnId) && !st.compacting;
  }

  async interrupt(sessionId: Id, options: InterruptOptions = {}): Promise<void> {
    const session = this.requireSession(sessionId);
    // Pause even between native rounds, when there is temporarily no activeTurnId.
    let pauseError: unknown;
    if (!options.expectedTurnId) {
      try { await this.pauseGoal(sessionId); } catch (err) { pauseError = err; }
    }
    const st = this.sessionState(sessionId);
    if (options.expectedTurnId && st.activeTurnId !== options.expectedTurnId) return;
    if (!st.activeTurnId || !session.runtimeRef) {
      // No turn to stop, but still 等待回答 for async questions (2026-11-17: the Free 主控's 停止 found nothing and it
      // waited on): the person stops waiting.
      if (options.person && this.betweenTurns(sessionId)) this.asks.endAsyncWait(sessionId);
      if (pauseError) throw pauseError;
      return;
    }
    this.asks.cancelQuestionsOf(sessionId);
    // The person stops waiting for this turn's async questions too (2026-11-17: once the turn stopped, the open card put
    // the session back to 等待回答 until a second 停止). Not when 立即发送 makes the turn give way: they are still asked.
    if (options.person && this.asks.openAsync(sessionId).length) {
      this.asks.dismissAsync(sessionId);
      this.asks.afterAnswer(sessionId);
    }
    // 停止's fallback (2026-11-04, plans/done/message-delivery.md): the app-server is shared by the channel's sessions, so it
    // is not closed; the turn is taken as stopped here, and what the turn had not read becomes 没送到.
    const turnId = st.activeTurnId;
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    this.armStopGrace(sessionId, grace, () => this.state.get(sessionId)?.activeTurnId === turnId, () => {
      st.activeTurnId = null;
      this.settleTurn(sessionId, false);
      this.appendItem(sessionId, { type: "notice", level: "warning", message: `点了停止 ${Math.round(grace / 1000)} 秒后 Codex 还没停下，Studio 不再等它，把这一轮记成已停止。发一条消息即可接着对话；还不行的话重启 Studio。` });
      this.setStatus(sessionId, "idle");
    }, "taking it as stopped");
    const handle = await this.handleFor(session.profileId);
    try { await handle.client.request("turn/interrupt", { threadId: session.runtimeRef, turnId }); }
    catch (err) { if (!/no active turn|turn not found/i.test(String(err))) throw err; }
    if (pauseError) throw new Error(`当前回复已请求停止，但 Goal 续跑状态未能确认：${String(pauseError)}`);
  }

  /** Forks with an explicit provider so the fork never falls back to the server default. */
  async fork(sessionId: Id, profileId?: Id, target?: ForkTarget): Promise<Session> {
    const parent = this.requireSession(sessionId);
    this.requireLeadThread(parent);
    if (!parent.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const profile = this.profile(profileId ?? parent.profileId);
    const handle = await this.handleFor(parent.profileId);
    const token = this.options.identities?.issue(isBotTask(this.store, parent.taskId));
    const cwd = target?.cwd ?? parent.cwd;
    const lead = await this.leadConfig(handle, parent.taskId, cwd ?? this.store.getWorkspace(parent.workspaceId)?.path);
    const permissions = this.permissions(parent.options, parent.taskId);
    const params = this.threadParams(profile, token);
    const storedPrompt = botSessionPrompt(this.store, parent.id);
    const forkPrompt = storedPrompt && (profile.id !== parent.profileId || cwd !== parent.cwd) ? botTaskInstructions(this.store, parent.taskId) : storedPrompt;
    const release = this.events.holdForks(parent.runtimeRef);
    let created: string | undefined;
    try {
      const r = await handle.client.request("thread/fork", {
        threadId: parent.runtimeRef, ...params, ...permissions,
        ...(target ? { lastTurnId: target.lastTurnId } : {}),
        ...(cwd ? { cwd } : {}),
        ...(forkPrompt ? { developerInstructions: forkPrompt } : {}),
        ...(lead.config ? { config: { ...params.config, ...lead.config } } : {}),
      });
      created = r.thread.id;
      if (cwd && (!r.cwd || relative(cwd, r.cwd))) throw new Error("Codex 没有在所选工作目录创建分支。");
      if (target) {
        const last = r.thread.turns.at(-1) ?? (await handle.client.request("thread/turns/list", { threadId: created, limit: 1, sortDirection: "desc" })).data[0];
        if (last?.id !== target.lastTurnId) throw new Error("Codex 未能从这轮回复创建分支，请更新 Codex 后重试。");
      }
      if (this.requireSession(sessionId).archivedAt) throw new Error("原会话已归档，请恢复后重试。");
      const fork = this.events.adoptThread(r.thread, parent, "fork", parent.profileId);
      if (forkPrompt) this.store.setKv(botSessionPromptKey(fork.id), forkPrompt);
      if (lead.config && permissions.sandbox === "read-only" && permissions.approvalPolicy === "never") this.store.setKv(`codex-lead-readonly:${fork.id}`, r.thread.id);
      if (token) this.options.identities!.bind(token, fork.id);
      return fork;
    } catch (err) {
      if (created && !this.findByThread(created)) {
        await handle.client.request("thread/archive", { threadId: created }).catch((archiveError: unknown) => this.emit("log", `could not archive failed fork ${created}: ${String(archiveError)}`));
      }
      throw err;
    } finally {
      release(created);
    }
  }

  /** Archives the session with its forks and subagents, and archives their threads. */
  async archive(sessionId: Id): Promise<Session[]> {
    const ids = new Set<Id>([sessionId]);
    const all = this.store.listSessions();
    for (let oldSize = -1; oldSize !== ids.size;) {
      oldSize = ids.size;
      for (const s of all) if (s.parentId && ids.has(s.parentId)) ids.add(s.id);
    }
    for (const id of ids) if (!this.store.getSession(id)?.archivedAt) await this.pauseGoal(id);
    const changed = this.archiveTree(sessionId);
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/archive", { threadId: s.runtimeRef });
      } catch (err) {
        this.emit("log", `thread/archive failed for ${s.id}: ${String(err)}`);
      }
    }
    return changed;
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    const changed = this.unarchiveTree(sessionId);
    for (const s of changed) {
      if (!s.runtimeRef || s.kind === "sub") continue;
      try {
        const handle = await this.handleFor(s.profileId);
        await handle.client.request("thread/unarchive", { threadId: s.runtimeRef });
        await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...(await this.resumeConfig(handle, s)), ...this.permissions(s.options, s.taskId) });
        await this.readGoal(handle, s);
      } catch (err) {
        this.emit("log", `thread/unarchive failed for ${s.id}: ${String(err)}`);
      }
    }
    return changed;
  }

  /** Answers a pending approval. Throws if it was already answered here or elsewhere. */
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.asks.respondApproval(sessionId, approvalId, decision);
  }

  /** Answers request_user_input or an MCP form (see CodexAsks). */
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    return this.asks.answerQuestion(sessionId, itemId, reply);
  }

  // ---- CLI features (stage 12, S12-E) -------------------------------------------------------------------------------

  /**
   * Codex has no command line in app-server: its `/` commands are requests. Offered: review mode (review/start) and the
   * project's skills (skills/list); `compact` is Studio's own and maps to thread/compact/start.
   */
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    const session = this.requireSession(sessionId);
    const workspace = this.store.getWorkspace(session.workspaceId);
    return workspace ? this.commandsFor(session.profileId, session.cwd ? { ...workspace, path: session.cwd } : workspace, true) : { commands: [] };
  }

  async listProfileCommands(profileId: Id, workspace: Workspace, botSkills = false): Promise<SlashCommandList> {
    return this.commandsFor(profileId, workspace, false, botSkills);
  }

  private async commandsFor(profileId: Id, workspace: Workspace, review: boolean, botSkills = false): Promise<SlashCommandList> {
    this.profile(profileId);
    const commands: SlashCommand[] = review ? [
      {
        name: "code-review",
        description: "让 Codex 审查改动：默认审查未提交的改动，也可以写 base <分支>、commit <提交> 或你的审查要求",
        argumentHint: "[base <分支> | commit <提交> | 要求]",
        group: "runtime",
      },
    ] : [];
    try {
      for (const skill of await this.profileSkills(profileId, workspace.path, botSkills)) {
        commands.push({ name: skill.name, description: (skill.shortDescription || skill.description).replace(/\s+/g, " ").trim(), group: "skill", skillPath: skill.path,
          ...(botSkills && skill.pluginId ? { skillPluginId: skill.pluginId } : {}), ...(botSkills && skill.scope ? { skillScope: skill.scope === "repo" ? "project" : "global" } : {}), ...(botSkills && skill.enabled === false ? { skillDisabled: true } : {}) });
      }
      return { commands };
    } catch (err) {
      this.emit("log", `skills/list failed for ${profileId}: ${String(err)}`);
      return { commands, note: `读不到 Codex 的 skills：${String((err as Error).message ?? err)}` };
    }
  }

  private async skills(session: Session): Promise<CodexSkill[]> {
    const cwd = session.cwd ?? this.store.getWorkspace(session.workspaceId)?.path;
    if (!cwd) return [];
    return this.profileSkills(session.profileId, cwd);
  }

  private async profileSkills(profileId: Id, cwd: string, botSkills = false): Promise<CodexSkill[]> {
    const key = `${profileId}|${cwd}`;
    const cached = this.skillCache.get(key);
    if (!botSkills && cached && Date.now() - cached.at < 60_000) return cached.skills;
    const handle = await this.handleFor(profileId);
    const r = (await handle.client.request("skills/list", { cwds: [cwd], ...(botSkills ? { forceReload: true } : {}) })) as unknown as { data: Array<{ skills: CodexSkill[] }> };
    const skills = r.data.flatMap((e) => e.skills);
    const enabled = skills.filter((skill) => skill.enabled !== false);
    this.skillCache.set(key, { at: Date.now(), skills: enabled });
    return botSkills ? skills : enabled;
  }

  /**
   * `compact` → thread/compact/start, `code-review` → review/start (inline), a skill → a turn with the `skill` input
   * (the text says `$name args`, as the Codex TUI writes it). Compaction and review start turns of their own, so they
   * wait for the running turn to end.
   */
  async runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    const session = this.writable(sessionId);
    this.requireLeadThread(session);
    const st = this.sessionState(sessionId);
    if (name === "compact" || name === "code-review") {
      if (st.activeTurnId) throw Object.assign(new Error("回复还在生成，这一轮结束后再运行这个命令"), { code: "conflict" });
      const handle = await this.handleFor(session.profileId);
      // The person's command opens the turn in the conversation (Codex writes no message of its own for it).
      this.appendItem(sessionId, { type: "user", text: `/${name}${args ? ` ${args}` : ""}` }, { method: "command" });
      if (name === "compact") {
        st.compacting = true;
        try { await handle.client.request("thread/compact/start", { threadId: session.runtimeRef! }); }
        catch (err) { st.compacting = false; throw err; }
      } else {
        const r = (await handle.client.request("review/start", { threadId: session.runtimeRef!, target: reviewTarget(args), delivery: "inline" })) as unknown as { turn: { id: string } };
        st.reviewTurns.add(r.turn.id);
      }
      return { mode: "start" };
    }
    const skill = (await this.skills(session)).find((s) => s.name === name);
    if (!skill) throw Object.assign(new Error(`Codex 没有 /${name} 这个命令`), { code: "bad_request" });
    const sent = await this.send(sessionId, `$${skill.name}${args ? ` ${args}` : ""}`, [], [{ type: "skill", name: skill.name, path: skill.path }]);
    return { mode: sent.mode };
  }

  /** Where an attached terminal should connect. The token must only travel through an env var. */
  async attachInfo(sessionId: Id): Promise<{ url: string; token: string; threadId: string }> {
    const s = this.requireSession(sessionId);
    if (this.leadTask(s.taskId)) throw new Error("主控的本地文件只读，不能接管到终端。");
    if (!s.runtimeRef) throw new Error(`session ${sessionId} has no thread yet`);
    const handle = await this.handleFor(s.profileId);
    // Make sure the thread is loaded on this server so `codex --remote … resume` finds it.
    await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...this.identityConfig(s.id), ...this.permissions(s.options, s.taskId) }).catch(() => undefined);
    return { url: handle.url, token: handle.token, threadId: s.runtimeRef };
  }

  /** Records who may write; used by terminal attach and reclaim. */
  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    return this.updateSession(sessionId, { writer });
  }

  /**
   * The thread is not running (any more): a turn the last Host saw start, and its streaming text and running tools,
   * are over. `notify` adds a line saying the reply was cut off.
   */
  private settleTurn(sessionId: Id, notify: boolean): void {
    this.turnCharges?.cancelSession(sessionId);
    // Approvals are not settled here: the app-server replays the ones still wanted after resubscribing (asks.ts).
    const cut = this.settleLeftovers(sessionId);
    // Steered and never read (now unsent, or held again for the inbox's): the turn (and Codex's copy of it) is gone.
    const st = this.state.get(sessionId);
    st?.sent.clear();
    if (st) st.compacting = false;
    if (cut && notify) this.appendItem(sessionId, { type: "notice", level: "warning", message: "这一轮回复被中断了（Host 或 Codex 重启）。发一条消息即可接着对话。" });
  }

  // ---- server events ----------------------------------------------------------------------------------------------

  private attach(handle: CodexServerHandle): void {
    if (this.attached.has(handle.client)) return;
    this.attached.add(handle.client);
    // One message Studio cannot handle stays a line in its session (and the log); the server and other sessions go on.
    handle.client.on("notification", (n) => {
      try {
        if (n.method === "thread/goal/updated" || n.method === "thread/goal/cleared") {
          const s = this.findByThread(n.params.threadId);
          if (s) this.recordGoal(s.id, n.method === "thread/goal/updated" ? n.params.goal : null);
          return;
        }
        this.events.onNotification(handle, n);
      } catch (err) {
        this.events.handlerFailed(n.method, (n.params as { threadId?: string } | undefined)?.threadId, err);
      }
    });
    handle.client.on("request", (r) => {
      try {
        this.asks.onServerRequest(handle, r);
      } catch (err) {
        this.events.handlerFailed(r.method, (r.params as { threadId?: string } | undefined)?.threadId, err);
        // Unanswered, the turn would wait for ever.
        handle.client.respondError(r.id, -32603, `AMO Studio could not handle ${r.method}`);
      }
    });
    handle.client.once("close", () => {
      this.asks.onConnectionLost(handle.profileId);
      // Steered messages the app-server had not read went with it (2026-11-02).
      for (const [id, st] of this.state) {
        if (this.store.getSession(id)?.profileId !== handle.profileId) continue;
        this.turnCharges?.cancelSession(id);
        for (const m of st.sent.values()) this.updateItem(m.itemId, (it) => (it.type === "user" && it.delivery === "waiting" ? withDelivery(it, unreadDelivery(it)) : it));
        st.sent.clear();
      }
    });
  }

  /** After a (re)connect, subscribe again to every live thread served by this profile's server. */
  private restore(handle: CodexServerHandle): Promise<void> {
    let pending = this.restoring.get(handle.client);
    if (!pending) {
      pending = this.resubscribe(handle);
      this.restoring.set(handle.client, pending);
    }
    return pending;
  }

  private async resubscribe(handle: CodexServerHandle): Promise<void> {
    for (const s of this.store.listSessions()) {
      if (s.profileId !== handle.profileId || !s.runtimeRef || s.archivedAt || s.kind === "sub") continue;
      try {
        // A restarted app-server loads the thread again; only then does the identity header need setting again.
        const r = await handle.client.request("thread/resume", { threadId: s.runtimeRef, ...(await this.resumeConfig(handle, s)), ...this.permissions(s.options, s.taskId) });
        await this.readGoal(handle, s);
        // Turn events may have been missed while disconnected; take the status from the server's view.
        const active = (r.thread as { status?: { type?: string } }).status?.type === "active";
        const st = this.sessionState(s.id);
        if (!active) {
          st.activeTurnId = null;
          this.settleTurn(s.id, true);
        }
        const current = this.store.getSession(s.id)!.status;
        if (active && !inTurn(current)) this.setStatus(s.id, "running");
        // Cut off from outside (the Host or the app-server went down mid-turn): red until a message carries it on.
        if (!active && inTurn(current)) this.setStatus(s.id, "interrupted");
      } catch (err) {
        this.emit("log", `thread/resume failed for ${s.id}: ${String(err)}`);
      }
    }
  }

  // ---- helpers ----------------------------------------------------------------------------------------------------

  /**
   * Who answers approvals and how commands run, for thread/start and thread/resume. Approvals always go to the person,
   * whatever `approvals_reviewer` their own Codex config sets (an automatic reviewer would answer instead).
   */
  private permissions(options: SessionOptions, taskId: Id | null) {
    const p = this.permissionOf(options, taskId);
    return { approvalPolicy: p.approvalPolicy, approvalsReviewer: p.reviewer, sandbox: p.sandbox };
  }

  private permissionOf(options: SessionOptions, taskId: Id | null) {
    // 2026-11-07: 主控 manages tasks and canvases through AMO, never escalates into local file editing.
    if (this.restrictedTask(taskId, options)) return { approvalPolicy: "never" as const, sandbox: "read-only" as const, reviewer: "user" as const };
    const p = codexPermission(options.permission);
    return { approvalPolicy: this.options.approvalPolicy ?? p.approvalPolicy, sandbox: this.options.sandbox ?? p.sandbox, reviewer: p.reviewer };
  }

  /**
   * turn/start overrides: permissions (a turn takes a sandbox policy object rather than a mode), the chosen model and
   * effort (they stick for later turns too), and reasoning summaries — models that keep their thinking private (GPT)
   * still show what they thought about.
   */
  private turnOptions(options: SessionOptions, taskId: Id | null, purpose: SendOptions["purpose"] = "work") {
    const { approvalPolicy, sandbox, reviewer } = purpose === "inquiry" ? { approvalPolicy: "never" as const, sandbox: "read-only" as const, reviewer: "user" as const } : this.permissionOf(options, taskId);
    const sandboxPolicy: codex.v2.SandboxPolicy =
      sandbox === "danger-full-access"
        ? { type: "dangerFullAccess" }
        : sandbox === "read-only"
          ? { type: "readOnly", networkAccess: false }
          : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    return {
      approvalPolicy,
      approvalsReviewer: reviewer,
      sandboxPolicy,
      summary: "auto" as const,
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
    };
  }

  /**
   * The `serviceTier` for turn/start (stage 13, 「Fast」): the model's fast tier when the session asks for it and the
   * model has one; "default" (standard speed) when Fast was turned off, or the model has none. Nothing when Fast was
   * never chosen (the person's own Codex config, `service_tier`, applies), and nothing on a profile with no fast tier
   * at all (DeepSeek and other providers never hear of speed tiers).
   */
  private async serviceTier(session: Session): Promise<{ serviceTier?: string }> {
    if (session.options.fast === undefined) return {};
    let models: ModelOption[];
    try {
      models = (await this.choices(session.profileId)).models;
    } catch {
      return {};
    }
    if (!models.some((m) => m.fast)) return {};
    const model = models.find((m) => m.id === session.options.model) ?? models.find((m) => m.isDefault);
    return { serviceTier: (session.options.fast && model?.fast?.tier) || STANDARD_TIER };
  }

  /**
   * thread/start and thread/fork parameters: explicit provider and model, the AMO MCP identity header, and the
   * 自动压缩点 (设置 → 模型).
   */
  private threadParams(profile: ModelProfile, token: string | undefined) {
    const base = codexThreadParams(profile);
    return { ...base, config: { ...(base.config ?? {}), ...codexAutoCompactConfig(this.store, profile.id), ...(token ? McpIdentities.threadConfig(token) : {}) } };
  }

  private leadTask(taskId: Id | null): boolean {
    return !!taskId && this.store.getTask(taskId)?.lead === true;
  }

  private restrictedTask(taskId: Id | null, options: SessionOptions): boolean {
    return isReadOnlyTask(this.store, taskId, "codex", options);
  }

  private requireLeadThread(session: Session): void {
    if (!this.restrictedTask(session.taskId, session.options)) {
      this.store.deleteKv(`codex-lead-readonly:${session.id}`);
      return;
    }
    if (this.store.getKv(`codex-lead-readonly:${session.id}`)?.value !== session.runtimeRef) {
      throw new Error(this.leadTask(session.taskId)
        ? "这个会话在主控只读限制生效前已启动，请新开主控会话；旧会话不能继续执行。"
        : "这个 Bot 会话没有应用只读限制，请新开聊天继续。");
    }
  }

  /** MCP servers run outside the command sandbox: a read-only lead must not inherit their write tools. */
  private async leadConfig(handle: CodexServerHandle, taskId: Id | null, cwd?: string): Promise<{ config?: CodexConfig }> {
    const bot = isBotTask(this.store, taskId);
    if (!bot && !this.leadTask(taskId)) return {};
    const read = await handle.client.request("config/read", { includeLayers: false, ...(cwd ? { cwd } : {}) }) as codex.v2.ConfigReadResponse;
    if (!read.config || typeof read.config !== "object") throw new Error("无法读取 Codex 配置，不能安全启动只读主控。");
    const config: CodexConfig = {};
    // These native tools and hooks can act outside the filesystem sandbox; keys verified with `codex features list`.
    for (const feature of ["plugins", "apps", "multi_agent", "multi_agent_v2", "computer_use", "browser_use", "browser_use_external", "in_app_local_automation", "hooks", "image_generation", "artifact"]) config[`features.${feature}`] = false;
    const servers = read.config.mcp_servers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      // Only amend an existing server: tool settings alone would create an AMO entry with no transport.
      const amo = servers.amo;
      if (amo && typeof amo === "object" && !Array.isArray(amo)) {
        if (bot && this.options.identities) config["mcp_servers.amo.enabled"] = true;
        if (!bot) for (const name of LEAD_MANAGEMENT_TOOLS) config[`mcp_servers.amo.tools.${name}.approval_mode`] = "approve";
      }
      for (const name of Object.keys(servers)) {
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Codex MCP 服务名无法安全隔离，不能启动只读主控。");
        if (name !== "amo" || (bot && !this.options.identities)) config[`mcp_servers.${name}.enabled`] = false;
      }
    }
    return { config };
  }

  private async resumeConfig(handle: CodexServerHandle, session: Session): Promise<{ config: CodexConfig; cwd?: string; developerInstructions?: string }> {
    this.requireLeadThread(session);
    const lead = await this.leadConfig(handle, session.taskId, session.cwd ?? this.store.getWorkspace(session.workspaceId)?.path);
    const prompt = botSessionPrompt(this.store, session.id);
    return { config: { ...this.identityConfig(session.id).config, ...lead.config }, ...(session.cwd ? { cwd: session.cwd } : {}), ...(prompt ? { developerInstructions: prompt } : {}) };
  }

  /** For thread/resume: the session's identity header (takes effect when the server loads the thread again). */
  /** thread/resume's config: the AMO MCP identity header and the 自动压缩点. */
  private identityConfig(sessionId: Id): { config: CodexConfig } {
    const session = this.requireSession(sessionId);
    const ids = this.options.identities;
    return { config: { ...codexAutoCompactConfig(this.store, session.profileId), ...(ids ? McpIdentities.threadConfig(ids.tokenFor(sessionId, isBotTask(this.store, session.taskId))) : {}) } };
  }

  private async handleFor(profileId: Id): Promise<CodexServerHandle> {
    const handle = await this.options.servers.ensure(profileId);
    this.attach(handle);
    await this.restore(handle);
    return handle;
  }

  private profile(id: Id): ModelProfile {
    const p = this.options.profiles.find((x) => x.id === id);
    if (!p) throw profileGone(id);
    if (p.runtime !== "codex") throw new Error(`unknown Codex profile ${id}`);
    return p;
  }

  private findByThread(threadId: string): Session | undefined {
    return this.store.findSessionByRuntimeRef("codex", threadId);
  }

  private sessionState(id: Id): SessionState {
    let st = this.state.get(id);
    if (!st) {
      st = newSessionState();
      this.state.set(id, st);
    }
    return st;
  }

}


