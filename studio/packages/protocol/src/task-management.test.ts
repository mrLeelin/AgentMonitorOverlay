import { describe, expect, it } from "vitest";
import type { Task } from "./entities.js";
import { isManagedBy, sameManagementScope, taskManagement } from "./task-management.js";

const task = (id: string, managerTaskId: string | null = null, lead = false, patch: Partial<Task> = {}): Task => ({ id, title: id, workspaceId: "workspace", topicId: "topic", column: "todo", lead, managerTaskId, createdAt: "2026-11-07", updatedAt: "2026-11-07", archivedAt: null, ...patch });

describe("explicit task management", () => {
  it("queries multiple levels and counts unique direct leads and descendant workers", () => {
    const root = task("root", null, true);
    const child = task("child", "root", true);
    const worker = task("worker", "child");
    const directWorker = task("direct", "root");
    const tasks = [root, child, worker, worker, directWorker, task("peer", null, true), task("unassigned")];
    expect(taskManagement(tasks, "root")).toEqual({ direct: [child, directWorker], descendants: [child, worker, directWorker], directLeadCount: 1, workerCount: 2 });
    expect(taskManagement(tasks, "child").descendants).toEqual([worker]);
    expect(isManagedBy(tasks, "worker", "root")).toBe(true);
    expect(isManagedBy(tasks, "root", "root")).toBe(false);
    expect(isManagedBy(tasks, "peer", "root")).toBe(false);
    expect(isManagedBy(tasks, "unassigned", "root")).toBe(false);
  });

  it("does not infer legacy ownership from scope, and transfers the complete subtree", () => {
    const tasks = [task("old", null, true), task("next", null, true), task("child", "old", true), task("worker", "child"), task("legacy", null, false, { managerTaskId: undefined })];
    expect(taskManagement(tasks, "old").workerCount).toBe(1);
    tasks[2] = { ...tasks[2]!, managerTaskId: "next" };
    expect(taskManagement(tasks, "old").descendants).toEqual([]);
    expect(taskManagement(tasks, "next").descendants.map((t) => t.id)).toEqual(["child", "worker"]);
    tasks[2] = { ...tasks[2]!, managerTaskId: null };
    expect(taskManagement(tasks, "next").descendants).toEqual([]);
  });

  it("fails closed on cycles, missing or invalid managers, archives and remote copies", () => {
    for (const parent of [task("root", "root", true), task("root", "missing", true), task("root", null, false), task("root", null, true, { archivedAt: "2026-11-07" }), task("root", null, true, { remote: {} as Task["remote"] })]) {
      const tasks = [parent, task("child", "root", true), task("worker", "child")];
      expect(taskManagement(tasks, "root").descendants).toEqual([]);
      expect(isManagedBy(tasks, "worker", "root")).toBe(false);
    }
    const cyclic = [task("root", "child", true), task("child", "root", true), task("worker", "child")];
    expect(taskManagement(cyclic, "child").descendants).toEqual([]);
    expect(taskManagement([task("root", null, true), task("worker", "root", false, { archivedAt: "yesterday" })], "root").workerCount).toBe(0);
  });

  it("permits cross-project topic management but denies cross-topic and ungrouped cross-project chains", () => {
    const root = task("root", null, true);
    expect(sameManagementScope(root, task("worker", "root", false, { workspaceId: "other" }))).toBe(true);
    expect(taskManagement([root, task("worker", "root", false, { topicId: "other" })], "root").descendants).toEqual([]);
    expect(taskManagement([{ ...root, topicId: null }, task("worker", "root", false, { topicId: null, workspaceId: "other" })], "root").descendants).toEqual([]);
  });
});
