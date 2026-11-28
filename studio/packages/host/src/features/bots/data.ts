import { defaultBotPermission, type BotInput, type Id, type Session, type SessionOptions } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { claudePermissions, codexPermissions, DSH_PERMISSIONS } from "../../runtime/choices.js";
import { readBotFiles } from "./files.js";

export const BOTS_ENABLED_KEY = "bots.enabled";
export const CONFIRM_BOT_HOME_RESET_KEY = "bots.confirmHomeReset";

export const botsEnabled = (store: Store): boolean => store.getKv(BOTS_ENABLED_KEY)?.value !== "0";

export function botPermission(value: unknown, runtime: Session["runtime"], claudeBaseUrl?: string): string {
  if (value == null) return defaultBotPermission(runtime);
  const choices = runtime === "claude" ? claudePermissions(claudeBaseUrl) : runtime === "dsh" ? DSH_PERMISSIONS : codexPermissions(null);
  const option = choices.find((item) => item.id === value);
  if (!option || option.unavailable) throw new HostError("bad_request", option?.unavailable ?? "请选择该 Bot 模型渠道支持的权限。");
  return option.id;
}

export function assertBotsEnabled(store: Store): void {
  if (!botsEnabled(store)) throw new HostError("read_only", "Bots 已关闭，可在「设置 → 工具与自动化 → Bots」开启。");
}

export function assertBotTaskEnabled(store: Store, taskId: Id | null): void {
  if (!taskId) return;
  const row = store.db.prepare("SELECT json_extract(data, '$.enabled') AS enabled FROM studio_bots WHERE task_id = ?").get(taskId) as { enabled: number } | undefined;
  if (!row) return;
  assertBotsEnabled(store);
  if (!row.enabled) throw new HostError("read_only", "这个 Bot 已停用。");
}

export function isBotTask(store: Store, taskId: Id | null): boolean {
  return !!taskId && !!store.db.prepare("SELECT id FROM studio_bots WHERE task_id = ?").get(taskId);
}

/** New chats inherit the owner's grant. A read-only review can narrow that grant for its own session. */
export function newChatOptions(store: Store, taskId: Id | null, profileId: Id, runtime: string, options: SessionOptions = {}): SessionOptions {
  if (!taskId) return options;
  const fallback = defaultBotPermission(runtime);
  if (store.getTask(taskId)?.lead) return { ...options, permission: fallback };
  const bot = store.db.prepare("SELECT json_extract(data, '$.profileId') AS profileId, json_extract(data, '$.permission') AS permission FROM studio_bots WHERE task_id = ?").get(taskId) as { profileId: string; permission: string | null } | undefined;
  if (!bot) return options;
  const permission = bot.profileId === profileId && options.permission !== fallback ? bot.permission ?? fallback : fallback;
  return { ...options, permission };
}

/** Changing a Bot's settings affects new chats. Existing chats and forks keep their launch permission. */
export function updatedChatOptions(store: Store, session: Session, options: SessionOptions): SessionOptions {
  if (!session.taskId) return options;
  const fallback = defaultBotPermission(session.runtime);
  if (store.getTask(session.taskId)?.lead) return { ...options, permission: fallback };
  return isBotTask(store, session.taskId) ? { ...options, permission: session.options.permission ?? fallback } : options;
}

export function isReadOnlyTask(store: Store, taskId: Id | null, runtime: string, options: SessionOptions): boolean {
  if (!taskId) return false;
  return !!store.getTask(taskId)?.lead || ((!options.permission || options.permission === defaultBotPermission(runtime)) && isBotTask(store, taskId));
}

export function isBotHome(store: Store, id: Id): boolean {
  return !!store.db.prepare("SELECT id FROM studio_bots WHERE home_session_id = ?").get(id);
}

export function botInstructions(bot: { name: string; purpose: string; memory?: string }): string {
  return [`你是 ${bot.name}。`, `【职责】\n${bot.purpose}`, ...(bot.memory ? [`【记忆】\n${bot.memory}`] : [])].join("\n\n");
}

export function botTaskInstructions(store: Store, taskId: Id | null): string | undefined {
  const row = taskId && store.db.prepare("SELECT id, data FROM studio_bots WHERE task_id = ?").get(taskId) as { id: string; data: string } | undefined;
  if (!row) return;
  const data = JSON.parse(row.data) as BotInput & { deletedAt?: string };
  return data.deletedAt ? undefined : botInstructions(readBotFiles(store, row.id, data));
}

export const botSessionPromptKey = (id: Id): string => `bots.sessionPrompt:${id}`;

export function botSessionPrompt(store: Store, id: Id): string | undefined {
  return store.getKv(botSessionPromptKey(id))?.value;
}
