import { expect, it } from "vitest";
import type { Task, TaskResult } from "@amo-studio/protocol";
import { dependencyFlow, latestTaskResults, managementFlow } from "./task-flow.js";

const task: Task = { id: "worker", title: "执行", workspaceId: "ws", topicId: "topic", column: "doing", managerTaskId: "lead", createdAt: "", updatedAt: "", archivedAt: null };
const result: TaskResult = { id: "result", taskId: task.id, managerTaskId: "lead", sessionId: "s", summary: "交付", verification: "验证", state: "submitted", createdAt: "2026-11-09T01:00:00Z", updatedAt: "2026-11-09T01:00:00Z" };

it("runs towards the worker, submits back to the lead, and only records acceptance from delivery", () => {
  expect(managementFlow(task, "running")).toMatchObject({ state: "running", direction: "forward" });
  expect(managementFlow(task, "completed")).toBeNull();
  expect(managementFlow(task, "idle", result)).toMatchObject({ state: "submitted", direction: "reverse" });
  expect(managementFlow({ ...task, column: "done" }, "idle", { ...result, state: "accepted" })).toEqual({ state: "accepted", label: "已验收" });
  expect(managementFlow({ ...task, managerTaskId: "new-lead" }, "idle", result)).toBeNull();
});

it("stops during questions, approval, errors, interruption and archived tasks", () => {
  for (const status of ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "interrupted"] as const) expect(managementFlow(task, status, result)?.direction).toBeUndefined();
  expect(managementFlow(task, "running", undefined, true)).toEqual({ state: "waiting", label: "待主控答复" });
  expect(managementFlow({ ...task, archivedAt: "now" }, "running", result)).toBeNull();
  expect(managementFlow(task, "idle", { ...result, state: "returned" })?.direction).toBeUndefined();
  expect(managementFlow(task, "running", { ...result, state: "returned" })?.direction).toBe("forward");
});

it("animates a dependency only after its prerequisite is done and the next task is running", () => {
  expect(dependencyFlow(task, task, "running")).toEqual({ state: "waiting", label: "等待前置" });
  expect(dependencyFlow({ ...task, column: "done" }, task, "idle")?.direction).toBeUndefined();
  expect(dependencyFlow({ ...task, column: "done" }, task, "running")?.direction).toBe("forward");
  expect(dependencyFlow(task, { ...task, column: "done" }, "idle")).toBeNull();
});

it("uses the latest submission even if workflow history arrives out of order", () => {
  const newer = { ...result, id: "new", createdAt: "2026-11-09T02:00:00Z" };
  expect(latestTaskResults([newer, result]).get(task.id)?.id).toBe("new");
});
