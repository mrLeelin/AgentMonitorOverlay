import type { Id, NewSessionInput, Session, Task, Topic } from "@amo-studio/protocol";
import { isCommon, topicWorkspaceIds } from "@amo-studio/protocol";
import { HostError, boundedText } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Topics (专题): their own sessions, archiving with their tasks. */
export class TopicsFeature extends Feature<"tasks"> {
  private storedTree(taskId: Id): Task[] {
    const all = this.store.listTasks();
    const ids = new Set([taskId]);
    // Structural ownership includes archived/invalid descendants: validate them rather than silently leaving them.
    let previous = 0;
    while (previous !== ids.size) {
      previous = ids.size;
      for (const t of all) if (t.managerTaskId && ids.has(t.managerTaskId)) ids.add(t.id);
    }
    return all.filter((t) => ids.has(t.id));
  }

  /** Validate before requesting a promotion or filing a split; existing topics always keep their user's name. */
  leadTopicTitle(taskId: Id, input?: unknown): string | null {
    const task = this.requireTask(taskId);
    if (input !== undefined) boundedText(input, "topicTitle", 100);
    if (task.topicId) { this.requireLiveTopic(task.topicId); return null; }
    if (task.managerTaskId) throw new HostError("conflict", "无专题的受管任务不能自行迁移上级；请由根主控先建立专题，保留原管理范围。");
    const title = boundedText(input ?? task.title, "topicTitle", 100);
    // Reject only standalone generic labels, not meaningful short product/module names.
    if (/^(审查|检查|任务|专题|项目|主控|工作|review|task|topic|project|work)$/i.test(title)) throw new HostError("bad_request", "topicTitle 请写对象和具体目标或交付，例如：DarkEvil-Story分支交叉检查：定位缺陷并交付合并风险报告。");
    const members = this.storedTree(task.id);
    for (const member of members) {
      if (member.topicId || member.archivedAt || member.remote || member.workspaceId !== task.workspaceId || (member.managerTaskId && !members.find((t) => t.id === member.managerTaskId)?.lead)) throw new HostError("conflict", "管理树存在其他专题、归档、远程或无效上级任务，不能自动迁移；请先核对管理范围。");
    }
    return title;
  }

  /** A root's explicitly owned tree joins one topic together; unrelated project tasks never move. */
  ensureLeadTopic(taskId: Id, input?: unknown): Topic {
    const title = this.leadTopicTitle(taskId, input);
    if (title === null) return this.requireLiveTopic(this.requireTask(taskId).topicId!);
    return this.host.transaction(() => {
      const task = this.requireTask(taskId);
      const topic = this.createTopic({ title, workspaceIds: isCommon(this.requireWorkspace(task.workspaceId)) ? [] : [task.workspaceId] });
      for (const member of this.storedTree(task.id)) {
        const updated = this.store.updateTask(member.id, { topicId: topic.id });
        this.publish({ type: "task.upserted", task: updated });
      }
      return topic;
    });
  }

  createTopic(input: { title?: unknown; workspaceIds?: unknown }): Topic {
    const title = boundedText(input?.title, "title", 100);
    const topic = this.store.createTopic({ title, workspaceIds: this.projectIds(input.workspaceIds) });
    this.publish({ type: "topic.upserted", topic });
    return topic;
  }

  updateTopic(id: Id, patch: { title?: unknown; workspaceIds?: unknown; description?: unknown }): Topic {
    const current = this.requireTopic(id);
    if (current.archivedAt) throw new HostError("read_only", "archived topics cannot be changed");
    const clean: Partial<Pick<Topic, "title" | "workspaceIds" | "description">> = {};
    if (patch.title !== undefined) clean.title = boundedText(patch.title, "title", 100);
    if (patch.description !== undefined) {
      if (typeof patch.description !== "string") throw new HostError("bad_request", "description must be a string");
      if (patch.description.length > 2000) throw new HostError("bad_request", "description is too long (2000 at most)");
      clean.description = patch.description.trim();
    }
    if (patch.workspaceIds !== undefined) clean.workspaceIds = this.projectIds(patch.workspaceIds);
    const topic = this.store.updateTopic(id, clean);
    this.publish({ type: "topic.upserted", topic });
    return topic;
  }

  /** Archives the topic with its own sessions and all its tasks (and theirs). */
  async archiveTopic(id: Id): Promise<{ topic: Topic; tasks: Task[] }> {
    const current = this.requireTopic(id);
    if (current.archivedAt) return { topic: current, tasks: [] };
    const members = this.store.listTasks().filter((x) => x.topicId === id && !x.archivedAt);
    const together = new Set(members.map((t) => t.id));
    for (const t of members) this.f.tasks.checkArchive(t.id, together);
    const topic = this.store.updateTopic(id, { archivedAt: new Date().toISOString() });
    this.publish({ type: "topic.upserted", topic });
    await this.f.tasks.archiveSessions(this.store.listSessions({ topicId: id }));
    const tasks: Task[] = [];
    const depth = (t: Task) => { const seen = new Set<string>(); let next = t; while (next.managerTaskId && !seen.has(next.id)) { seen.add(next.id); next = this.store.getTask(next.managerTaskId) ?? next; } return seen.size; };
    for (const t of members.sort((a, b) => depth(b) - depth(a))) tasks.push(await this.f.tasks.archiveTask(t.id));
    return { topic: this.store.getTopic(id)!, tasks };
  }

  /** Restores the topic, its sessions and the tasks that were archived with it. */
  async unarchiveTopic(id: Id): Promise<{ topic: Topic; tasks: Task[] }> {
    const current = this.requireTopic(id);
    if (!current.archivedAt) return { topic: current, tasks: [] };
    const since = current.archivedAt;
    const topic = this.store.updateTopic(id, { archivedAt: null });
    this.publish({ type: "topic.upserted", topic });
    await this.f.tasks.unarchiveSessions(this.store.listSessions({ topicId: id }), since);
    const tasks: Task[] = [];
    const pending = this.store.listTasks().filter((x) => x.topicId === id && x.archivedAt && x.archivedAt >= since);
    while (pending.length) {
      const index = pending.findIndex((t) => !t.managerTaskId || !this.store.getTask(t.managerTaskId)?.archivedAt);
      if (index < 0) throw new HostError("conflict", "管理链异常，请先恢复直属主控。");
      tasks.push(await this.f.tasks.unarchiveTask(pending.splice(index, 1)[0]!.id));
    }
    return { topic: this.store.getTopic(id)!, tasks };
  }

  /** A topic session: runs in one of the topic's projects, or in the common space when none is named. */
  async addTopicSession(topicId: Id, input: NewSessionInput): Promise<Session> {
    const topic = this.requireLiveTopic(topicId);
    this.requireProfile(input.profileId);
    let workspace = this.commonWorkspace();
    if (input.workspaceId && input.workspaceId !== workspace.id) {
      if (!topicWorkspaceIds(topic, this.store.listTasks(), this.store.listWorkspaces()).includes(input.workspaceId)) {
        throw new HostError("bad_request", "a topic session runs in one of the topic's projects or in the common space");
      }
      workspace = this.requireLiveWorkspace(input.workspaceId);
    }
    return this.f.tasks.startSession({ taskId: null, topicId: topic.id }, workspace, input);
  }

  /** The topic a session works for: its own (topic session), or its task's. */
  topicOfSession(sessionId: Id): Topic | null {
    const s = this.requireSession(sessionId);
    const id = s.topicId ?? (s.taskId ? this.store.getTask(s.taskId)?.topicId : null);
    return (id && this.store.getTopic(id)) || null;
  }

  private projectIds(value: unknown): Id[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new HostError("bad_request", "workspaceIds must be a list");
    const ids = [...new Set(value.map(String))];
    for (const id of ids) if (isCommon(this.requireWorkspace(id))) throw new HostError("bad_request", "the common space is not a project");
    return ids;
  }
}
