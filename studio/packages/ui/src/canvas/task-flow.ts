import type { SessionStatus, Task, TaskResult } from "@amo-studio/protocol";

export interface TaskFlow {
  state: "running" | "submitted" | "returned" | "waiting" | "error" | "accepted" | "ready";
  label: string;
  direction?: "forward" | "reverse";
}

/** Delivery records, rather than an idle/completed session, establish acceptance. */
export function managementFlow(task: Task, status: SessionStatus | null, result?: TaskResult, hasQuestion = false): TaskFlow | null {
  if (task.archivedAt) return null;
  if (hasQuestion) return { state: "waiting", label: "待主控答复" };
  if (status === "awaiting-approval" || status === "awaiting-answer" || status === "awaiting-review") return { state: "waiting", label: status === "awaiting-approval" ? "待批准" : status === "awaiting-answer" ? "等待回答" : "待审阅" };
  if (status === "error" || status === "interrupted") return { state: "error", label: status === "error" ? "运行出错" : "已中断" };
  const current = result?.managerTaskId === task.managerTaskId ? result : undefined;
  if (current?.state === "submitted") return { state: "submitted", label: "提交 · 待验收", direction: "reverse" };
  if (current?.state === "returned") return { state: "returned", label: "退回修改", ...(status === "running" ? { direction: "forward" as const } : {}) };
  if (status === "running") return { state: "running", label: "执行中", direction: "forward" };
  if (current?.state === "accepted" && task.column === "done") return { state: "accepted", label: "已验收" };
  return null;
}

export function dependencyFlow(from: Task, to: Task, status: SessionStatus | null): TaskFlow | null {
  if (from.archivedAt || to.archivedAt || to.column === "done") return null;
  // A downstream task can run independently; do not imply an unfinished prerequisite has handed over.
  if (from.column !== "done") return { state: "waiting", label: "等待前置" };
  if (status === "running") return { state: "running", label: "后续执行中", direction: "forward" };
  return { state: "ready", label: "前置已完成" };
}

export function latestTaskResults(results: readonly TaskResult[]): Map<string, TaskResult> {
  const latest = new Map<string, TaskResult>();
  for (const result of results) {
    const old = latest.get(result.taskId);
    if (!old || result.createdAt >= old.createdAt) latest.set(result.taskId, result);
  }
  return latest;
}
