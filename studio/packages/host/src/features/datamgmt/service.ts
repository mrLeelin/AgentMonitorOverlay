import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { collectSubtreeIds, isCommon, type ArchiveRetention, type ArchivedEntry, type DataKind, type Id, type PurgeSummary, type Session, type Task } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

const KINDS: readonly DataKind[] = ["workspace", "topic", "task", "session"];
const RETENTION_KEY = "settings:archived-task-retention-days";
const DAY_MS = 24 * 60 * 60 * 1000;

/** What one deletion takes: the ids by kind, plus its title. */
interface PurgeSet {
  title: string;
  workspaceIds: Id[];
  topicIds: Id[];
  taskIds: Id[];
  sessionIds: Id[];
}

/**
 * 设置 → 数据管理 (2026-10-14): lists what is archived and deletes it for good. Only archived things can go, with
 * everything that belongs only to them (Store.purge); nothing live may hang on them (a restored fork of a deleted
 * session, a restored task of a deleted project). Files in projects and the CLIs' own records are never touched.
 */
export class DataFeature extends Feature<"attachments" | "projects"> {
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  retention(): ArchiveRetention {
    const raw = this.store.getKv(RETENTION_KEY)?.value;
    if (raw === "null") return { taskRetentionDays: null };
    const days = Number(raw);
    return { taskRetentionDays: days === 1 || days === 3 || days === 5 || days === 7 ? days : 7 };
  }

  setRetention(value: unknown): ArchiveRetention {
    if (value !== null && value !== 1 && value !== 3 && value !== 5 && value !== 7) throw new HostError("bad_request", "自动删除天数只能为 1、3、5、7 或不自动删除");
    this.store.setKv(RETENTION_KEY, JSON.stringify(value));
    return this.retention();
  }

  start(): void {
    if (this.cleanupTimer) return;
    const sweep = () => {
      try { this.cleanupExpiredTasks(); }
      catch (err) { this.log(`Archived task cleanup failed: ${String(err)}`); }
    };
    this.cleanupTimer = setInterval(sweep, 60_000);
    this.cleanupTimer.unref();
    sweep();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  /** Reuse manual deletion's dependency checks and attachment cleanup, including tasks hidden under archived owners. */
  cleanupExpiredTasks(now = Date.now()): Id[] {
    const { taskRetentionDays } = this.retention();
    if (taskRetentionDays === null) return [];
    const deleted: Id[] = [];
    for (const task of this.store.listTasks()) {
      if (!task.archivedAt || Date.parse(task.archivedAt) > now - taskRetentionDays * DAY_MS || !Number.isFinite(Date.parse(task.archivedAt))) continue;
      try {
        this.purge("task", task.id);
        deleted.push(task.id);
      } catch (err) {
        // A restored session or a managed task must keep its owner; retry on the next sweep after it is resolved.
        if (!(err instanceof HostError && err.code === "conflict")) this.log(`Archived task cleanup skipped ${task.id}: ${String(err)}`);
      }
    }
    return deleted;
  }

  archived(): ArchivedEntry[] {
    const workspaces = this.store.listWorkspaces();
    const topics = this.store.listTopics();
    const tasks = this.store.listTasks();
    const sessions = this.store.listSessions();
    const wsName = (id: Id) => {
      const w = workspaces.find((x) => x.id === id);
      return w && !isCommon(w) ? `项目 ${w.name}` : "";
    };
    const topicName = (id: Id | null) => (id ? `专题 ${topics.find((x) => x.id === id)?.title ?? ""}` : "");
    const out: ArchivedEntry[] = [];
    for (const w of workspaces) if (w.archivedAt && !isCommon(w)) out.push({ kind: "workspace", id: w.id, title: w.name, context: w.path, archivedAt: w.archivedAt });
    for (const t of topics) if (t.archivedAt) out.push({ kind: "topic", id: t.id, title: t.title, context: "", archivedAt: t.archivedAt });
    for (const t of tasks) {
      if (!t.archivedAt) continue;
      // Shown under its project or topic while that one is archived too: deleting that takes it.
      if (workspaces.find((w) => w.id === t.workspaceId)?.archivedAt || (t.topicId && topics.find((x) => x.id === t.topicId)?.archivedAt)) continue;
      out.push({ kind: "task", id: t.id, title: t.title, context: [wsName(t.workspaceId), topicName(t.topicId)].filter(Boolean).join(" · "), archivedAt: t.archivedAt });
    }
    for (const s of sessions) {
      if (!s.archivedAt) continue;
      const parent = s.parentId ? sessions.find((x) => x.id === s.parentId) : null;
      if (parent?.archivedAt) continue;
      const task = s.taskId ? tasks.find((x) => x.id === s.taskId) : null;
      const topic = s.topicId ? topics.find((x) => x.id === s.topicId) : null;
      if (task?.archivedAt || topic?.archivedAt || workspaces.find((w) => w.id === s.workspaceId)?.archivedAt) continue;
      out.push({ kind: "session", id: s.id, title: s.title || "会话", context: task ? `任务 ${task.title}` : topic ? `专题 ${topic.title}` : "", archivedAt: s.archivedAt });
    }
    return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  preview(kind: unknown, id: unknown): PurgeSummary {
    const { k, set } = this.resolve(kind, id);
    return this.summary(k, String(id), set);
  }

  purge(kind: unknown, id: unknown): PurgeSummary {
    const { k, set } = this.resolve(kind, id);
    return this.execute(k, String(id), set);
  }

  batch(entries: unknown, execute: boolean) {
    if (!Array.isArray(entries) || !entries.length) throw new HostError("bad_request", "请选择要删除的归档内容");
    const combined: PurgeSet = { title: "全部已归档内容", workspaceIds: [], topicIds: [], taskIds: [], sessionIds: [] };
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") throw new HostError("bad_request", "归档条目格式无效");
      const { set } = this.resolve(entry.kind, entry.id, false);
      for (const key of ["workspaceIds", "topicIds", "taskIds", "sessionIds"] as const) combined[key].push(...set[key]);
    }
    for (const key of ["workspaceIds", "topicIds", "taskIds", "sessionIds"] as const) combined[key] = [...new Set(combined[key])];
    // Validate the union: archived managers and their managed tasks can be removed together, never partially.
    this.checkNothingLive(combined, this.store.listSessions(), this.store.listTasks());
    const { kind, id, title, ...summary } = execute ? this.execute("workspace", "batch", combined) : this.summary("workspace", "batch", combined);
    return summary;
  }

  private execute(k: DataKind, id: Id, set: PurgeSet): PurgeSummary {
    const summary = this.summary(k, id, set);
    const { attachmentIds } = this.store.countItems(set.sessionIds);
    this.store.purge(set);
    for (const ws of set.workspaceIds) this.f.projects.dropHints(ws);
    this.publish({ type: "data.purged", workspaceIds: set.workspaceIds, topicIds: set.topicIds, taskIds: set.taskIds, sessionIds: set.sessionIds });
    // Pasted images nothing mentions any more.
    let removed = 0;
    for (const att of attachmentIds) if (!this.store.attachmentInUse(att) && this.removeAttachment(att)) removed++;
    return { ...summary, attachments: removed };
  }

  private summary(kind: DataKind, id: Id, set: PurgeSet): PurgeSummary {
    const { items, attachmentIds } = this.store.countItems(set.sessionIds);
    return {
      kind,
      id,
      title: set.title,
      workspaces: set.workspaceIds.length,
      topics: set.topicIds.length,
      tasks: set.taskIds.length,
      sessions: set.sessionIds.length,
      items,
      attachments: attachmentIds.length,
    };
  }

  /** The ids a deletion takes, after checking it is archived and nothing live depends on it. */
  private resolve(kind: unknown, id: unknown, validate = true): { k: DataKind; set: PurgeSet } {
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new HostError("bad_request", "kind must be workspace, topic, task or session");
    if (typeof id !== "string" || !id) throw new HostError("bad_request", "id is required");
    const k = kind as DataKind;
    const sessions = this.store.listSessions();
    const tasks = this.store.listTasks();
    let set: PurgeSet;
    if (k === "session") {
      const s = this.requireSession(id);
      if (!s.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的会话");
      const owner = sessions.filter((x) => (s.taskId ? x.taskId === s.taskId : x.topicId === s.topicId));
      set = { title: s.title || "会话", workspaceIds: [], topicIds: [], taskIds: [], sessionIds: collectSubtreeIds(owner, s.id) };
    } else if (k === "task") {
      const t = this.requireTask(id);
      if (!t.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的任务");
      set = { title: t.title, workspaceIds: [], topicIds: [], taskIds: [t.id], sessionIds: sessions.filter((x) => x.taskId === t.id).map((x) => x.id) };
    } else if (k === "topic") {
      const tp = this.requireTopic(id);
      if (!tp.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的专题");
      const taskIds = tasks.filter((t) => t.topicId === tp.id).map((t) => t.id);
      set = { title: tp.title, workspaceIds: [], topicIds: [tp.id], taskIds, sessionIds: sessions.filter((x) => x.topicId === tp.id || (x.taskId && taskIds.includes(x.taskId))).map((x) => x.id) };
    } else {
      const ws = this.requireWorkspace(id);
      if (isCommon(ws)) throw new HostError("conflict", "公共目录不能删除");
      if (!ws.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的项目");
      const taskIds = tasks.filter((t) => t.workspaceId === ws.id).map((t) => t.id);
      set = { title: ws.name, workspaceIds: [ws.id], topicIds: [], taskIds, sessionIds: sessions.filter((x) => x.workspaceId === ws.id || (x.taskId && taskIds.includes(x.taskId))).map((x) => x.id) };
    }
    if (validate) this.checkNothingLive(set, sessions, tasks);
    return { k, set };
  }

  private checkNothingLive(set: PurgeSet, sessions: readonly Session[], tasks: readonly Task[]): void {
    const deletedTasks = new Set(set.taskIds);
    const retained = tasks.find((task) => !deletedTasks.has(task.id) && task.managerTaskId && deletedTasks.has(task.managerTaskId));
    if (retained) throw new HostError("conflict", `任务「${retained.title || retained.id}」仍归要删除的主控管理，请先转交或解除归属（含已归档任务）`);
    const ids = new Set(set.sessionIds);
    const live = sessions.find((s) => ids.has(s.id) && !s.archivedAt);
    if (live) throw new HostError("conflict", `会话「${live.title || "会话"}」还没归档，先归档它`);
    const liveTask = tasks.find((t) => set.taskIds.includes(t.id) && !t.archivedAt);
    if (liveTask) throw new HostError("conflict", `任务「${liveTask.title}」还没归档，先归档它`);
    const child = sessions.find((s) => !ids.has(s.id) && s.parentId && ids.has(s.parentId));
    if (child) throw new HostError("conflict", `会话「${child.title || "会话"}」是从要删除的会话分出来的，先删除或移走它`);
  }

  /** Removes `<id>.<ext>` and `<id>.json` from the attachments folder. */
  private removeAttachment(id: string): boolean {
    const dir = this.f.attachments.dir();
    if (!existsSync(dir)) return false;
    let any = false;
    for (const name of readdirSync(dir)) {
      if (name === `${id}.json` || (name.startsWith(`${id}.`) && name.length - id.length <= 6)) {
        rmSync(join(dir, name), { force: true });
        any = true;
      }
    }
    return any;
  }
}
