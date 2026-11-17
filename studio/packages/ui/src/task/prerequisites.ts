import type { Id, Task } from "@amo-studio/protocol";
import { call } from "../host/client.js";
import { sharedLive } from "../host/shared.js";

/**
 * Tasks still waiting for prerequisites: task id → theirs (2026-11-17, plans/done/task-dependencies.md). The Host decides what
 * is finished (a managed prerequisite once its own direct manager accepted it, one without a manager once done); one copy
 * per window, read again when a task or a canvas changes (a delivery accepted, a dependency line drawn or taken away).
 */
export const usePrerequisites = sharedLive<Record<Id, Id[]>>((link) => ({
  load: () => call(link, "GET /api/prerequisites"),
  reloadOn: (e) => e.type === "task.upserted" || e.type === "canvas.updated",
  reloadDelay: 150,
}));

/** The titles of what a task waits for, for 「等待前置：…」. */
export function waitingTitles(waiting: Record<Id, Id[]> | null, taskId: Id, tasks: readonly Task[]): string[] {
  return (waiting?.[taskId] ?? []).map((id) => tasks.find((t) => t.id === id)?.title || id);
}

/** What the line says, and what it means (the same on the board and the task page). */
export const WAITING_HINT = "前置任务完成后（有直属主控的要它的主控验收）才开始；你可以确认后提前开始，主控派工会等它们完成。";
