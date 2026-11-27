import type { Id, Session } from "@amo-studio/protocol";
import type { Store } from "./store.js";

export function planeBotWorkspaceId(store: Store, taskId: Id): Id | undefined {
  const job = store.db.prepare("SELECT workspace_id FROM plane_bot_jobs WHERE task_id = ?").get(taskId) as { workspace_id: Id } | undefined;
  return job?.workspace_id;
}

export function isPlaneBotWorker(store: Store, taskId: Id): boolean {
  return planeBotWorkspaceId(store, taskId) !== undefined;
}

export function inPlaneBotWorktree(session: Session | undefined, taskId: Id, workspaceId: Id): session is Session & { cwd: string } {
  return !!session?.cwd && session.taskId === taskId && session.workspaceId === workspaceId;
}

/** A new main session on the same task takes the worker's checkout, even if its original chat was archived. */
export function planeBotWorkerSession(store: Store, taskId: Id, workspaceId: Id) {
  return store.listSessions({ taskId }).find((session) => session.kind === "main" && !session.parentId && inPlaneBotWorktree(session, taskId, workspaceId));
}
