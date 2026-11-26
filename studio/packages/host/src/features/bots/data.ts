import { defaultBotPermission, type Id, type Session, type SessionOptions } from "@amo-studio/protocol";
import type { Store } from "../../store/store.js";
import { HostError } from "../../core/shared.js";

export const BOTS_ENABLED_KEY = "bots.enabled";
export const CONFIRM_BOT_HOME_RESET_KEY = "bots.confirmHomeReset";

export const botsEnabled = (store: Store): boolean => store.getKv(BOTS_ENABLED_KEY)?.value !== "0";

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

/** All entry points creating sessions in a Bot's task must use the owner's saved grant, including the generic task API. */
export function newChatOptions(store: Store, taskId: Id | null, profileId: Id, runtime: string, options: SessionOptions = {}): SessionOptions {
  if (!taskId) return options;
  const fallback = defaultBotPermission(runtime);
  if (store.getTask(taskId)?.lead) return { ...options, permission: fallback };
  const bot = store.db.prepare("SELECT json_extract(data, '$.profileId') AS profileId, json_extract(data, '$.permission') AS permission FROM studio_bots WHERE task_id = ?").get(taskId) as { profileId: string; permission: string | null } | undefined;
  return bot ? { ...options, permission: bot.profileId === profileId ? bot.permission ?? fallback : fallback } : options;
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
  const row = taskId && store.db.prepare("SELECT data FROM studio_bots WHERE task_id = ?").get(taskId) as { data: string } | undefined;
  return row ? botInstructions(JSON.parse(row.data)) : undefined;
}
