import type { DecisionRequest, Id, Task, Timestamp } from "./entities.js";
import type { ContextBasis, ContextResolution } from "./shared-context.js";

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
  contextBasis?: ContextBasis;
  prerequisiteResultIds?: Id[];
  /** Submission is saved even when its declared evidence needs a manager's decision. */
  contextMismatch?: string;
  contextResolution?: ContextResolution;
  state: "submitted" | "accepted" | "returned";
  review?: string;
  /** Explicit reviewer of this result; absent on historical records. A root's final review belongs to the user. */
  reviewedBy?: "user" | "manager";
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TaskWorkflow {
  rootTaskId: Id | null;
  results: TaskResult[];
  decisions: DecisionRequest[];
  deliveryIssues: Array<{ id: Id; taskId: Id; detail: string }>;
  /** Durable transport history. Expired notices are historical, never delivery failures. */
  deliveryNotices?: Array<{ id: Id; taskId: Id; state: "waiting" | "delivered" | "expired" | "failed"; detail: string; replacesNoticeId?: Id }>;
}
