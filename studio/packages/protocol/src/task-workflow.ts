import type { DecisionRequest, Id, Task, Timestamp } from "./entities.js";

/** The valid top-level lead of a management tree; layout and links never grant ownership. */
export function managementRoot(tasks: readonly Task[], taskId: Id): Task | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let current = byId.get(taskId);
  const seen = new Set<Id>();
  while (current) {
    if (seen.has(current.id) || current.archivedAt || current.remote) return null;
    seen.add(current.id);
    if (!current.managerTaskId) return current.lead ? current : null;
    const manager = byId.get(current.managerTaskId);
    if (!manager?.lead || manager.topicId !== current.topicId || (!current.topicId && manager.workspaceId !== current.workspaceId)) return null;
    current = manager;
  }
  return null;
}

/** A submitted delivery is separate from a session ending and from a manager accepting it. */
export interface TaskResult {
  id: Id;
  taskId: Id;
  sessionId: Id;
  managerTaskId: Id | null;
  summary: string;
  verification: string;
  state: "submitted" | "accepted" | "returned";
  review?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TaskWorkflow {
  rootTaskId: Id | null;
  results: TaskResult[];
  decisions: DecisionRequest[];
  deliveryIssues: Array<{ id: Id; taskId: Id; detail: string }>;
}
