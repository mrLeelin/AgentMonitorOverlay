import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { inTurn, storedAnswers, type ApprovalDecision, type Attachment, type Id, type McpApply, type McpServerSpec, type ModelOption, type ModelProfile, type ProfileChoices, type QuestionAnswer, type QuestionReply, type Session, type SessionOptions, type SlashCommand, type SlashCommandList, type SlashCommandResult, type Workspace } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "../../mcp/identity.js";
import { RuntimeBase, STOP_GRACE_MS, type SendMode, type SendOptions, type SessionRuntimeApi } from "../runtime.js";
import { shellHelpEnv, withoutHostEnv } from "../agent-env.js";
import { agentNetworkEnv } from "../network.js";
import { withDelivery } from "../items.js";
import { currentMessagePurpose, queueMessagePurpose } from "../message-purpose.js";
import type { McpSource } from "../mcp-launch.js";
import { piMcpExtension, PI_MCP_SERVERS_ENV, resolvePiCommand } from "./launch.js";
import { PiRpc, type PiCommand } from "./rpc.js";
import { PiTranscript } from "./transcript.js";

export { piUnavailable } from "./launch.js";

export interface PiOptions {
  dir: string;
  command?: PiCommand;
  cwd?: string;
  mcp?: () => { url: string; token: string } | null;
  identities?: McpIdentities;
  mcpServers?: McpSource;
  stopGraceMs?: number;
}

type Value = Record<string, any>;
type Image = { type: "image"; data: string; mimeType: string };
type Queued = { itemId: Id; text: string; images: Image[]; stopVersion: number; beforeDispatch?: () => void };
type Dialog = { requestId: string; method: string; itemId: Id; timer: NodeJS.Timeout | null };
type Live = {
  conn: PiRpc;
  transcript: PiTranscript;
  queue: Queued[];
  dialogs: Map<Id, Dialog>;
  inflight: boolean;
  seenStart: boolean;
  stopping: "user" | "send-now" | null;
  restart: boolean;
  model?: string;
  effort?: string;
  startupError?: string;
  compactEvents?: boolean;
};

const PERMISSIONS = [{ id: "full-access", label: "完全访问", description: "Pi 直接执行工具，不提供 Studio 的只读沙箱或逐项审批。" }];
const CONFIGURE = "Pi 没有可用的模型：请先在 Pi 中登录模型服务，或配置 ~/.pi/agent/models.json，然后重试。";
const unsupported = (message: string) => Object.assign(new Error(message), { code: "bad_request" });
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const modelId = (model: Value | undefined) => model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : undefined;

/** Pi's get_commands reports each skill's actual source file in sourceInfo.path. */
export function piCommands(result: Value): SlashCommand[] {
  return (Array.isArray(result.commands) ? result.commands : []).filter((command: Value) => typeof command.name === "string" && command.name !== "compact").map((command: Value) => ({
    name: command.name,
    description: typeof command.description === "string" ? command.description : "",
    group: command.source === "skill" ? "skill" as const : "custom" as const,
    ...(command.source === "skill" && typeof command.sourceInfo?.path === "string" && isAbsolute(command.sourceInfo.path) ? { skillPath: command.sourceInfo.path } : {}),
  }));
}

/** Pi keeps its own native session; Studio owns message validity and queue boundaries. */
export class PiRuntime extends RuntimeBase implements SessionRuntimeApi {
  private readonly live = new Map<Id, Live>();
  private readonly starting = new Map<Id, Promise<Live>>();
  private readonly serials = new Map<Id, Promise<unknown>>();
  private readonly stopVersions = new Map<Id, number>();
  private closing = false;

  constructor(store: Store, private readonly profiles: readonly ModelProfile[], private readonly options: PiOptions) {
    super(store, "pi", undefined, profiles);
    for (const session of store.listSessions()) {
      if (session.runtime !== "pi") continue;
      const cut = this.settleLeftovers(session.id);
      this.cancelStoredQuestions(session.id);
      if (cut || inTurn(session.status)) this.setStatus(session.id, "interrupted");
    }
  }

  async startSession(input: Parameters<SessionRuntimeApi["startSession"]>[0]): Promise<Session> {
    const profile = this.profile(input.profileId);
    const options: SessionOptions = { ...(profile.model ? { model: profile.model } : {}), ...(input.options ?? {}), permission: input.options?.permission ?? "full-access" };
    this.checkAccess(input.taskId, options);
    if (input.resumeFrom) throw unsupported("Pi 暂不支持接续 Studio 外的会话。");
    const session = this.createSession({ taskId: input.taskId, topicId: input.topicId, parentId: null, kind: "main", profileId: profile.id, workspaceId: input.workspace.id, title: input.title ?? "", runtimeRef: randomUUID(), options });
    const stopVersion = this.stopVersions.get(session.id) ?? 0;
    try {
      await this.ensureLive(session);
      this.checkStopVersion(session.id, stopVersion);
      if (input.text) await this.sendMessage(session.id, input.text, [], { beforeDispatch: input.beforeDispatch });
      return this.requireSession(session.id);
    } catch (error) {
      this.setStatus(session.id, (this.stopVersions.get(session.id) ?? 0) !== stopVersion ? "idle" : "error");
      await this.release(session.id);
      throw error;
    }
  }

  async choices(profileId: Id): Promise<ProfileChoices> {
    this.profile(profileId);
    const cwd = this.options.cwd ?? join(this.options.dir, "probe");
    mkdirSync(cwd, { recursive: true });
    const conn = this.spawn(cwd, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
    try {
      const [available, state] = await Promise.all([conn.request<Value>("get_available_models"), conn.request<Value>("get_state")]);
      const thinking = state.model?.reasoning ? await conn.request<Value>("get_available_thinking_levels") : null;
      const models: ModelOption[] = [];
      for (const model of Array.isArray(available.models) ? available.models : []) {
        const id = modelId(model);
        if (!id) continue;
        const isDefault = id === modelId(state.model);
        const efforts = !model.reasoning ? [] : isDefault && Array.isArray(thinking?.levels) ? thinking.levels.filter((level: unknown): level is string => typeof level === "string") : ["off", "minimal", "low", "medium", "high"];
        models.push({ id, label: `${model.name || model.id} · ${model.provider}`, efforts, ...(isDefault ? { isDefault: true, ...(typeof state.thinkingLevel === "string" ? { defaultEffort: state.thinkingLevel } : {}) } : {}) });
      }
      if (!models.length) throw unsupported(CONFIGURE);
      return { profileId, models, permissions: PERMISSIONS, defaultPermission: "full-access", source: "cli" };
    } finally { await conn.close(); }
  }

  async sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const blocks = this.images(images);
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    return this.serial(sessionId, async () => {
      const session = this.writable(sessionId);
      this.checkAccess(session.taskId, session.options, options.purpose);
      const live = await this.ensureLive(session);
      this.checkStopVersion(sessionId, stopVersion);
      options.beforeDispatch?.();
      this.checkAccess(session.taskId, this.writable(sessionId).options, options.purpose);
      if (!session.title) this.updateSession(sessionId, { title: (text || "图片").slice(0, 60) });
      const item = this.appendItem(sessionId, { type: "user", text, delivery: live.inflight ? "waiting" : "held", ...(options.purpose ? { messagePurpose: options.purpose } : {}), ...(images.length ? { images: images.map((image) => ({ id: image.id, path: image.path })) } : {}) }, { method: live.inflight ? "user/queued" : "user", ...live.transcript.turnRef() });
      const queued: Queued = { itemId: item.id, text, images: blocks, stopVersion, beforeDispatch: options.beforeDispatch };
      if (live.inflight) {
        live.queue.push(queued);
        if (options.now) await this.abort(sessionId, live, "send-now");
        return { mode: "queue" };
      }
      await this.dispatch(sessionId, live, queued).catch((error) => { this.updateItem(item.id, (row) => row.type === "user" && row.delivery !== "expired" ? withDelivery(row, "unsent") : row); throw error; });
      return { mode: "start" };
    });
  }

  async resend(sessionId: Id, itemId: Id, images: readonly Attachment[], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    const blocks = this.images(images);
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    return this.serial(sessionId, async () => {
      const session = this.writable(sessionId);
      const row = this.store.getItem(itemId);
      if (row?.type !== "user" || row.sessionId !== sessionId || (row.delivery !== "held" && row.delivery !== "unsent")) throw unsupported("这条消息不能重新发送。");
      this.assertCurrentMessage(sessionId, itemId);
      this.checkAccess(session.taskId, session.options, options.purpose ?? row.messagePurpose);
      const live = await this.ensureLive(session);
      this.checkStopVersion(sessionId, stopVersion);
      options.beforeDispatch?.();
      this.assertCurrentMessage(sessionId, itemId);
      const queued = { itemId, text: row.text, images: blocks, stopVersion, beforeDispatch: options.beforeDispatch };
      this.updateItem(itemId, (item) => item.type === "user" ? withDelivery(item, live.inflight ? "waiting" : "held") : item);
      if (live.inflight) {
        live.queue.push(queued);
        if (options.now) await this.abort(sessionId, live, "send-now");
        return { mode: "queue" };
      }
      await this.dispatch(sessionId, live, queued).catch((error) => { this.updateItem(itemId, (row) => row.type === "user" && row.delivery !== "expired" ? withDelivery(row, "unsent") : row); throw error; });
      return { mode: "start" };
    });
  }

  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    await this.serial(sessionId, async () => {
      this.writable(sessionId);
      const live = this.live.get(sessionId), index = live?.queue.findIndex((queued) => queued.itemId === itemId) ?? -1;
      if (!live || index < 0) return;
      const [queued] = live.queue.splice(index, 1);
      live.queue.unshift(queued!);
      if (live.inflight) await this.abort(sessionId, live, "send-now");
      else await this.flush(sessionId, live);
    });
  }

  async interrupt(sessionId: Id): Promise<void> {
    // Stop must bypass a serial command (manual compaction or an extension command can wait indefinitely).
    this.stopVersions.set(sessionId, (this.stopVersions.get(sessionId) ?? 0) + 1);
    const live = this.live.get(sessionId);
    if (!live) return;
    this.unsentQueue(live);
    this.cancelDialogs(sessionId, live);
    if (live.inflight) await this.abort(sessionId, live, "user");
  }

  async setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    return this.serial(sessionId, async () => {
      const session = this.writable(sessionId);
      this.checkAccess(session.taskId, options);
      const next = { ...session, options: { ...options, permission: "full-access" } };
      const live = this.live.get(sessionId);
      if (live && !live.inflight) {
        const previous = { model: live.model, effort: live.effort };
        try { await this.applyOptions(next, live); }
        catch (error) {
          await this.applyOptions({ ...session, options: { ...session.options, ...previous } }, live).catch(() => this.release(sessionId));
          throw error;
        }
      } else await this.probeOptions(next);
      this.checkAccess(this.writable(sessionId).taskId, next.options);
      const updated = this.updateSession(sessionId, { options: next.options });
      if (live && JSON.stringify(session.options.mcp) !== JSON.stringify(options.mcp)) live.restart = true;
      return updated;
    });
  }

  async rename(sessionId: Id, title: string): Promise<Session> {
    return this.serial(sessionId, async () => {
      this.requireSession(sessionId);
      const live = this.live.get(sessionId);
      if (live) await live.conn.request("set_session_name", { name: title });
      return this.updateSession(sessionId, { title });
    });
  }

  async archive(sessionId: Id): Promise<Session[]> {
    const changed = this.archiveTree(sessionId);
    for (const session of changed) await this.release(session.id);
    return changed;
  }
  async unarchive(sessionId: Id): Promise<Session[]> { return this.unarchiveTree(sessionId); }
  setWriter(sessionId: Id, writer: Session["writer"]): Session { return this.updateSession(sessionId, { writer }); }
  async fork(): Promise<Session> { throw unsupported("Pi 会话暂不支持在 Studio 中分支。"); }
  async attachInfo(): Promise<{ url: string; token: string; threadId: string }> { throw unsupported("Pi 会话暂不支持在 Studio 中打开终端。"); }
  async respondApproval(_sessionId: Id, _approvalId: string, _decision: ApprovalDecision): Promise<void> { throw unsupported("Pi 不提供 Studio 的工具审批。"); }

  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    return this.serial(sessionId, async () => {
      const live = await this.ensureLive(this.writable(sessionId));
      const result = await live.conn.request<Value>("get_commands");
      return { commands: [{ name: "compact", description: "压缩 Pi 的会话上下文", group: "runtime" }, ...piCommands(result)] };
    });
  }

  async listProfileCommands(profileId: Id, workspace: Workspace): Promise<SlashCommandList> {
    this.profile(profileId);
    const conn = this.spawn(workspace.path, ["--mode", "rpc", "--no-session", "--no-mcp"]);
    try {
      const result = await conn.request<Value>("get_commands");
      return { commands: piCommands(result) };
    } finally { await conn.close(); }
  }

  async runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    if (name !== "compact") return this.sendMessage(sessionId, `/${name}${args ? ` ${args}` : ""}`);
    const stopVersion = this.stopVersions.get(sessionId) ?? 0;
    return this.serial(sessionId, async () => {
      const session = this.writable(sessionId);
      this.checkAccess(session.taskId, session.options);
      const live = await this.ensureLive(session);
      this.checkStopVersion(sessionId, stopVersion);
      if (live.inflight) throw unsupported("等 Pi 这一轮结束后再压缩上下文。");
      live.inflight = true;
      live.compactEvents = false;
      live.transcript.openTurn();
      this.setStatus(sessionId, "running");
      try {
        const result = await live.conn.request("compact", args ? { customInstructions: args } : {}, 0);
        if (!live.compactEvents) {
          live.transcript.event({ type: "compaction_start", reason: "manual" });
          live.transcript.event({ type: "compaction_end", reason: "manual", result });
        }
        this.finishTurn(sessionId, live);
        return { mode: "done" };
      } catch (error) {
        if (!live.compactEvents) live.transcript.event({ type: "compaction_end", reason: "manual", errorMessage: errorText(error) });
        this.finishTurn(sessionId, live, errorText(error));
        throw error;
      }
    });
  }

  async refreshMcp(sessionId: Id): Promise<McpApply> {
    const live = this.live.get(sessionId);
    if (!live) return "not-running";
    live.restart = true;
    return live.inflight ? "after-turn" : "next-message";
  }

  async answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    const live = this.live.get(sessionId), dialog = live?.dialogs.get(itemId), item = this.store.getItem(itemId);
    if (!live || !dialog || item?.type !== "question" || item.state !== "pending" || item.sessionId !== sessionId) throw unsupported("这个 Pi 问题已经不再等待回答。");
    if (reply.action !== "answer" && reply.action !== "dismiss") throw unsupported("这个 Pi 问题需要选择答案或填写文字。");
    let response: Value = { type: "extension_ui_response", id: dialog.requestId, cancelled: true };
    if (reply.action === "answer") {
      const answer = reply.answers.find((answer) => answer.id === dialog.requestId);
      const value = answer?.other ?? answer?.selected[0];
      if (answer && !answer.skipped && value !== undefined) {
        if (dialog.method === "select" && !item.questions?.[0]?.options.some((option) => option.label === value)) throw unsupported("请选择 Pi 给出的选项。");
        if (dialog.method === "confirm" && value !== "是" && value !== "否") throw unsupported("请选择是或否。");
        response = dialog.method === "confirm" ? { type: "extension_ui_response", id: dialog.requestId, confirmed: value === "是" } : { type: "extension_ui_response", id: dialog.requestId, value };
      }
    }
    live.conn.notify(response);
    this.endDialog(sessionId, live, dialog, reply.action === "dismiss" ? "dismissed" : "answered", reply.action === "answer" ? storedAnswers(item.questions ?? [], reply.answers) : undefined);
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.live.keys()].map((id) => this.release(id)));
  }

  private profile(profileId: Id): ModelProfile {
    const profile = this.profiles.find((profile) => profile.id === profileId && profile.runtime === "pi");
    if (!profile) throw unsupported(`没有找到 Pi 模型配置：${profileId}`);
    return profile;
  }

  private checkAccess(taskId: Id | null, options: SessionOptions, purpose?: string): void {
    if ((options.permission && options.permission !== "full-access") || (taskId && this.store.getTask(taskId)?.lead)) throw unsupported("Pi 不提供可核验的只读沙箱，不能用于只读会话或主控；请选择 Codex、Claude 或 DSH。");
    if (purpose === "inquiry") throw unsupported("Pi 不提供可核验的只读沙箱，不能接收只读询问；请选择支持只读的模型。");
  }

  private images(images: readonly Attachment[]): Image[] {
    return images.map((image) => {
      if (!image.mime.startsWith("image/")) throw unsupported("Pi 只支持图片附件。");
      return { type: "image", data: readFileSync(image.path).toString("base64"), mimeType: image.mime };
    });
  }

  private spawn(cwd: string, args: string[], extraEnv: Record<string, string> = {}): PiRpc {
    const command = this.options.command ?? resolvePiCommand();
    if (!command) throw unsupported("没有找到 Pi：请先安装 Pi，并把 pi 加入 PATH，然后重新打开 Studio。");
    const env = agentNetworkEnv(this.store, { ...shellHelpEnv(this.store), ...withoutHostEnv(process.env), ...extraEnv });
    return new PiRpc({ ...command, args: [...command.args, ...args] }, cwd, env);
  }

  private ensureLive(session: Session): Promise<Live> {
    const known = this.live.get(session.id);
    if (known?.conn.alive && !known.restart) return Promise.resolve(known);
    if (known?.inflight) return Promise.resolve(known);
    const starting = this.starting.get(session.id);
    if (starting) return starting;
    const create = (async () => {
      if (this.closing) throw new Error("Studio 正在关闭。");
      this.checkAccess(session.taskId, session.options, inTurn(session.status) ? currentMessagePurpose(this.store, session.id) : undefined);
      if (known) await this.release(session.id);
      const workspace = this.store.getWorkspace(session.workspaceId);
      if (!workspace) throw unsupported("Pi 会话的工作目录已不存在。");
      if (!session.runtimeRef || !/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(session.runtimeRef)) throw unsupported("Pi 会话的恢复标识无效。");
      const dir = join(this.options.dir, "sessions", session.runtimeRef);
      mkdirSync(dir, { recursive: true });
      const extra = this.mcp(session);
      const args = ["--mode", "rpc", "--session-id", session.runtimeRef, "--session-dir", dir];
      if (Object.keys(extra).length) args.push("--extension", piMcpExtension(join(this.options.dir, "extensions")));
      const conn = this.spawn(workspace.path, args, Object.keys(extra).length ? { [PI_MCP_SERVERS_ENV]: JSON.stringify(extra) } : {});
      const live: Live = { conn, transcript: new PiTranscript(this.makeCore(), session.id, workspace.path), queue: [], dialogs: new Map(), inflight: false, seenStart: false, stopping: null, restart: false };
      this.live.set(session.id, live);
      conn.on("event", (event) => this.event(session.id, live, event));
      conn.on("log", (line) => this.emit("log", `${session.id}: ${line}`));
      conn.on("exit", (error) => {
        if (this.live.get(session.id) !== live) return;
        this.live.delete(session.id);
        this.unsentQueue(live);
        this.cancelDialogs(session.id, live);
        if (live.inflight) {
          live.transcript.closeTurn(live.stopping ? "interrupted" : "failed", error.message);
          live.inflight = false;
          this.setStatus(session.id, live.stopping === "user" ? "idle" : this.closing ? "interrupted" : "error");
        }
      });
      try {
        const state = await conn.request<Value>("get_state");
        if (live.startupError) throw unsupported(live.startupError);
        live.model = modelId(state.model);
        live.effort = typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined;
        await this.applyOptions(session, live);
        if (!live.model) throw unsupported(CONFIGURE);
        if (session.title) await conn.request("set_session_name", { name: session.title });
        return live;
      } catch (error) {
        if (this.live.get(session.id) === live) this.live.delete(session.id);
        this.cancelDialogs(session.id, live);
        await conn.close();
        throw error;
      }
    })();
    this.starting.set(session.id, create);
    void create.finally(() => { if (this.starting.get(session.id) === create) this.starting.delete(session.id); }).catch(() => undefined);
    return create;
  }

  private mcp(session: Session): Record<string, Value> {
    const servers: Record<string, Value> = {};
    for (const [name, spec] of Object.entries(this.options.mcpServers?.launch(session.id, false).explicit ?? {})) {
      if (spec.type === "sse") throw unsupported(`Pi 不支持 MCP「${name}」的旧版 SSE 地址，请改用 HTTP 地址。`);
      servers[name] = this.mcpSpec(spec);
    }
    const amo = this.options.mcp?.();
    if (amo) {
      if (!this.options.identities) throw unsupported("Pi 的 Studio MCP 缺少会话身份，不能启动；请重新打开 Studio 后重试。");
      const name = `amo_studio_${session.id.replace(/[^A-Za-z0-9_]/g, "_")}`;
      if (servers[name]) throw unsupported("Pi 的 Studio MCP 名称与已有服务器冲突，请修改服务器名称。");
      servers[name] = { type: "http", url: amo.url, headers: { Authorization: `Bearer ${amo.token}`, [MCP_SESSION_HEADER]: this.options.identities.tokenFor(session.id) } };
    }
    return servers;
  }

  private mcpSpec(spec: McpServerSpec): Value {
    return spec.type === "stdio" ? { type: "stdio", command: spec.command ?? "", args: spec.args ?? [], ...(spec.env ? { env: spec.env } : {}) } : { type: "http", url: spec.url ?? "", ...(spec.headers ? { headers: spec.headers } : {}) };
  }

  private async probeOptions(session: Session): Promise<void> {
    const cwd = this.options.cwd ?? join(this.options.dir, "probe");
    mkdirSync(cwd, { recursive: true });
    const conn = this.spawn(cwd, ["--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp"]);
    try {
      const state = await conn.request<Value>("get_state");
      await this.applyOptions(session, { conn, model: modelId(state.model), effort: state.thinkingLevel });
    } finally { await conn.close(); }
  }

  private async applyOptions(session: Session, live: Pick<Live, "conn" | "model" | "effort">): Promise<void> {
    this.checkAccess(session.taskId, session.options);
    const desired = session.options.model;
    if (desired && desired !== live.model) {
      const slash = desired.indexOf("/");
      if (slash <= 0 || slash === desired.length - 1) throw unsupported("Pi 的模型标识需要包含服务商和型号。");
      const result = await live.conn.request<Value>("set_model", { provider: desired.slice(0, slash), modelId: desired.slice(slash + 1) });
      live.model = modelId(result) ?? modelId(result?.model) ?? desired;
      const state = await live.conn.request<Value>("get_state");
      live.effort = typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined;
    }
    if (session.options.effort && session.options.effort !== live.effort) {
      const available = await live.conn.request<Value>("get_available_thinking_levels");
      if (!Array.isArray(available.levels) || !available.levels.includes(session.options.effort)) throw unsupported(`Pi 当前型号不支持思考强度「${session.options.effort}」，请重新选择。`);
      await live.conn.request("set_thinking_level", { level: session.options.effort });
      live.effort = session.options.effort;
    }
  }

  private async dispatch(sessionId: Id, live: Live, queued: Queued): Promise<void> {
    const session = this.writable(sessionId), item = this.store.getItem(queued.itemId);
    this.checkAccess(session.taskId, session.options, item?.type === "user" ? item.messagePurpose : undefined);
    await this.applyOptions(session, live);
    this.checkStopVersion(sessionId, queued.stopVersion);
    queued.beforeDispatch?.();
    this.assertCurrentMessage(sessionId, queued.itemId);
    this.checkAccess(session.taskId, this.writable(sessionId).options, item?.type === "user" ? item.messagePurpose : undefined);
    queueMessagePurpose(this.store, sessionId, item?.type === "user" ? item.messagePurpose ?? "work" : "work", false);
    live.transcript.openTurn();
    live.inflight = true;
    live.seenStart = false;
    live.stopping = null;
    this.setStatus(sessionId, "running");
    try {
      this.checkStopVersion(sessionId, queued.stopVersion);
      this.assertCurrentMessage(sessionId, queued.itemId);
      const current = this.writable(sessionId);
      this.checkAccess(current.taskId, current.options, item?.type === "user" ? item.messagePurpose : undefined);
      const accepted = await live.conn.request<Value>("prompt", { message: queued.text, ...(queued.images.length ? { images: queued.images } : {}) });
      this.updateItem(queued.itemId, (item) => item.type === "user" ? withDelivery(item, undefined) : item);
      this.messagePurposeConsumed(sessionId, queued.itemId);
      this.emit("message-delivered", sessionId, queued.text);
      if (accepted?.disposition === "handled" && !live.seenStart) this.finishTurn(sessionId, live);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "pi_timeout") {
        // The agent may have accepted a prompt whose response got lost. Never dispatch the next message to it.
        this.unsentQueue(live);
        live.conn.kill();
        this.appendItem(sessionId, { type: "notice", level: "warning", message: "Pi 没有确认是否收到这条消息，Studio 已终止该进程以防后续消息重复执行。请先检查本轮结果，再决定是否重新发送。" }, { method: "pi/prompt-uncertain", ...live.transcript.turnRef() });
      }
      this.updateItem(queued.itemId, (item) => item.type === "user" && item.delivery !== "expired" ? withDelivery(item, "unsent") : item);
      this.finishTurn(sessionId, live, errorText(error));
      throw error;
    }
  }

  private event(sessionId: Id, live: Live, event: Value): void {
    if (this.live.get(sessionId) !== live) return;
    if (event.type === "extension_ui_request") { this.extensionUi(sessionId, live, event); return; }
    if (event.type === "extension_error") {
      live.startupError = typeof event.error === "string" ? event.error : "Pi 扩展加载失败，请检查 Pi 版本与扩展设置。";
      this.appendItem(sessionId, { type: "notice", level: "warning", message: live.startupError }, { method: event.type, ...live.transcript.turnRef() });
    }
    if (event.type === "agent_start") {
      live.seenStart = true;
      if (!live.inflight) {
        live.inflight = true;
        live.transcript.openTurn();
        this.setStatus(sessionId, "running");
      }
    }
    if (event.type === "compaction_start" || event.type === "compaction_end") live.compactEvents = true;
    live.transcript.event(event);
    if (event.type === "agent_settled") {
      if (event.aborted && !live.stopping) live.stopping = "user";
      this.finishTurn(sessionId, live);
    }
  }

  private finishTurn(sessionId: Id, live: Live, error?: string): void {
    if (!live.inflight) return;
    this.cancelDialogs(sessionId, live);
    const failure = error ?? (live.stopping ? undefined : live.transcript.failed());
    live.transcript.closeTurn(live.stopping ? "interrupted" : failure ? "failed" : "completed", failure);
    live.inflight = false;
    this.setStatus(sessionId, live.stopping ? "idle" : failure ? "error" : "completed");
    live.stopping = null;
    if (failure) { this.unsentQueue(live); return; }
    void this.serial(sessionId, () => this.flush(sessionId, live)).catch((error) => this.emit("log", `${sessionId}: Pi queued dispatch failed: ${errorText(error)}`));
  }

  private async flush(sessionId: Id, live: Live): Promise<void> {
    if (this.closing || this.live.get(sessionId) !== live || live.inflight) return;
    while (live.queue.length && !live.inflight) {
      const queued = live.queue.shift()!;
      try {
        const waiting = live.restart ? live.queue.splice(0) : [];
        let current: Live;
        try { current = await this.ensureLive(this.writable(sessionId)); }
        catch (error) {
          for (const pending of waiting) this.updateItem(pending.itemId, (item) => item.type === "user" ? withDelivery(item, "unsent") : item);
          throw error;
        }
        if (current !== live) { current.queue.push(...waiting, ...live.queue.splice(0)); await this.dispatch(sessionId, current, queued); return; }
        await this.dispatch(sessionId, live, queued);
      } catch (error) {
        this.updateItem(queued.itemId, (item) => item.type === "user" && item.delivery !== "expired" ? withDelivery(item, "unsent") : item);
        this.appendItem(sessionId, { type: "notice", level: "warning", message: `等待发送的消息没有送达 Pi：${errorText(error)}` }, { method: "user/unsent" });
      }
    }
  }

  private async abort(sessionId: Id, live: Live, reason: "user" | "send-now"): Promise<void> {
    live.stopping = reason;
    this.cancelDialogs(sessionId, live);
    const grace = this.options.stopGraceMs ?? STOP_GRACE_MS;
    this.armStopGrace(sessionId, grace, () => this.live.get(sessionId) === live && live.inflight, () => {
      this.unsentQueue(live);
      live.conn.kill();
      this.appendItem(sessionId, { type: "notice", level: "warning", message: "Pi 未在停止期限内结束，Studio 已终止它的进程。可以重新发送消息继续会话。" }, { method: "pi/stop", ...live.transcript.turnRef() });
    }, "closing its process");
    await live.conn.request("clear_queue").catch(() => undefined);
    await live.conn.request("abort").catch(() => undefined);
  }

  private unsentQueue(live: Live): void {
    for (const queued of live.queue.splice(0)) this.updateItem(queued.itemId, (item) => item.type === "user" ? withDelivery(item, "unsent") : item);
  }

  private async release(sessionId: Id): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    this.unsentQueue(live);
    this.cancelDialogs(sessionId, live);
    if (live.inflight) {
      live.transcript.closeTurn("interrupted");
      live.inflight = false;
      const session = this.requireSession(sessionId);
      if (!session.archivedAt) this.setStatus(sessionId, "interrupted");
    }
    await live.conn.close();
  }

  private extensionUi(sessionId: Id, live: Live, event: Value): void {
    const method = String(event.method ?? "");
    if (method === "notify") {
      this.appendItem(sessionId, { type: "notice", level: event.notifyType === "warning" || event.notifyType === "error" ? "warning" : "info", message: String(event.message ?? "") }, { method: event.type, ...live.transcript.turnRef() });
      return;
    }
    if (!["select", "confirm", "input", "editor"].includes(method) || typeof event.id !== "string") return;
    if ([...live.dialogs.values()].some((dialog) => dialog.requestId === event.id)) return;
    const choices = method === "confirm" ? ["是", "否"] : method === "select" && Array.isArray(event.options) ? event.options.filter((option: unknown): option is string => typeof option === "string") : [];
    const item = this.appendItem(sessionId, { type: "question", source: "pi-input", state: "pending", questions: [{ id: event.id, question: [event.title, event.message].filter((part) => typeof part === "string" && part).join("\n") || "Pi 需要你的回答", options: choices.map((label: string) => ({ label })), other: method === "input" || method === "editor" }] }, { method: event.type, ...live.transcript.turnRef() });
    const dialog: Dialog = { requestId: event.id, method, itemId: item.id, timer: null };
    live.dialogs.set(item.id, dialog);
    if (typeof event.timeout === "number" && Number.isFinite(event.timeout) && event.timeout > 0) {
      dialog.timer = setTimeout(() => this.endDialog(sessionId, live, dialog, "cancelled"), event.timeout);
      dialog.timer.unref?.();
    }
    this.setStatus(sessionId, "awaiting-answer");
  }

  private endDialog(sessionId: Id, live: Live, dialog: Dialog, state: "answered" | "dismissed" | "cancelled", answers?: QuestionAnswer[]): void {
    if (dialog.timer) clearTimeout(dialog.timer);
    live.dialogs.delete(dialog.itemId);
    this.updateItem(dialog.itemId, (item) => item.type === "question" && item.state === "pending" ? { ...item, state, ...(answers ? { answers } : {}) } : item);
    if (!live.dialogs.size && live.inflight) this.setStatus(sessionId, "running");
  }

  private cancelDialogs(sessionId: Id, live: Live): void {
    for (const dialog of [...live.dialogs.values()]) {
      if (live.conn.alive) { try { live.conn.notify({ type: "extension_ui_response", id: dialog.requestId, cancelled: true }); } catch { /* The process may have exited with this turn. */ } }
      this.endDialog(sessionId, live, dialog, "cancelled");
    }
  }

  private cancelStoredQuestions(sessionId: Id): void {
    for (const item of this.store.findItems(sessionId, "question", { state: "pending" })) if (item.type === "question" && item.source === "pi-input") this.updateItem(item.id, (row) => row.type === "question" ? { ...row, state: "cancelled" } : row);
  }

  private serial<T>(sessionId: Id, action: () => Promise<T>): Promise<T> {
    const result = (this.serials.get(sessionId) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.serials.set(sessionId, result);
    void result.finally(() => { if (this.serials.get(sessionId) === result) this.serials.delete(sessionId); }).catch(() => undefined);
    return result;
  }

  private checkStopVersion(sessionId: Id, expected: number): void {
    if ((this.stopVersions.get(sessionId) ?? 0) !== expected) throw Object.assign(new Error("这次发送已被停止，消息没有发送给 Pi。"), { code: "conflict" });
  }
}
