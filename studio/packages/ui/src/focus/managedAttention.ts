import { isManagedBy, managementRoot, type DecisionRequest, type Session, type Task } from "@amo-studio/protocol";

/** Only an explicitly routed business decision belongs to the manager; legacy and runtime questions stay visible. */
export function decisionNeedsPerson(decision: DecisionRequest, tasks: readonly Task[]): boolean {
  const manager = tasks.find((t) => t.id === decision.routedToTaskId);
  return !manager || !manager.lead || !!manager.archivedAt || !!manager.remote || !decision.taskId || !isManagedBy(tasks, decision.taskId, manager.id);
}

/** A normal managed reply is reviewed by its lead. Failures and blocking runtime requests remain visible. */
export function replyNeedsPerson(session: Session, tasks: readonly Task[], sessions: readonly Session[]): boolean {
  if (!session.taskId || (session.status !== "idle" && session.status !== "completed")) return true;
  const root = managementRoot(tasks, session.taskId);
  if (!root) return true;
  // A coordinator ending a planning/review turn is still waiting for delivery, not asking the person to review it.
  if (root.id === session.taskId) return !tasks.some((t) => t.managerTaskId === root.id && !t.archivedAt) || root.column === "done";
  // Never hide work when its reporting destination has no usable conversation.
  return !sessions.some((s) => s.taskId === root.id && s.kind === "main" && !s.archivedAt && s.writer !== "archived" && s.writer !== "terminal-handoff");
}
