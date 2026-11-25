import { createHash, randomUUID } from "node:crypto";
import { inTurn, isCommon, type BotDestination, type BotGroup, type BotGroupPost, type BotInput, type BotRequest, type Id, type Session, type StudioBot } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { boundedText, HostError, isRemoteCopy } from "../../core/shared.js";
import type { DutyFeature } from "../duty/service.js";
import { BotWebhookBridge } from "./webhooks.js";

interface BotRow {
  id: Id;
  data: string;
  task_id: Id | null;
  home_session_id: Id | null;
}

interface RequestRow {
  data: string;
  session_id: Id | null;
  delivered: number;
}

function readBot(row: BotRow): StudioBot {
  return { ...(JSON.parse(row.data) as BotInput), id: row.id, taskId: row.task_id, homeSessionId: row.home_session_id };
}

function readRequest(row: RequestRow): BotRequest {
  return { ...(JSON.parse(row.data) as BotRequest), sessionId: row.session_id };
}

const inboxId = (id: Id) => `bot-request:${id}`;
const AVATAR_PREFIX = "data:image/png;base64,";
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function botAvatar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.startsWith(AVATAR_PREFIX) && value.length <= 96_000) {
    const payload = value.slice(AVATAR_PREFIX.length);
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length >= 45 && bytes.subarray(0, 16).equals(PNG_HEADER) && bytes.toString("base64") === payload) {
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width === height && width >= 1 && width <= 128) return value;
    }
  }
  throw new HostError("bad_request", "头像格式无效，请重新选择图片。");
}
type SavedPost = Omit<BotGroupPost, "replies">;
const groupAskId = (group: Id, post: Id, bot: Id) => createHash("sha256").update(JSON.stringify([group, post, bot])).digest("hex");

export class BotsFeature extends Feature<"tasks" | "sessions"> {
  private readonly operations = new Map<Id, Promise<unknown>>();
  private hookBridge?: BotWebhookBridge;
  get webhooks(): BotWebhookBridge {
    return this.hookBridge ??= new BotWebhookBridge(this.teamLink, this.store, (botId, id, text) => this.request(botId, { id, text, destination: "new" }));
  }

  list(): StudioBot[] {
    return (this.store.db.prepare("SELECT * FROM studio_bots ORDER BY name_key").all() as unknown as BotRow[]).map(readBot);
  }

  private bot(id: Id): StudioBot {
    const row = this.store.db.prepare("SELECT * FROM studio_bots WHERE id = ?").get(id) as unknown as BotRow | undefined;
    if (!row) throw new HostError("not_found", "找不到这个 Bot。");
    return readBot(row);
  }

  listWebhooks(id: Id) { this.bot(id); return this.webhooks.list(id); }
  addWebhook(id: Id, allowResult: boolean) { this.bot(id); return this.webhooks.add(id, allowResult); }
  removeWebhook(id: Id, hookId: Id) { this.bot(id); return this.webhooks.remove(id, hookId); }

  dutyJob(): NonNullable<DutyFeature["botJob"]> {
    return {
      check: (id) => { this.bot(id); },
      run: async (action, run) => {
        const bot = this.bot(action.botId);
        if (!bot.enabled) return { ok: true, skipped: true, summary: "Bot 已停用。" };
        const id = createHash("sha256").update(`${run.itemId}:${run.startedAt}`).digest("hex");
        const request = await this.request(bot.id, { id, destination: "new", text: action.prompt });
        if (request.status === "failed" || !request.sessionId) return { ok: false, summary: request.result ?? "未能启动 Bot。" };
        return { ok: true, summary: `已派给「${bot.name}」`, sessionId: request.sessionId, taskId: request.taskId };
      },
    };
  }

  save(raw: Record<string, unknown>, id?: Id): StudioBot {
    const previous = id ? this.bot(id) : null;
    const name = boundedText(raw.name, "名称", 40);
    if (/[\r\n@]/u.test(name)) throw new HostError("bad_request", "Bot 名称不能包含换行或 @。");
    const nameKey = name.normalize("NFKC").toLowerCase();
    const profileId = boundedText(raw.profileId, "模型配置", 200);
    const profile = this.requireProfile(profileId);
    if (profile.runtime !== "codex" || profile.unavailable) throw new HostError("bad_request", "请选择可用的 Codex 配置。");
    const workspaceId = raw.workspaceId === null ? null : boundedText(raw.workspaceId, "项目", 200);
    if (workspaceId) this.requireLiveWorkspace(workspaceId);
    if (typeof raw.enabled !== "boolean" || typeof raw.memory !== "string" || raw.memory.length > 32_000) {
      throw new HostError("bad_request", "请检查 Bot 的启用状态和记忆长度。");
    }
    const avatar = raw.avatar === undefined ? previous?.avatar ?? null : botAvatar(raw.avatar);
    const data: BotInput = { name, avatar, profileId, workspaceId, enabled: raw.enabled, purpose: boundedText(raw.purpose, "职责", 8000), memory: raw.memory.trim() };
    const botId = previous?.id ?? randomUUID();
    this.store.transaction(() => {
      const used = this.store.db.prepare("SELECT id FROM studio_bots WHERE name_key = ? AND id <> ?").get(nameKey, botId);
      if (used) throw new HostError("conflict", "已有同名 Bot。");
      this.store.db.prepare(`INSERT INTO studio_bots (id, name_key, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name_key = excluded.name_key, data = excluded.data`).run(botId, nameKey, JSON.stringify(data));
    });
    return this.bot(botId);
  }

  chats(id: Id): Session[] {
    const { taskId } = this.bot(id);
    return taskId ? this.store.listSessions({ taskId }).filter((s) => !s.parentId && s.kind === "main") : [];
  }

  groups(): BotGroup[] {
    const rows = this.store.db.prepare("SELECT data FROM studio_bot_groups ORDER BY name_key").all() as unknown as { data: string }[];
    return rows.map(({ data }) => JSON.parse(data) as BotGroup);
  }

  private group(id: Id): BotGroup {
    const row = this.store.db.prepare("SELECT data FROM studio_bot_groups WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) throw new HostError("not_found", "找不到这个 Bot 群组。");
    return JSON.parse(row.data) as BotGroup;
  }

  saveGroup(raw: Record<string, unknown>, id?: Id): BotGroup {
    if (id) this.group(id);
    const name = boundedText(raw.name, "群组名称", 40);
    if (/[\r\n]/u.test(name)) throw new HostError("bad_request", "群组名不能包含换行。");
    const memberIds = this.botIds(raw.memberIds);
    for (const memberId of memberIds) this.bot(memberId);
    const group = { id: id ?? randomUUID(), name, memberIds };
    const key = name.normalize("NFKC").toLowerCase();
    if (this.store.db.prepare("SELECT id FROM studio_bot_groups WHERE name_key = ? AND id <> ?").get(key, group.id)) throw new HostError("conflict", "已有同名群组。");
    this.store.db.prepare(`INSERT INTO studio_bot_groups (id, name_key, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, name_key = excluded.name_key`).run(group.id, key, JSON.stringify(group));
    return group;
  }

  private botIds(value: unknown): Id[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 30 || value.some((id: unknown) => typeof id !== "string" || !/^[\w-]{1,80}$/u.test(id))) {
      throw new HostError("bad_request", "请选择 1 至 30 个 Bot。");
    }
    return [...new Set<string>(value)];
  }

  posts(groupId: Id): BotGroupPost[] {
    this.group(groupId);
    const rows = this.store.db.prepare("SELECT data FROM studio_bot_group_posts WHERE group_id = ? ORDER BY created_at DESC LIMIT 100").all(groupId) as unknown as { data: string }[];
    return rows.map(({ data }) => this.readPost(groupId, JSON.parse(data) as SavedPost));
  }

  private readPost(groupId: Id, post: SavedPost): BotGroupPost {
    const replies = post.targetIds.flatMap((id) => {
      const request = this.getRequest(groupAskId(groupId, post.id, id));
      return request ? [this.status(request)] : [];
    });
    return { ...post, replies };
  }

  post(groupId: Id, raw: Record<string, unknown>): Promise<BotGroupPost> {
    return this.serial(`group:${groupId}`, async () => {
      const group = this.group(groupId);
      const id = boundedText(raw.id, "消息编号", 80);
      if (!/^[\w-]+$/u.test(id)) throw new HostError("bad_request", "消息编号有误。");
      const text = boundedText(raw.text, "消息", 20_000);
      const targetIds = this.botIds(raw.targetIds).sort();
      const old = this.store.db.prepare("SELECT group_id, data FROM studio_bot_group_posts WHERE id = ?").get(id) as { group_id: Id; data: string } | undefined;
      const previous = old ? JSON.parse(old.data) as SavedPost : undefined;
      if (previous && (old?.group_id !== groupId || previous.text !== text || JSON.stringify(previous.targetIds) !== JSON.stringify(targetIds))) throw new HostError("conflict", "消息编号已用于另一条群消息。");
      if (targetIds.some((target) => !group.memberIds.includes(target) || (!previous && !this.bot(target).enabled))) throw new HostError("bad_request", "请选择已启用的群组成员。");
      const record = previous ?? { id, text, targetIds, createdAt: new Date().toISOString() };
      if (!previous) this.store.db.prepare("INSERT INTO studio_bot_group_posts (id, group_id, created_at, data) VALUES (?, ?, ?, ?)").run(id, groupId, record.createdAt, JSON.stringify(record));
      await this.dispatchPost(group, record);
      return this.readPost(groupId, record);
    });
  }

  private async dispatchPost(group: BotGroup, record: SavedPost): Promise<void> {
    await Promise.all(record.targetIds.map(async (botId) => {
      const id = groupAskId(group.id, record.id, botId);
      if (!group.memberIds.includes(botId)) return;
      const prior = this.getRequest(id);
      const chat = this.store.db.prepare("SELECT session_id FROM studio_bot_group_chats WHERE group_id = ? AND bot_id = ?").get(group.id, botId) as { session_id: Id | null } | undefined;
      const session = chat?.session_id ? this.store.getSession(chat.session_id) : undefined;
      if (!prior && !this.bot(botId).enabled) return;
      const destination: BotDestination = prior?.destination ?? (session && !session.archivedAt ? { sessionId: session.id } : "new");
      const result = await this.request(botId, { id, text: prior?.text ?? `【群组 ${group.name}】\n${record.text}`.slice(0, 20_000), destination });
      if (result.sessionId && result.status !== "failed") {
        this.store.db.prepare(`INSERT INTO studio_bot_group_chats (group_id, bot_id, session_id) VALUES (?, ?, ?)
          ON CONFLICT(group_id, bot_id) DO UPDATE SET session_id = excluded.session_id`).run(group.id, botId, result.sessionId);
      }
    }));
    this.store.db.prepare("UPDATE studio_bot_group_posts SET dispatched = 1 WHERE id = ?").run(record.id);
  }

  home(id: Id, reset = false): Promise<Session> {
    return this.serial(id, () => this.openHome(this.bot(id), reset));
  }

  async request(id: Id, raw: Record<string, unknown>): Promise<BotRequest> {
    const requestId = boundedText(raw.id, "请求编号", 80);
    if (!/^[\w-]+$/u.test(requestId)) throw new HostError("bad_request", "请求编号有误。");
    return this.serial(id, async () => {
      const bot = this.bot(id);
      const text = boundedText(raw.text, "消息", 20_000);
      const source = raw.sourceSessionId === undefined ? null : this.requireSession(boundedText(raw.sourceSessionId, "发起会话", 200));
      if (source && (source.archivedAt || isRemoteCopy(source))) throw new HostError("bad_request", "请选择可用的本机会话。");
      const destination = this.destination(raw.destination);
      const previous = this.getRequest(requestId);
      if (previous) {
        if (previous.botId !== bot.id || previous.sourceSessionId !== (source?.id ?? null) || previous.text !== text || JSON.stringify(previous.destination) !== JSON.stringify(destination)) {
          throw new HostError("conflict", "请求编号已用于另一条 Bot 消息。");
        }
        return this.deliver(previous);
      }
      if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
      if (source?.taskId && source.taskId === bot.taskId) throw new HostError("bad_request", "请在当前 Bot 会话直接发送消息。");
      const queued: BotRequest = { id: requestId, botId: id, botName: bot.name, sourceSessionId: source?.id ?? null, destination, sessionId: null, text, createdAt: new Date().toISOString(), status: "queued" };
      this.store.db.prepare("INSERT INTO studio_bot_requests (id, bot_id, source_session_id, created_at, data) VALUES (?, ?, ?, ?, ?)").run(requestId, id, queued.sourceSessionId, queued.createdAt, JSON.stringify(queued));
      return this.deliver(queued);
    });
  }

  async worker(id: Id) {
    return this.serial(`worker:${id}`, async () => {
      const record = this.getRequest(id);
      if (!record) throw new HostError("not_found", "找不到 Bot 请求。");
      const previous = this.store.db.prepare("SELECT task_id FROM studio_bot_workers WHERE request_id = ?").get(id) as { task_id: Id } | undefined;
      if (previous) return { task: this.requireTask(previous.task_id), session: this.store.listSessions({ taskId: previous.task_id }).find((session) => !session.parentId) ?? null };
      const request = this.status(record);
      if (request.status !== "completed" || !request.result) throw new HostError("conflict", "Bot 提供结论后再创建执行任务。");
      const bot = this.bot(request.botId);
      const source = request.sourceSessionId ? this.store.getSession(request.sourceSessionId) : undefined;
      const workspaceId = source?.workspaceId ?? bot.workspaceId;
      const workspace = workspaceId ? this.requireLiveWorkspace(workspaceId) : null;
      if (!workspace || isCommon(workspace)) throw new HostError("bad_request", "请在 Git 项目中发起审核，或设置 Bot 的默认 Git 项目。");
      const title = `处理${bot.name}的结论 · ${request.text}`.slice(0, 80);
      const description = `【原请求】\n${request.text}\n\n【Bot 结论】\n${request.result}`;
      return this.f.tasks.createTask({ title, workspaceId: workspace.id, worktree: {}, description,
        firstSession: { profileId: bot.profileId, options: { permission: "workspace-write" }, text: `在这个独立 worktree 内核实并处理下列结论。先确认问题仍存在，保留验证证据。\n\n${description.slice(0, 12_000)}` },
      }, (task) => {
        this.store.db.prepare("INSERT INTO studio_bot_workers (request_id, task_id) VALUES (?, ?)").run(id, task.id);
      });
    });
  }

  requests(source: Id | null): BotRequest[] {
    const sql = source === null ? "SELECT * FROM studio_bot_requests ORDER BY created_at DESC LIMIT 100" : "SELECT * FROM studio_bot_requests WHERE source_session_id = ? ORDER BY created_at DESC LIMIT 100";
    const stmt = this.store.db.prepare(sql);
    return ((source === null ? stmt.all() : stmt.all(source)) as unknown as RequestRow[]).map((row) => this.status(this.fromRequestRow(row)));
  }

  recover(): void {
    this.host.on("event", (event) => {
      if (event.type !== "session.upserted") return;
      const rows = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE session_id = ? AND json_extract(data, '$.status') = 'queued'").all(event.session.id) as unknown as RequestRow[];
      for (const row of rows) this.status(readRequest(row));
    });
    const rows = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE delivered = 0 AND json_extract(data, '$.status') = 'queued'").all() as unknown as RequestRow[];
    for (const row of rows) {
      const request = readRequest(row);
      if (this.store.getItem(inboxId(request.id))) continue;
      void this.serial(request.botId, () => this.deliver(request)).catch((err: unknown) => this.log(`Bot request recovery failed: ${String(err)}`));
    }
    const posts = this.store.db.prepare("SELECT group_id, data FROM studio_bot_group_posts WHERE dispatched = 0 ORDER BY created_at").all() as unknown as { group_id: Id; data: string }[];
    for (const row of posts) {
      const post = JSON.parse(row.data) as SavedPost;
      void this.serial(`group:${row.group_id}`, () => this.dispatchPost(this.group(row.group_id), post)).catch((err: unknown) => this.log(`Bot group recovery failed: ${String(err)}`));
    }
  }

  private getRequest(id: Id): BotRequest | undefined {
    const row = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE id = ?").get(id) as unknown as RequestRow | undefined;
    return row ? this.fromRequestRow(row) : undefined;
  }

  private fromRequestRow(row: RequestRow): BotRequest {
    const request = readRequest(row);
    if (row.delivered && !row.session_id && request.status === "queued") return this.settled({ ...request, status: "stopped", result: "Bot 聊天已删除。" });
    return request;
  }

  private serial<T>(id: Id, action: () => Promise<T>): Promise<T> {
    const result = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    const release = () => { if (this.operations.get(id) === result) this.operations.delete(id); };
    this.operations.set(id, result);
    void result.then(release, release);
    return result;
  }

  private destination(raw: unknown): BotDestination {
    if (raw === undefined || raw === "home") return "home";
    if (raw === "new") return "new";
    if (raw && typeof raw === "object" && "sessionId" in raw) return { sessionId: boundedText(raw.sessionId, "目标会话", 200) };
    throw new HostError("bad_request", "请选择主聊天、已有聊天或新建聊天。");
  }

  private async openHome(bot: StudioBot, reset: boolean): Promise<Session> {
    if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
    const before = bot.homeSessionId ? this.store.getSession(bot.homeSessionId) : undefined;
    if (before && !before.archivedAt && !reset && before.profileId === bot.profileId) return before;
    if (before && (inTurn(before.status) || this.store.findItems(before.id, "user", { delivery: "held" }, { limit: 1 }).length)) {
      throw new HostError("conflict", "主聊天仍有待处理消息，完成后再新建主聊天。");
    }
    const session = await this.startChat(bot, "主聊天");
    this.store.db.prepare("UPDATE studio_bots SET home_session_id = ? WHERE id = ?").run(session.id, bot.id);
    return session;
  }

  private async startChat(bot: StudioBot, title: string, source?: Session): Promise<Session> {
    const workspace = bot.workspaceId ? this.requireLiveWorkspace(bot.workspaceId) : this.commonWorkspace();
    const task = bot.taskId ? this.requireTask(bot.taskId) : this.store.transaction(() => {
      const created = this.f.tasks.createTaskRecord({ title: bot.name, workspaceId: bot.workspaceId, column: "doing" });
      this.store.db.prepare("UPDATE studio_bots SET task_id = ? WHERE id = ?").run(created.id, bot.id);
      return created;
    });
    if (task.archivedAt) throw new HostError("conflict", "请先恢复 Bot 的任务。");
    const selected = source ? this.requireLiveWorkspace(source.workspaceId) : workspace;
    const developerInstructions = [`你是 ${bot.name}。`, `【职责】\n${bot.purpose}`, ...(bot.memory ? [`【记忆】\n${bot.memory}`] : [])].join("\n\n");
    return this.f.tasks.trackSessionStart(task.id, () => this.wrap(() => this.runtime.startSession({ taskId: task.id, topicId: null, profileId: bot.profileId, workspace: selected, ...(source?.cwd ? { cwd: source.cwd } : {}), title, developerInstructions, options: { permission: "read-only" } })));
  }

  private async deliver(request: BotRequest): Promise<BotRequest> {
    if (request.status !== "queued" || this.store.getItem(inboxId(request.id))) return this.status(request);
    const bot = this.bot(request.botId);
    try {
      if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
      const source = request.sourceSessionId ? this.store.getSession(request.sourceSessionId) : undefined;
      if (request.sourceSessionId && (!source || source.archivedAt)) throw new HostError("conflict", "发起会话已不可用。");
      const selected = request.destination;
      const session = request.sessionId ? this.requireSession(request.sessionId)
        : selected === "home" ? await this.openHome(bot, false)
        : selected === "new" ? await this.startChat(bot, request.text.slice(0, 50), source)
        : this.requireSession(selected.sessionId);
      const currentBot = this.bot(bot.id);
      if (!currentBot.taskId || session.taskId !== currentBot.taskId || session.archivedAt || session.kind !== "main" || session.runtime !== "codex") {
        throw new HostError("bad_request", "请选择该 Bot 的有效聊天。");
      }
      this.store.db.prepare("UPDATE studio_bot_requests SET session_id = ? WHERE id = ?").run(session.id, request.id);
      request = { ...request, sessionId: session.id };
      const cwd = source && (source.cwd ?? this.store.getWorkspace(source.workspaceId)?.path);
      const text = [`你是 ${bot.name}。`, `【职责】\n${bot.purpose}`, ...(bot.memory ? [`【记忆】\n${bot.memory}`] : []), ...(cwd ? [`【本次任务的工作目录】\n${cwd}`] : []), `【本次请求】\n${request.text}`].join("\n\n");
      await this.f.sessions.inbox.put(session.id, text, undefined, inboxId(request.id));
      this.store.db.prepare("UPDATE studio_bot_requests SET delivered = 1 WHERE id = ?").run(request.id);
      return this.status(request);
    } catch (error) {
      const failed: BotRequest = { ...request, status: "failed", result: error instanceof Error ? error.message : String(error) };
      this.store.db.prepare("UPDATE studio_bot_requests SET data = ? WHERE id = ?").run(JSON.stringify(failed), request.id);
      return failed;
    }
  }

  private status(request: BotRequest): BotRequest {
    if (request.status !== "queued" || !request.sessionId) return request;
    const session = this.store.getSession(request.sessionId);
    const message = this.store.getItem(inboxId(request.id));
    if (!session || message?.type !== "user") return request;
    if (session.taskId) request = { ...request, taskId: session.taskId };
    if (message.delivery === "expired" || message.delivery === "unsent") return this.settled({ ...request, status: "stopped" });
    const turnId = message.raw?.turnId;
    if (!turnId) return session.archivedAt ? this.settled({ ...request, status: "stopped" }) : request;
    const [turn] = this.store.findItems(session.id, "turn", { turnId }, { newest: true, limit: 1 });
    if (turn?.type !== "turn") return request;
    if (turn.state === "running") return { ...request, status: session.status === "awaiting-answer" || session.status === "awaiting-approval" ? "waiting" : "running" };
    if (turn.state === "interrupted") return this.settled({ ...request, status: "stopped" });
    if (turn.state === "failed") return this.settled({ ...request, status: "failed", result: turn.error });
    const reply = this.store.listItems(session.id, turn.seq).filter((i) => i.type === "agent" && i.raw?.turnId === turnId).at(-1);
    return this.settled({ ...request, status: "completed", result: reply?.type === "agent" ? reply.markdown.slice(0, 4000) : undefined });
  }

  private settled(request: BotRequest): BotRequest {
    this.store.db.prepare("UPDATE studio_bot_requests SET data = ?, delivered = 1 WHERE id = ?").run(JSON.stringify(request), request.id);
    return request;
  }
}
