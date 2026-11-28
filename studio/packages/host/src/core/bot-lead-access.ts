import { taskManagement, type BotLeadTerm, type BotLeadTermRef, type Id, type Session, type Task } from "@amo-studio/protocol";
import { BotLeadStore, leadSessionShape, matchesLeadTerm } from "../store/bot-leads.js";
import type { Store } from "../store/store.js";
import { HostError } from "./shared.js";

export function appointmentRequired(taskId?: Id): never {
  throw new HostError("conflict", "主控需要任命机器人。请更新 Studio，在新建、专题或任务页选择机器人带队。", { reason: "appointment-required", action: "select-bot", ...(taskId ? { taskId } : {}) });
}

/** Check a prospective appointment or reparenting against both ends of the moved branch. */
export function assertDistinctLeadChain(store: Store, task: Pick<Task, "id" | "managerTaskId">, botId?: Id): void {
  const records = new BotLeadStore(store);
  const ancestors = new Set<Id>(), visited = new Set([task.id]);
  for (let id = task.managerTaskId; id && !visited.has(id); id = store.getTask(id)?.managerTaskId) {
    visited.add(id);
    const bot = records.currentTerm(id)?.botId;
    if (bot) ancestors.add(bot);
  }
  const own = botId ?? records.currentTerm(task.id)?.botId;
  const descendants = taskManagement(store.listTasks(), task.id).descendants;
  const duplicate = (own && ancestors.has(own)) || descendants.some((child) => {
    const bot = records.currentTerm(child.id)?.botId;
    return bot && (bot === own || ancestors.has(bot));
  });
  if (duplicate) throw new HostError("conflict", "同一管理链上的主控需要使用不同机器人。");
}

export function leadBotUnavailable(store: Store, botId: Id): string | undefined {
  if (store.getKv("bots.enabled")?.value === "0") return "全局 Bots 已关闭，可在「设置 → 工具与自动化 → Bots」开启。";
  const row = store.db.prepare("SELECT json_extract(data, '$.enabled') AS enabled FROM studio_bots WHERE id = ?").get(botId) as { enabled: number | null } | undefined;
  if (!row?.enabled) return "任期的机器人已停用或删除。";
}

/** Validate the whole ownership chain, including an anonymous ancestor during the transition. */
export function leadScopeIssue(store: Store, task: Task, requireTopic = true): string | undefined {
  if (task.archivedAt || task.remote || (requireTopic && !task.topicId)) return "任务已归档、属于远程或没有有效专题。";
  const workspace = store.getWorkspace(task.workspaceId);
  if (!workspace || workspace.archivedAt) return "任务项目已归档或不可用。";
  const topic = task.topicId && store.getTopic(task.topicId);
  if (task.topicId && (!topic || topic.archivedAt)) return "任务专题已归档或不可用。";
  const visited = new Set([task.id]);
  let managerId = task.managerTaskId;
  while (managerId) {
    if (visited.has(managerId)) return "任务管理关系中存在环。";
    visited.add(managerId);
    const manager = store.getTask(managerId);
    if (!manager?.lead || manager.archivedAt || manager.remote || manager.topicId !== task.topicId || (!task.topicId && manager.workspaceId !== task.workspaceId)) return "直属管理链不在同一有效范围。";
    const managerWorkspace = store.getWorkspace(manager.workspaceId);
    if (!managerWorkspace || managerWorkspace.archivedAt) return "上级主控项目已归档或不可用。";
    managerId = manager.managerTaskId;
  }
}

export function activeManagementTerm(store: Store, session: Session, expectedTerm?: BotLeadTermRef): BotLeadTerm | null {
  const task = session.taskId && store.getTask(session.taskId);
  if (!task || !task.lead || leadScopeIssue(store, task)) return null;
  const term = new BotLeadStore(store).currentTerm(task.id);
  const stopped = store.db.prepare(`SELECT 1 FROM kv, json_each(CASE WHEN json_valid(kv.value) THEN kv.value ELSE '[]' END)
    WHERE kv.key = 'sessions.inbox.paused' AND json_each.value = ?`).get(session.id);
  if (!term || term.state !== "active" || (expectedTerm && !matchesLeadTerm(term, expectedTerm)) || term.sessionId !== session.id
    || stopped || (term.runState !== "running" && term.runState !== "idle") || leadBotUnavailable(store, term.botId)
    || !leadSessionShape(store, session, term)) return null;
  return term;
}

export function assertManagementSession(store: Store, sessionId: Id, expectedTerm?: BotLeadTermRef): BotLeadTerm {
  const session = store.getSession(sessionId);
  const term = session && activeManagementTerm(store, session, expectedTerm);
  if (!term) throw new HostError("read_only", "此会话没有当前主控任期的管理权限，请打开任务上的现任主控会话。");
  return term;
}

/** A reserved task stays under the read-only ceiling even if an earlier main session arrives late. */
export function hasLeadAppointment(store: Store, taskId: Id | null): boolean {
  return taskId !== null && new BotLeadStore(store).currentTerm(taskId) !== null;
}
