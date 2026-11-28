import { inTurn, type BotLeadConfigSnapshot, type Session, type Task } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";
import { BotLeadStore } from "../../store/bot-leads.js";

function scopeFixture(host: HostService, task: Task): void {
  if (task.topicId) return;
  let root = task;
  while (root.managerTaskId) root = host.requireTask(root.managerTaskId);
  host.topics.ensureLeadTopic(root.id, "隔离管理树 · 测试目标");
}

function saveFixtureTerm(host: HostService, records: BotLeadStore, task: Task, runtime: BotLeadConfigSnapshot["runtime"], profileId: string) {
  const botId = `fixture-bot-${task.id}`;
  const bot = { name: task.title, profileId, purpose: "隔离管理测试", memory: "", workspaceId: task.workspaceId, enabled: true };
  const permission = runtime === "claude" ? "plan" as const : "read-only" as const;
  host.store.db.prepare("INSERT OR IGNORE INTO studio_bots (id, name_key, data) VALUES (?, ?, ?)").run(botId, botId, JSON.stringify(bot));
  return records.appoint(task.id, botId, { ...bot, runtime, options: { permission } }, { kind: "manual" }, "", botId);
}

/** A test recording may stand in for the native read-only thread. The stored term, scope and session gates still apply. */
export function bindLeadFixture(host: HostService, session: Session): Session {
  const { store } = host;
  const task = session.taskId ? store.getTask(session.taskId) : undefined;
  if (!task?.lead || session.kind !== "main" || session.archivedAt) return session;
  const runtime = session.runtime;
  if (runtime !== "codex" && runtime !== "dsh" && runtime !== "claude") throw new Error("unexpected lead fixture runtime");
  const records = new BotLeadStore(store);
  const existing = records.currentTerm(task.id);
  const previous = existing?.sessionId ? store.getSession(existing.sessionId) : undefined;
  if (previous && !previous.archivedAt && previous.writer !== "archived") return session;
  scopeFixture(host, task);
  return host.transaction(() => {
    const term = existing ?? saveFixtureTerm(host, records, task, runtime, session.profileId);
    if (existing) records.setRunState(term.termId, "pending");
    records.reserveLaunch(term.termId, session.id);
    records.setRunState(term.termId, "starting");
    const ref = session.runtimeRef ?? `fixture-thread-${session.id}`;
    store.updateSession(session.id, { runtimeRef: ref, options: { ...session.options, permission: term.snapshot.options.permission } });
    if (runtime !== "claude") store.setKv(`${runtime}-lead-readonly:${session.id}`, ref);
    if (!records.bindSession(term.termId, session.id)) throw new Error("could not bind lead test fixture");
    records.setRunState(term.termId, inTurn(session.status) ? "running" : "idle");
    return store.getSession(session.id)!;
  });
}

export async function startLeadFixture(host: HostService, task: Task, profileId: string, text?: string): Promise<Session> {
  const { store } = host;
  const runtime = host.requireProfile(profileId).runtime;
  if (runtime !== "codex" && runtime !== "dsh" && runtime !== "claude") throw new Error("unexpected lead fixture runtime");
  scopeFixture(host, task);
  const records = new BotLeadStore(store);
  const term = records.currentTerm(task.id) ?? saveFixtureTerm(host, records, task, runtime, profileId);
  await host.botLeads.flush();
  const id = host.botLeads.currentTerm(task.id)?.sessionId;
  if (!id) throw new Error(`lead fixture did not start: ${host.botLeads.currentTerm(task.id)?.reason ?? term.runState}`);
  if (text) await host.sessions.sendMessage(id, text);
  return store.getSession(id)!;
}
