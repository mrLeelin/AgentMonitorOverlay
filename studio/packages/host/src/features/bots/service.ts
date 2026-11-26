import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_BOT_PREFERENCES, inTurn, isCommon, type BotDestination, type BotGroup, type BotGroupPost, type BotInput, type BotPreferences, type BotRequest, type BotSidebarData, type Id, type Session, type SessionItem, type StudioBot } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { boundedText, HostError, isRemoteCopy } from "../../core/shared.js";
import type { DutyFeature } from "../duty/service.js";
import { BotWebhookBridge } from "./webhooks.js";
import { assertBotsEnabled, botsEnabled, botInstructions, botPermission, isBotTask } from "./data.js";
import { botMascotId, supportsBotRuntime } from "@amo-studio/protocol";
import { botSkillPrompt, botSkillRefs, readBotSkills, saveSharedBotSkills, sharedBotSkills } from "./skills.js";
import { BOT_MEMORY_SUMMARY, ensureBotFiles, listBotNotes, readBotFiles, readBotNote, removeBotFiles, updateBotFiles, writeBotNote } from "./files.js";

interface BotRow {
  id: Id;
  data: string;
  task_id: Id | null;
  home_session_id: Id | null;
}

type GroupRequest = { groupId: Id; postId: Id };
type SavedRequest = BotRequest & { group?: GroupRequest };

interface RequestRow {
  data: string;
  session_id: Id | null;
  delivered: number;
}

function readRequest(row: RequestRow): SavedRequest {
  return { ...(JSON.parse(row.data) as SavedRequest), sessionId: row.session_id };
}

const inboxId = (id: Id) => `bot-request:${id}`;
const AVATAR_PREFIX = "data:image/png;base64,";
const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

function botAvatar(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && botMascotId(value)) return value;
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
type SavedPost = Pick<BotGroupPost, "id" | "text" | "targetIds" | "createdAt" | "author">;
type PostRow = { group_id: Id; data: string; dispatched: number };
const groupAskId = (group: Id, post: Id, bot: Id) => createHash("sha256").update(JSON.stringify([group, post, bot])).digest("hex");
const activeBot = "json_extract(data, '$.deletedAt') IS NULL";

function botName(value: unknown): string {
  const name = boundedText(value, "名称", 40);
  if (/[\r\n@\u0000]/u.test(name)) throw new HostError("bad_request", "Bot 名称不能包含控制字符或 @。");
  return name;
}

function botPreferences(value: unknown, previous?: BotPreferences): BotPreferences | undefined {
  if (value === undefined) return previous;
  const data = value as Partial<BotPreferences> | null;
  if (!data || typeof data.allowGroupAsk !== "boolean" || (data.inactiveDays !== 5 && data.inactiveDays !== 7 && data.inactiveDays !== 14)
      || !data.notifications || typeof data.notifications.approval !== "boolean" || typeof data.notifications.completed !== "boolean" || typeof data.notifications.failed !== "boolean") {
    throw new HostError("bad_request", "请检查 Bot 的访问、自动化和通知设置。");
  }
  return { allowGroupAsk: data.allowGroupAsk, inactiveDays: data.inactiveDays, notifications: {
    approval: data.notifications.approval, completed: data.notifications.completed, failed: data.notifications.failed,
  } };
}

export class BotsFeature extends Feature<"tasks" | "sessions"> {
  private readonly operations = new Map<Id, Promise<unknown>>();
  private readonly notified = new Set<Id>();
  private hookBridge?: BotWebhookBridge;
  get webhooks(): BotWebhookBridge {
    return this.hookBridge ??= new BotWebhookBridge(this.teamLink, this.store, (botId, id, text) => this.request(botId, { id, text, destination: "new" }));
  }

  list(): StudioBot[] {
    return this.botRows().map((row) => this.readBot(row, true));
  }

  private botRows(): BotRow[] {
    return this.store.db.prepare(`SELECT * FROM studio_bots WHERE ${activeBot} ORDER BY name_key`).all() as unknown as BotRow[];
  }

  private readBot(row: BotRow, listOnly = false): StudioBot {
    const data = JSON.parse(row.data) as BotInput;
    let content: BotInput;
    try { content = readBotFiles(this.store, row.id, data); }
    catch (error) {
      // Keep the roster accessible if one Bot has a broken local file. Opening or saving it still reports the file error.
      if (!listOnly) throw error;
      content = data;
    }
    return { ...content, id: row.id, taskId: row.task_id, homeSessionId: row.home_session_id };
  }

  sidebar(): BotSidebarData {
    const latest = this.store.db.prepare(`SELECT b.id, (
      SELECT substr(json_extract(i.body, '$.markdown'), 1, 180)
      FROM sessions s JOIN items i ON i.session_id = s.id
      WHERE s.task_id = b.task_id AND s.kind = 'main' AND s.archived_at IS NULL AND i.type = 'agent'
      ORDER BY i.created_at DESC, i.seq DESC LIMIT 1
    ) AS preview FROM studio_bots b WHERE b.task_id IS NOT NULL AND ${activeBot}`).all() as { id: Id; preview: string | null }[];
    const workers = this.store.db.prepare(`SELECT r.bot_id AS botId, w.task_id AS taskId
      FROM studio_bot_workers w JOIN studio_bot_requests r ON r.id = w.request_id`).all() as BotSidebarData["workers"];
    return { previews: Object.fromEntries(latest.flatMap(({ id, preview }) => preview ? [[id, preview.replace(/\s+/gu, " ").trim()]] : [])), workers };
  }

  private bot(id: Id): StudioBot {
    const bot = this.findBot(id);
    if (!bot) throw new HostError("not_found", "找不到这个 Bot。");
    return bot;
  }

  private findBot(id: Id): StudioBot | undefined {
    const row = this.store.db.prepare(`SELECT * FROM studio_bots WHERE id = ? AND ${activeBot}`).get(id) as unknown as BotRow | undefined;
    return row && this.readBot(row);
  }

  files(id: Id) {
    const folder = ensureBotFiles(this.store, id, this.bot(id));
    return { folder, notes: listBotNotes(folder) };
  }

  note(id: Id, name: string) { return { text: readBotNote(this.files(id).folder, name) }; }

  saveNote(id: Id, name: string, raw: Record<string, unknown>) {
    if (typeof raw.expected !== "string" && raw.expected !== null) throw new HostError("bad_request", "请先打开记忆文件再保存。");
    if (name === BOT_MEMORY_SUMMARY) throw new HostError("read_only", "这份文件由记忆整理更新。请把要保留的内容复制到长期记忆或新笔记。");
    writeBotNote(this.files(id).folder, name, raw.text, raw.expected);
    this.publish({ type: "bot-files.changed", botId: id });
    return this.files(id);
  }

  listWebhooks(id: Id) { this.bot(id); return this.webhooks.list(id); }
  addWebhook(id: Id, allowResult: boolean) { this.bot(id); return this.webhooks.add(id, allowResult); }
  removeWebhook(id: Id, hookId: Id) { this.bot(id); return this.webhooks.remove(id, hookId); }

  dutyJob(): NonNullable<DutyFeature["botJob"]> {
    return {
      check: (id) => { this.bot(id); },
      run: async (action, run) => {
        if (!botsEnabled(this.store)) return { ok: true, skipped: true, summary: "Bots 已关闭。" };
        const bot = this.findBot(action.botId);
        if (!bot) return { ok: true, skipped: true, summary: "Bot 已删除。" };
        if (!bot.enabled) return { ok: true, skipped: true, summary: "Bot 已停用。" };
        if (action.job === "memory") return this.organizeMemory(bot);
        const id = createHash("sha256").update(`${run.itemId}:${run.startedAt}`).digest("hex");
        const request = await this.request(bot.id, { id, destination: "new", text: action.prompt });
        if (request.status === "failed" || !request.sessionId) return { ok: false, summary: request.result ?? "未能启动 Bot。" };
        return { ok: true, summary: `已派给「${bot.name}」`, sessionId: request.sessionId, taskId: request.taskId };
      },
    };
  }

  private organizeMemory(bot: StudioBot) {
    const rows = this.store.db.prepare(`SELECT * FROM studio_bot_requests WHERE bot_id = ? AND json_extract(data, '$.status') = 'completed'
      AND length(json_extract(data, '$.result')) > 0 ORDER BY created_at DESC, id DESC LIMIT 12`).all(bot.id) as unknown as RequestRow[];
    if (!rows.length) return { ok: true, skipped: true, summary: "暂无可整理的已完成请求。" };
    const folder = ensureBotFiles(this.store, bot.id, bot);
    const sections = rows.map((row) => {
      const request = readRequest(row);
      return `## ${request.settledAt ?? request.createdAt}\n\n${request.text.slice(0, 500)}\n\n${request.result!.slice(0, 1700)}`;
    });
    writeBotNote(folder, BOT_MEMORY_SUMMARY, ["# 近期已完成的 Bot 请求", ...sections].join("\n\n"), undefined);
    this.publish({ type: "bot-files.changed", botId: bot.id });
    return { ok: true, summary: `已整理 ${rows.length} 条请求到 memory/${BOT_MEMORY_SUMMARY}。` };
  }

  save(raw: Record<string, unknown>, id?: Id): StudioBot {
    if (!id) assertBotsEnabled(this.store);
    const previous = id ? this.bot(id) : undefined;
    const expected = raw.expectedFiles as Partial<Pick<BotInput, "purpose" | "memory">> | null | undefined;
    if (expected !== undefined && (!expected || !previous || expected.purpose !== previous.purpose || expected.memory !== previous.memory)) {
      throw new HostError("conflict", "Bot 的职责或长期记忆已变化，请重新打开设置后再保存。");
    }
    const name = botName(raw.name);
    const profileId = boundedText(raw.profileId, "模型配置", 200);
    const profile = this.requireProfile(profileId);
    if (!supportsBotRuntime(profile.runtime) || profile.unavailable) throw new HostError("bad_request", "请选择可运行 Bot 的 AMO 模型渠道。");
    const sameProfile = previous?.profileId === profileId;
    const model = raw.model === undefined ? (sameProfile ? previous?.model : null) : raw.model === null ? null : boundedText(raw.model, "模型", 256);
    const sameModel = sameProfile && previous?.model === model;
    const effort = raw.effort === undefined ? (sameModel ? previous?.effort : null) : raw.effort === null ? null : boundedText(raw.effort, "推理强度", 50);
    const fast = raw.fast === undefined ? (sameModel ? previous?.fast : null) : raw.fast;
    if (fast != null && (typeof fast !== "boolean" || profile.runtime === "dsh")) throw new HostError("bad_request", "请检查模型的快速模式设置。");
    const claudeBaseUrl = profile.provider ? this.options.channels?.claudeProviders[profile.provider]?.baseUrl : undefined;
    const permission = botPermission(raw.permission === undefined && sameProfile ? previous?.permission : raw.permission, profile.runtime, claudeBaseUrl);
    const workspaceId = raw.workspaceId === null ? null : boundedText(raw.workspaceId, "项目", 200);
    if (workspaceId) this.requireLiveWorkspace(workspaceId);
    if (typeof raw.enabled !== "boolean" || typeof raw.memory !== "string" || raw.memory.length > 32_000) {
      throw new HostError("bad_request", "请检查 Bot 的启用状态和记忆长度。");
    }
    const avatar = raw.avatar === undefined ? previous?.avatar ?? null : botAvatar(raw.avatar);
    const skills = raw.skills === undefined ? previous?.skills : botSkillRefs(raw.skills);
    const preferences = botPreferences(raw.preferences, previous?.preferences);
    const data: BotInput = { name, avatar, profileId, model: model ?? null, effort: effort ?? null, fast: fast ?? null, permission, workspaceId, enabled: raw.enabled, purpose: boundedText(raw.purpose, "职责", 8000), memory: raw.memory.trim(), ...(skills ? { skills } : {}), ...(preferences ? { preferences } : {}) };
    return this.writeBot(data, previous);
  }

  sharedSkills() {
    return sharedBotSkills(this.store);
  }

  async saveSharedSkills(raw: unknown) {
    const skills = botSkillRefs(raw, true);
    const previous = new Set(this.sharedSkills().map((skill) => skill.id));
    if (skills.some((skill) => !previous.has(skill.id))) {
      const known = new Set((await readBotSkills(this.store.path, this.options, this.runtime)).skills.map((skill) => skill.id));
      if (skills.some((skill) => !previous.has(skill.id) && !known.has(skill.id))) throw new HostError("bad_request", "共有技能请选择本机公共 Agent 技能。");
    }
    saveSharedBotSkills(this.store, skills);
    this.publish({ type: "bots.changed" });
    return skills;
  }

  async skillCatalog(raw: Record<string, unknown>) {
    const profile = raw.profileId === undefined ? undefined : this.requireProfile(boundedText(raw.profileId, "模型配置", 200));
    if (profile && !supportsBotRuntime(profile.runtime)) throw new HostError("bad_request", "请选择可运行 Bot 的 AMO 模型渠道。");
    const workspaceId = profile ? this.optionalWorkspace(raw.workspaceId) : null;
    const workspace = profile ? (workspaceId ? this.requireLiveWorkspace(workspaceId) : this.commonWorkspace()) : undefined;
    return readBotSkills(this.store.path, this.options, this.runtime, profile, workspace, { project: !!workspaceId, includeCache: true });
  }

  async chatSkillContext(input: Parameters<BotsFeature["runtime"]["startSession"]>[0]) {
    if (!input.taskId || input.resumeFrom) return undefined;
    const row = this.store.db.prepare("SELECT data FROM studio_bots WHERE task_id = ?").get(input.taskId) as { data: string } | undefined;
    if (!row) return undefined;
    const bot = JSON.parse(row.data) as BotInput;
    const assigned = [...new Map([...this.sharedSkills(), ...(bot.skills ?? [])].map((skill) => [skill.id, skill])).values()];
    if (!assigned.length) return undefined;
    const profile = this.requireProfile(input.profileId);
    const workspace = input.cwd ? { ...input.workspace, path: input.cwd } : input.workspace;
    const catalog = await readBotSkills(this.store.path, this.options, this.runtime, profile, workspace, { project: !isCommon(workspace) });
    return botSkillPrompt(assigned, catalog);
  }

  patch(id: Id, raw: Record<string, unknown>): StudioBot {
    const previous = this.bot(id);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") throw new HostError("bad_request", "Bot 启用状态无效。");
    const { id: _id, taskId: _taskId, homeSessionId: _homeSessionId, ...data } = previous;
    return this.writeBot({ ...data, name: raw.name === undefined ? previous.name : botName(raw.name), enabled: raw.enabled ?? previous.enabled }, previous);
  }

  private writeBot(data: BotInput, previous?: StudioBot): StudioBot {
    const nameKey = data.name.normalize("NFKC").toLowerCase();
    const botId = previous?.id ?? randomUUID();
    const used = this.store.db.prepare("SELECT id FROM studio_bots WHERE name_key = ? AND id <> ?").get(nameKey, botId);
    if (used) throw new HostError("conflict", "已有同名 Bot。");
    const renamed = updateBotFiles(this.store, botId, data, previous, () => this.store.transaction(() => {
      this.store.db.prepare(`INSERT INTO studio_bots (id, name_key, data) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name_key = excluded.name_key, data = excluded.data`).run(botId, nameKey, JSON.stringify(data));
      return previous?.taskId && previous.name !== data.name ? this.store.updateTask(previous.taskId, { title: data.name }) : undefined;
    }));
    if (renamed) this.publish({ type: "task.upserted", task: renamed });
    this.publish({ type: "bots.changed" });
    return this.bot(botId);
  }

  remove(id: Id): Promise<{ ok: true }> {
    return this.serial(id, async () => {
      const bot = this.findBot(id);
      if (!bot) return { ok: true };
      const sessions = bot.taskId ? this.store.listSessions({ taskId: bot.taskId }) : [];
      if (sessions.some((session) => this.chatHasWork(session))) throw new HostError("conflict", "这个 Bot 还有运行或排队的消息，请处理完再删除。");
      const groups = this.groups().filter((group) => group.memberIds.includes(id));
      removeBotFiles(this.store, id, () => this.store.transaction(() => {
        // Keep the identity required by persisted replies and the read-only ownership of its historical chats.
        this.store.db.prepare("UPDATE studio_bots SET name_key = ?, data = ?, home_session_id = NULL WHERE id = ?")
          .run(`\u0000${id}`, JSON.stringify({ name: bot.name, enabled: false, deletedAt: new Date().toISOString() }), id);
        this.store.db.prepare("DELETE FROM studio_bot_group_chats WHERE bot_id = ?").run(id);
        const update = this.store.db.prepare("UPDATE studio_bot_groups SET data = ? WHERE id = ?");
        for (const group of groups) update.run(JSON.stringify({ ...group, memberIds: group.memberIds.filter((member) => member !== id) }), group.id);
      }));
      this.publish({ type: "bots.changed" });
      if (groups.length) this.publish({ type: "bot-groups.changed" });
      return { ok: true };
    });
  }

  private chatHasWork(session: Session): boolean {
    return !session.archivedAt && (inTurn(session.status) || session.goal?.status === "active" || this.f.sessions.inbox.isDispatching(session.id) ||
      (["held", "waiting"] as const).some((delivery) => this.store.findItems(session.id, "user", { delivery }, { limit: 1 }).length > 0));
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
    assertBotsEnabled(this.store);
    const previous = id ? this.group(id) : undefined;
    const memberIds = this.botIds(raw.memberIds);
    for (const memberId of memberIds) this.bot(memberId);
    return this.writeGroup({ id: previous?.id ?? randomUUID(), name: boundedText(raw.name, "群组名称", 40), memberIds });
  }

  patchGroup(id: Id, raw: Record<string, unknown>): BotGroup {
    assertBotsEnabled(this.store);
    const group = this.group(id);
    if (raw.name !== undefined) group.name = boundedText(raw.name, "群组名称", 40);
    if (raw.memberIds !== undefined) {
      group.memberIds = this.botIds(raw.memberIds);
      for (const memberId of group.memberIds) this.bot(memberId);
    }
    return this.writeGroup(group);
  }

  private writeGroup(group: BotGroup): BotGroup {
    if (/[\r\n]/u.test(group.name)) throw new HostError("bad_request", "群组名不能包含换行。");
    const key = group.name.normalize("NFKC").toLowerCase();
    if (this.store.db.prepare("SELECT id FROM studio_bot_groups WHERE name_key = ? AND id <> ?").get(key, group.id)) throw new HostError("conflict", "已有同名群组。");
    this.store.db.prepare(`INSERT INTO studio_bot_groups (id, name_key, data) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, name_key = excluded.name_key`).run(group.id, key, JSON.stringify(group));
    this.publish({ type: "bot-groups.changed" });
    return group;
  }

  removeGroup(id: Id): Promise<{ ok: true }> {
    return this.serial(`group:${id}`, async () => {
      const chats = this.store.db.prepare("SELECT session_id FROM studio_bot_group_chats WHERE group_id = ?").all(id) as { session_id: Id | null }[];
      if (chats.some(({ session_id }) => {
        const session = session_id ? this.store.getSession(session_id) : undefined;
        return session && this.chatHasWork(session);
      })) throw new HostError("conflict", "这个群组还有运行或排队的消息，请处理完再删除。");
      const deleted = this.store.transaction(() => {
        this.store.db.prepare("DELETE FROM studio_bot_group_chats WHERE group_id = ?").run(id);
        this.store.db.prepare("DELETE FROM studio_bot_group_posts WHERE group_id = ?").run(id);
        return this.store.db.prepare("DELETE FROM studio_bot_groups WHERE id = ?").run(id).changes;
      });
      if (deleted) this.publish({ type: "bot-groups.changed" });
      return { ok: true };
    });
  }

  private botIds(value: unknown, minimum = 1): Id[] {
    if (!Array.isArray(value) || value.length < minimum || value.length > 30 || value.some((id: unknown) => typeof id !== "string" || !/^[\w-]{1,80}$/u.test(id))) {
      throw new HostError("bad_request", `请选择 ${minimum} 至 30 个 Bot。`);
    }
    return [...new Set<string>(value)];
  }

  posts(groupId: Id): BotGroupPost[] {
    this.group(groupId);
    const rows = this.store.db.prepare("SELECT data, dispatched FROM studio_bot_group_posts WHERE group_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(groupId) as unknown as PostRow[];
    return rows.map(({ data, dispatched }) => this.readPost(groupId, JSON.parse(data) as SavedPost, !!dispatched));
  }

  private readPost(groupId: Id, post: SavedPost, dispatchComplete: boolean): BotGroupPost {
    const replies = post.targetIds.flatMap((id) => {
      const request = this.getRequest(groupAskId(groupId, post.id, id));
      return request ? [this.status(request)] : [];
    });
    return { ...post, replies, dispatchComplete };
  }

  post(groupId: Id, raw: Record<string, unknown>): Promise<BotGroupPost> {
    return this.serial(`group:${groupId}`, async () => {
      const group = this.group(groupId);
      const id = boundedText(raw.id, "消息编号", 80);
      if (!/^[\w-]+$/u.test(id)) throw new HostError("bad_request", "消息编号有误。");
      const text = boundedText(raw.text, "消息", 20_000);
      const targetIds = this.botIds(raw.targetIds, 0).sort();
      const old = this.store.db.prepare("SELECT group_id, data, dispatched FROM studio_bot_group_posts WHERE id = ?").get(id) as PostRow | undefined;
      const previous = old ? JSON.parse(old.data) as SavedPost : undefined;
      if (previous && (previous.author || old?.group_id !== groupId || previous.text !== text || JSON.stringify(previous.targetIds) !== JSON.stringify(targetIds))) throw new HostError("conflict", "消息编号已用于另一条群消息。");
      if (previous && old?.dispatched) return this.readPost(groupId, previous, true);
      const record = previous ?? { id, text, targetIds, createdAt: new Date().toISOString() };
      if (!previous) {
        assertBotsEnabled(this.store);
        if (targetIds.some((target) => !group.memberIds.includes(target) || !this.findBot(target)?.enabled)) throw new HostError("bad_request", "请选择已启用的群组成员。");
        this.insertGroupPost(groupId, record);
      }
      await this.dispatchPost(group, record);
      return this.readPost(groupId, record, true);
    });
  }

  private insertGroupPost(groupId: Id, post: SavedPost): void {
    this.store.db.prepare("INSERT INTO studio_bot_group_posts (id, group_id, created_at, data) VALUES (?, ?, ?, ?)").run(post.id, groupId, post.createdAt, JSON.stringify(post));
    this.publish({ type: "bot-group-posts.changed", groupId });
  }

  async askGroupMember(sessionId: Id, requestId: Id, botId: Id, rawText: string): Promise<BotGroupPost> {
    const request = this.getRequest(requestId);
    if (!request?.group || request.sessionId !== sessionId) throw new HostError("bad_request", "找不到本会话的群组请求。");
    const { groupId, postId } = request.group;
    const questionId = createHash("sha256").update(JSON.stringify(["bot-group-question", requestId, botId])).digest("hex");
    const text = boundedText(rawText, "问题", 20_000);
    return this.serial(`group:${groupId}`, async () => {
      assertBotsEnabled(this.store);
      const group = this.group(groupId);
      const session = this.requireSession(sessionId);
      const message = this.store.getItem(inboxId(requestId));
      const [turn] = this.store.findItems(sessionId, "turn", {}, { newest: true, limit: 1 });
      if (session.archivedAt || !inTurn(session.status) || message?.type !== "user" || message.delivery !== undefined || !message.raw?.itemId
        || turn?.type !== "turn" || turn.state !== "running" || turn.turnId !== message.raw.turnId) {
        throw new HostError("bad_request", "只能在处理当前群组消息时向成员提问。");
      }
      const sourcePost = this.groupPost(groupId, postId);
      if (!sourcePost || sourcePost.author) throw new HostError("bad_request", "请直接回复这条 Bot 提问。收到用户的新消息后可以继续转问。");
      if (botId === request.botId || !group.memberIds.includes(botId) || !group.memberIds.includes(request.botId)
        || !this.findBot(botId)?.enabled || !this.findBot(request.botId)?.enabled) {
        throw new HostError("bad_request", "请选择这个群里另一位已启用的成员。");
      }
      if (this.findBot(botId)?.preferences?.allowGroupAsk === false) throw new HostError("read_only", "这个 Bot 不接收其他 Bot 的提问。");
      const old = this.store.db.prepare("SELECT group_id, data, dispatched FROM studio_bot_group_posts WHERE id = ?").get(questionId) as PostRow | undefined;
      const previous = old && JSON.parse(old.data) as SavedPost;
      if (old && (!previous?.author || previous.author.botId !== request.botId || old.group_id !== groupId || previous.text !== text)) {
        throw new HostError("conflict", "这条消息已经向该成员提过问。");
      }
      const post = previous ?? { id: questionId, text, targetIds: [botId], createdAt: new Date().toISOString(), author: { botId: request.botId, botName: request.botName } };
      if (!previous) this.insertGroupPost(groupId, post);
      if (!old?.dispatched) await this.dispatchPost(group, post);
      return this.readPost(groupId, post, true);
    });
  }

  private groupPost(groupId: Id, postId: Id): SavedPost | undefined {
    const row = this.store.db.prepare("SELECT data FROM studio_bot_group_posts WHERE group_id = ? AND id = ?").get(groupId, postId) as { data: string } | undefined;
    return row && JSON.parse(row.data) as SavedPost;
  }

  private async dispatchPost(group: BotGroup, record: SavedPost): Promise<void> {
    await Promise.all(record.targetIds.map(async (botId) => {
      const id = groupAskId(group.id, record.id, botId);
      if (!this.group(group.id).memberIds.includes(botId)) return;
      const prior = this.getRequest(id);
      const bot = this.findBot(botId);
      if (!bot?.enabled || !botsEnabled(this.store) || (record.author && bot.preferences?.allowGroupAsk === false && !prior)) return;
      const chat = this.store.db.prepare("SELECT session_id FROM studio_bot_group_chats WHERE group_id = ? AND bot_id = ?").get(group.id, botId) as { session_id: Id | null } | undefined;
      const session = chat?.session_id ? this.store.getSession(chat.session_id) : undefined;
      const destination: BotDestination = prior?.destination ?? (session && !session.archivedAt ? { sessionId: session.id } : "new");
      let result: BotRequest;
      try {
        result = await this.request(botId, { id, text: prior?.text ?? record.text, destination }, false, { groupId: group.id, postId: record.id });
      } catch (error) {
        // A Bot can be paused or removed while its earlier dispatch holds its lock.
        if (!this.findBot(botId)?.enabled || !botsEnabled(this.store)) return;
        throw error;
      }
      if (!this.findBot(botId)) return;
      if (result.sessionId && result.status !== "failed") {
        this.store.db.prepare(`INSERT INTO studio_bot_group_chats (group_id, bot_id, session_id) VALUES (?, ?, ?)
          ON CONFLICT(group_id, bot_id) DO UPDATE SET session_id = excluded.session_id`).run(group.id, botId, result.sessionId);
      }
    }));
    this.store.db.prepare("UPDATE studio_bot_group_posts SET dispatched = 1 WHERE id = ?").run(record.id);
    this.publish({ type: "bot-group-posts.changed", groupId: group.id });
  }

  stopGroupReply(groupId: Id, postId: Id, botId: Id): Promise<{ ok: true }> {
    return this.serial(botId, async () => {
      const post = this.store.db.prepare("SELECT data FROM studio_bot_group_posts WHERE group_id = ? AND id = ?").get(groupId, postId) as { data: string } | undefined;
      if (!post) throw new HostError("not_found", "找不到这条群聊消息。");
      const request = this.getRequest(groupAskId(groupId, postId, botId));
      if (!request || request.botId !== botId || !(JSON.parse(post.data) as SavedPost).targetIds.includes(botId)) throw new HostError("not_found", "这条 Bot 回复还没有开始。");
      const reply = this.status(request);
      if (reply.status !== "queued" && reply.status !== "running" && reply.status !== "waiting") return { ok: true };
      const item = this.store.getItem(inboxId(reply.id));
      if (item?.type === "user" && item.sessionId === reply.sessionId) {
        const turnId = item.raw?.itemId ? item.raw.turnId : undefined;
        if (item.delivery === "held") this.f.sessions.inbox.cancelBotRequest(item.sessionId, item.id);
        else if (item.delivery === undefined && turnId) await this.wrap(() => this.runtime.interrupt(item.sessionId, { expectedTurnId: turnId }));
        else throw new HostError("conflict", "回复正在启动，请稍后再试。");
      } else {
        this.settled({ ...reply, status: "stopped" });
      }
      this.publish({ type: "bot-group-posts.changed", groupId });
      return { ok: true };
    });
  }

  home(id: Id, reset = false): Promise<Session> {
    return this.serial(id, () => this.openHome(this.bot(id), reset));
  }

  mention(botId: Id, raw: Record<string, unknown>) {
    return this.mentionMany({ ...raw, recipients: [{ botId, destination: raw.destination }] });
  }

  mentionMany(raw: Record<string, unknown>) {
    const id = boundedText(raw.id, "提及编号", 80);
    if (!/^[\w-]+$/u.test(id)) throw new HostError("bad_request", "提及编号有误。");
    if (!Array.isArray(raw.recipients) || !raw.recipients.length) throw new HostError("bad_request", "请选择 Bot。");
    const recipients = raw.recipients.map((r: unknown) => {
      if (!r || typeof r !== "object" || !("botId" in r)) throw new HostError("bad_request", "Bot 无效。");
      return { botId: boundedText(r.botId, "Bot", 200), destination: this.destination("destination" in r ? r.destination : undefined) };
    });
    if (new Set(recipients.map((r) => r.botId)).size !== recipients.length) throw new HostError("bad_request", "Bot 重复。");
    return this.serial(`mention:${id}`, () => this.queueMention(recipients, id, raw));
  }

  private async queueMention(recipients: { botId: Id; destination: BotDestination }[], id: Id, raw: Record<string, unknown>) {
    assertBotsEnabled(this.store);
    const bots = recipients.map((r) => this.bot(r.botId));
    const source = this.requireSession(boundedText(raw.sourceSessionId, "发起会话", 200));
    if (bots.some((bot) => !bot.enabled) || isRemoteCopy(source) || source.kind === "sub" || isBotTask(this.store, source.taskId) || source.archivedAt || source.writer === "terminal-handoff") {
      throw new HostError("bad_request", "当前会话不能代为派发 Bot 请求。");
    }
    const text = boundedText(raw.text, "消息", 20_000);
    const binding = { kind: "mention" as const, ...recipients[0]!, text, ...(recipients.length > 1 ? { others: recipients.slice(1) } : {}) };
    const itemId = `bot-mention:${id}`;
    const previous = this.store.getItem(itemId);
    if (previous && (previous.sessionId !== source.id || previous.type !== "user" || JSON.stringify(previous.botLetter) !== JSON.stringify(binding))) throw new HostError("conflict", "提及编号已用于另一条消息。");
    const title = text.split(/\r?\n/, 1)[0]!.slice(0, 100);
    if (!source.title && !previous) await this.f.sessions.renameSession(source.id, title);
    const targets = bots.map((bot, i) => `「${bot.name}」的 mentionId 为 ${bots.length === 1 ? id : `${id}:${i + 1}`}`).join("；");
    const message = `${text}\n\n【AMO Bot 提及】${targets}。用户要求联系时，分别调用 bot_ask，text 写清给该 Bot 的问题和必要背景。仅讨论 Bot 时直接回答。派发完本次需要联系的所有 Bot 后结束本轮，各自的回信会陆续送达。`;
    this.f.sessions.inbox.resume(source.id);
    await this.f.sessions.inbox.put(source.id, message, undefined, itemId, { fromPerson: true, purpose: "work", botLetter: binding });
    return { ok: true as const };
  }

  async ask(sourceId: Id, mentionId: Id, text: string) {
    const match = /^([\w-]{1,80})(?::([1-9]\d*))?$/u.exec(mentionId);
    if (!match) throw new HostError("bad_request", "提及编号有误。");
    const item = this.store.getItem(`bot-mention:${match[1]}`);
    if (item?.type !== "user" || item.sessionId !== sourceId || !item.fromPerson || item.delivery === "expired" || item.delivery === "unsent") throw new HostError("bad_request", "找不到本会话的 Bot 提及。");
    const binding = item.botLetter;
    if (binding?.kind !== "mention") throw new HostError("bad_request", "消息未绑定 Bot。");
    const recipient = binding.others ? [binding, ...binding.others][Number(match[2]) - 1] : !match[2] ? binding : undefined;
    if (!recipient) throw new HostError("bad_request", "请选择这条消息里对应 Bot 的提及编号。");
    const id = createHash("sha256").update(`agent-mention:${mentionId}`).digest("hex");
    return this.request(recipient.botId, { id, text, sourceSessionId: sourceId, destination: recipient.destination }, true);
  }

  async request(id: Id, raw: Record<string, unknown>, reportToSource = false, group?: GroupRequest): Promise<BotRequest> {
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
        if (previous.botId !== bot.id || previous.sourceSessionId !== (source?.id ?? null) || previous.text !== text || JSON.stringify(previous.destination) !== JSON.stringify(destination)
          || (previous.group && (previous.group.groupId !== group?.groupId || previous.group.postId !== group?.postId))) {
          throw new HostError("conflict", "请求编号已用于另一条 Bot 消息。");
        }
        return this.deliver(previous);
      }
      assertBotsEnabled(this.store);
      if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
      if (source?.taskId && source.taskId === bot.taskId) throw new HostError("bad_request", "请在当前 Bot 会话直接发送消息。");
      const queued: SavedRequest = { id: requestId, botId: id, botName: bot.name, sourceSessionId: source?.id ?? null, destination, sessionId: null, text, createdAt: new Date().toISOString(), status: "queued", ...(reportToSource ? { reportToSource: true } : {}), ...(group ? { group } : {}) };
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
      assertBotsEnabled(this.store);
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
        firstSession: { profileId: bot.profileId, options: { model: bot.model ?? undefined, effort: bot.effort ?? undefined, fast: bot.fast ?? undefined, permission: this.requireProfile(bot.profileId).runtime === "claude" ? "acceptEdits" : "workspace-write" }, text: `在这个独立 worktree 内核实并处理下列结论。先确认问题仍存在，保留验证证据。\n\n${description.slice(0, 12_000)}` },
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
    for (const row of this.botRows()) {
      try { ensureBotFiles(this.store, row.id, JSON.parse(row.data)); }
      catch (error) { this.log(`Bot data folder migration failed for ${row.id}: ${String(error)}`); }
    }
    this.host.on("event", (event) => {
      if (event.type === "item.appended" || event.type === "item.updated") this.notifyForItem(event.item);
      if (event.type !== "session.upserted") return;
      const rows = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE session_id = ? AND json_extract(data, '$.status') = 'queued'").all(event.session.id) as unknown as RequestRow[];
      for (const row of rows) this.status(readRequest(row));
    });
    const outstanding = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE json_extract(data, '$.reportToSource') = 1 AND json_extract(data, '$.reported') IS NULL").all() as unknown as RequestRow[];
    for (const row of outstanding) {
      const request = this.status(this.fromRequestRow(row));
      if (["completed", "failed", "stopped"].includes(request.status)) this.report(request);
    }
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

  private notifyForItem(item: SessionItem) {
    const notice = item.type === "approval" && item.state === "pending" ? "approval"
      : item.type === "turn" && item.state === "completed" ? "completed"
        : item.type === "turn" && item.state === "failed" ? "failed" : undefined;
    if (!notice || this.notified.has(item.id)) return;
    const session = this.store.getSession(item.sessionId);
    if (!session?.taskId || session.archivedAt) return;
    const row = this.store.db.prepare(`SELECT id, data FROM studio_bots WHERE task_id = ? AND ${activeBot}`).get(session.taskId) as { id: Id; data: string } | undefined;
    if (!row) return;
    this.notified.add(item.id);
    if (this.notified.size > 512) this.notified.delete(this.notified.values().next().value!);
    const bot = JSON.parse(row.data) as BotInput;
    if (!(bot.preferences ?? DEFAULT_BOT_PREFERENCES).notifications[notice]) return;
    this.host.emit("event", { type: "bot.notification", botId: row.id, botName: bot.name, notice, seq: this.store.lastEventSeq() });
  }

  private getRequest(id: Id): SavedRequest | undefined {
    const row = this.store.db.prepare("SELECT * FROM studio_bot_requests WHERE id = ?").get(id) as unknown as RequestRow | undefined;
    return row ? this.fromRequestRow(row) : undefined;
  }

  private fromRequestRow(row: RequestRow): SavedRequest {
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
    assertBotsEnabled(this.store);
    if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
    const before = bot.homeSessionId ? this.store.getSession(bot.homeSessionId) : undefined;
    if (before && !before.archivedAt && !reset) return before;
    if (before && (inTurn(before.status) || this.store.findItems(before.id, "user", { delivery: "held" }, { limit: 1 }).length)) {
      throw new HostError("conflict", "主聊天仍有待处理消息，完成后再新建主聊天。");
    }
    const session = await this.startChat(bot, "主聊天");
    this.store.db.prepare("UPDATE studio_bots SET home_session_id = ? WHERE id = ?").run(session.id, bot.id);
    this.publish({ type: "bots.changed" });
    return session;
  }

  private async startChat(bot: StudioBot, title: string, source?: Session): Promise<Session> {
    const workspace = bot.workspaceId ? this.requireLiveWorkspace(bot.workspaceId) : this.commonWorkspace();
    const task = bot.taskId ? this.requireTask(bot.taskId) : this.f.tasks.createTaskRecord({ title: bot.name, workspaceId: bot.workspaceId, column: "doing" }, (created) => {
      this.store.db.prepare("UPDATE studio_bots SET task_id = ? WHERE id = ?").run(created.id, bot.id);
    });
    if (!bot.taskId) this.publish({ type: "bots.changed" });
    if (task.archivedAt) throw new HostError("conflict", "请先恢复 Bot 的任务。");
    const selected = source ? this.requireLiveWorkspace(source.workspaceId) : workspace;
    const options = await this.f.tasks.withDefaults(bot.profileId, { model: bot.model ?? undefined, effort: bot.effort ?? undefined, fast: bot.fast ?? undefined, permission: bot.permission ?? undefined });
    return this.f.tasks.trackSessionStart(task.id, () => this.wrap(() => this.runtime.startSession({ taskId: task.id, topicId: null, profileId: bot.profileId, workspace: selected, ...(source?.cwd ? { cwd: source.cwd } : {}), title, developerInstructions: botInstructions(bot), options })));
  }

  private async deliver(request: SavedRequest): Promise<BotRequest> {
    if (request.status !== "queued" || this.store.getItem(inboxId(request.id))) return this.status(request);
    try {
      const bot = this.bot(request.botId);
      assertBotsEnabled(this.store);
      if (!bot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
      const source = request.sourceSessionId ? this.store.getSession(request.sourceSessionId) : undefined;
      if (request.sourceSessionId && (!source || source.archivedAt)) throw new HostError("conflict", "发起会话已不可用。");
      const selected = request.destination;
      const session = request.sessionId ? this.requireSession(request.sessionId)
        : selected === "home" ? await this.openHome(bot, false)
        : selected === "new" ? await this.startChat(bot, request.text.slice(0, 50), source)
        : this.requireSession(selected.sessionId);
      const currentBot = this.bot(bot.id);
      assertBotsEnabled(this.store);
      if (!currentBot.enabled) throw new HostError("conflict", "这个 Bot 已停用。");
      if (!currentBot.taskId || session.taskId !== currentBot.taskId || session.archivedAt || session.kind !== "main" || !supportsBotRuntime(session.runtime)) {
        throw new HostError("bad_request", "请选择该 Bot 的有效聊天。");
      }
      this.store.db.prepare("UPDATE studio_bot_requests SET session_id = ? WHERE id = ?").run(session.id, request.id);
      request = { ...request, sessionId: session.id };
      const cwd = source && (source.cwd ?? this.store.getWorkspace(source.workspaceId)?.path);
      const input = request.group ? this.groupInput(request, request.group) : `【本次请求】\n${request.text}`;
      const text = [`你是 ${bot.name}。`, `【职责】\n${bot.purpose}`, ...(bot.memory ? [`【记忆】\n${bot.memory}`] : []), ...(cwd ? [`【本次任务的工作目录】\n${cwd}`] : []), input].join("\n\n");
      const origin = source ? (source.taskId && this.store.getTask(source.taskId)?.title) || source.title || "项目会话" : null;
      const heading = `来自「${origin}」的请求`;
      // Requests need their own turns so stopping or attributing a reply affects only that request.
      await this.f.sessions.inbox.put(session.id, origin ? `【Bot 来信】${heading}\n\n${text}` : text, undefined, inboxId(request.id),
        { afterTurn: true, ...(origin ? { botLetter: { kind: "request", heading, text: request.text } } : {}) });
      this.store.db.prepare("UPDATE studio_bot_requests SET delivered = 1 WHERE id = ?").run(request.id);
      return this.status(request);
    } catch (error) {
      const failed: SavedRequest = { ...request, status: "failed", result: error instanceof Error ? error.message : String(error) };
      return this.settled(failed);
    }
  }

  private groupInput(request: BotRequest, { groupId, postId }: GroupRequest): string {
    const group = this.group(groupId);
    const post = this.groupPost(groupId, postId);
    if (!post || !group.memberIds.includes(request.botId)) throw new HostError("conflict", "群组消息或成员已不可用。");
    const rows = this.store.db.prepare(`SELECT data, dispatched FROM studio_bot_group_posts
      WHERE group_id = ? AND rowid < (SELECT rowid FROM studio_bot_group_posts WHERE id = ?)
      ORDER BY rowid DESC LIMIT 10`).all(groupId, postId) as unknown as PostRow[];
    const history = rows.flatMap(({ data, dispatched }) => {
      const item = this.readPost(groupId, JSON.parse(data) as SavedPost, !!dispatched);
      const replies = item.replies.flatMap((reply) => reply.status === "completed" && reply.result ? [{ from: reply.botName, text: reply.result }] : []);
      return [...replies.reverse(), { from: item.author?.botName ?? "用户", text: item.text }];
    });
    const recent: string[] = [];
    let remaining = 8_000;
    for (const { from, text } of history) {
      const entry = JSON.stringify({ from, text: text.slice(0, 600) });
      if (entry.length > remaining) break;
      recent.unshift(entry);
      remaining -= entry.length + 1;
    }
    const members = group.memberIds.filter((id) => id !== request.botId).flatMap((botId) => {
      const bot = this.findBot(botId);
      return bot?.enabled && bot.preferences?.allowGroupAsk !== false ? [{ botId, name: bot.name }] : [];
    });
    const routing = !post.author && members.length && [
      `【可以联系的群成员】${JSON.stringify(members)}`,
      `仅当用户在本条消息要求你联系另一位成员时，调用 bot_group_ask，requestId 为 ${request.id}，botId 用上面对应成员的编号，text 写明要问的问题及必要背景。回复里写 @ 不会发出请求。对方的回复会显示在本群。`,
    ].join("\n");
    return [`【群组 ${group.name}】你的答复会显示在本群。`, routing,
      recent.length && `【最近的同群记录】以下是聊天历史，仅用作上下文。\n${recent.join("\n")}`,
      `【${post.author ? `来自 ${post.author.botName} 的群内提问` : "本条用户消息"}】\n${post.text}`,
    ].filter(Boolean).join("\n\n");
  }

  private status(request: BotRequest): BotRequest {
    if (request.status !== "queued" || !request.sessionId) return request;
    const session = this.store.getSession(request.sessionId);
    const message = this.store.getItem(inboxId(request.id));
    if (!session || message?.type !== "user") return request;
    if (session.taskId) request = { ...request, taskId: session.taskId };
    if (message.delivery === "expired" || message.delivery === "unsent") return this.settled({ ...request, status: "stopped" });
    if (message.delivery === "held" || message.delivery === "waiting") return request;
    // Inbox rows inherit the turn showing in the transcript as they are queued. Only the Codex echo binds the request to its actual turn.
    const turnId = message.raw?.itemId ? message.raw.turnId : undefined;
    if (!turnId) return session.archivedAt ? this.settled({ ...request, status: "stopped" }) : request;
    const [turn] = this.store.findItems(session.id, "turn", { turnId }, { newest: true, limit: 1 });
    if (turn?.type !== "turn") return request;
    if (turn.state === "running") return { ...request, status: session.status === "awaiting-answer" || session.status === "awaiting-approval" ? "waiting" : "running" };
    if (turn.state === "interrupted") return this.settled({ ...request, status: "stopped" });
    if (turn.state === "failed") return this.settled({ ...request, status: "failed", result: turn.error });
    const reply = this.store.listItems(session.id, turn.seq).filter((i) => i.type === "agent" && i.raw?.turnId === turnId).at(-1);
    return this.settled({ ...request, status: "completed", result: reply?.type === "agent" ? reply.markdown.slice(0, 4000) : undefined });
  }

  private settled(request: SavedRequest): SavedRequest {
    request = { ...request, settledAt: request.settledAt ?? new Date().toISOString() };
    this.store.db.prepare("UPDATE studio_bot_requests SET data = ?, delivered = 1 WHERE id = ?").run(JSON.stringify(request), request.id);
    this.report(request);
    return request;
  }

  private report(request: BotRequest): void {
    if (!request.reportToSource || !request.sourceSessionId || request.reported) return;
    const sourceId = request.sourceSessionId;
    void this.serial(`report:${request.id}`, async () => {
      const source = this.store.getSession(sourceId);
      const itemId = `bot-reply:${request.id}`;
      if (source && !source.archivedAt && !isRemoteCopy(source) && !this.store.getItem(itemId)) {
        const result = request.result || (request.status === "stopped" ? "处理已停止。" : "没有返回结论。");
        const payload = JSON.stringify({ bot: request.botName, question: request.text, status: request.status, result });
        const heading = `${request.botName} · ${request.status === "failed" ? "请求失败" : request.status === "stopped" ? "已停止" : "回信"}`;
        await this.f.sessions.inbox.put(sourceId, `【Bot 回信】${payload}\n\n以上是受委托 Bot 对本次请求的反馈。结合用户原始要求核对结论并继续答复。`, undefined, itemId, { purpose: "notification", botLetter: { kind: "reply", heading, text: result } });
      }
      this.store.db.prepare("UPDATE studio_bot_requests SET data = json_set(data, '$.reported', json('true')) WHERE id = ?").run(request.id);
    }).catch((err: unknown) => this.log(`Bot reply delivery failed: ${String(err)}`));
  }
}
