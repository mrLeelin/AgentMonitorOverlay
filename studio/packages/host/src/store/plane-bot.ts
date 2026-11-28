import { execFileSync } from "node:child_process";
import type { Id, Session } from "@amo-studio/protocol";
import { HostError } from "../core/shared.js";
import type { Store } from "./store.js";

export type PlaneManagedScope = { job_id: Id; root_task_id: Id; approved_at: string | null; plan_hash: string; base_commit: string; workspace_id: Id; project_path: string };

export function planeManagedScope(store: Store, taskId: Id): PlaneManagedScope | undefined {
  return store.db.prepare(`WITH RECURSIVE chain(id, parent) AS (
    SELECT id, manager_task_id FROM tasks WHERE id = ?
    UNION SELECT t.id, t.manager_task_id FROM tasks t JOIN chain c ON t.id = c.parent
  )
  SELECT a.job_id, j.root_task_id, j.approved_at, a.plan_hash, a.base_commit, a.workspace_id, a.project_path
  FROM chain JOIN plane_bot_jobs j ON j.root_task_id = chain.id
  JOIN plane_bot_approvals a ON a.job_id = j.id AND a.plan_hash = j.approved_plan_hash`).get(taskId) as PlaneManagedScope | undefined;
}

export function planeGitHead(path: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: path, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function assertPlaneManagedBase(store: Store, scope: PlaneManagedScope): void {
  if (!scope.approved_at) throw new HostError("conflict", "Plane 计划正在重新确认，请在工单上批准新版后继续。");
  const workspace = store.getWorkspace(scope.workspace_id);
  if (!workspace || workspace.archivedAt || workspace.path !== scope.project_path || planeGitHead(workspace.path) !== scope.base_commit) {
    throw new HostError("conflict", "Plane 批准的项目或 Git 基准已变化，请重新分析并批准计划。");
  }
}

export function planeManagedMemberVersion(store: Store, taskId: Id): string | undefined {
  const member = store.db.prepare("SELECT plan_hash FROM plane_bot_managed_members WHERE task_id = ?").get(taskId) as { plan_hash: string } | undefined;
  return member?.plan_hash;
}

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
