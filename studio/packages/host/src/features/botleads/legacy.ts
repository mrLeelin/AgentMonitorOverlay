import type { BotLeadLegacyIssue, Id, Task } from "@amo-studio/protocol";
import { leadScopeIssue } from "../../core/bot-lead-access.js";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";

/** Inspect stored ownership before repairing it. An invalid branch stays visible at its original location. */
export class LegacyLeadTrees extends Feature<"canvases" | "topics"> {
  issue(task: Task): string | undefined {
    const reason = leadScopeIssue(this.store, task, false);
    if (reason || task.topicId || !task.lead) return reason;
    let root = task;
    while (root.managerTaskId) root = this.requireTask(root.managerTaskId);
    try { this.f.topics.leadTopicTitle(root.id, this.title(root)); }
    catch (error) { if (error instanceof HostError) return error.message; throw error; }
  }

  title(root: Task): string { return `${root.title.slice(0, 84) || "原任务"} · 主控交接`; }

  issues(): BotLeadLegacyIssue[] {
    return this.store.listTasks().filter((task) => !task.archivedAt && !task.remote && (task.lead || task.managerTaskId)).flatMap((task) => {
      const reason = this.issue(task);
      return reason ? [{ taskId: task.id, topicId: task.topicId, title: task.title, managerTaskId: task.managerTaskId ?? null, reason }] : [];
    });
  }

  members(rootId: Id): Task[] {
    const root = this.requireTask(rootId);
    if (!root.lead || root.managerTaskId || root.remote || root.archivedAt) throw new HostError("conflict", "请在有效的总主控任务上绑定整棵树。");
    const tasks = this.store.listTasks();
    const children = new Map<Id, Task[]>();
    for (const task of tasks) {
      if (!task.managerTaskId || task.archivedAt) continue;
      const list = children.get(task.managerTaskId) ?? [];
      list.push(task);
      children.set(task.managerTaskId, list);
    }
    const members = [root];
    const seen = new Set([root.id]);
    for (const task of members) {
      for (const child of children.get(task.id) ?? []) {
        if (seen.has(child.id)) throw new HostError("conflict", "管理树存在环，请先修正直属主控。");
        seen.add(child.id);
        members.push(child);
      }
    }
    return members;
  }

  repair(): void {
    for (const root of this.store.listTasks()) {
      if (!root.lead || root.managerTaskId || root.remote || root.archivedAt || this.issue(root)) continue;
      if (root.column === "done" && !this.members(root.id).some((task) => task.lead && task.column !== "done")) continue;
      this.host.transaction(() => {
        const topic = this.f.topics.ensureLeadTopic(root.id, root.topicId ? undefined : this.title(root));
        const valid = this.members(root.id).filter((task) => !this.issue(task));
        this.f.canvases.ensureLegacyManagementCards(topic.id, valid.map((task) => task.id));
      });
    }
  }
}
