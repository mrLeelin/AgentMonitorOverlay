import type { Id, NewSessionInput, Session, Task, Topic } from "@amo-studio/protocol";
import { isCommon, topicWorkspaceIds } from "@amo-studio/protocol";
import { HostError, boundedText } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Topics (专题): their own sessions, archiving with their tasks. */
export class TopicsFeature extends Feature<"tasks"> {
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
