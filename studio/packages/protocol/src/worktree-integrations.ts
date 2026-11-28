import type { Id, Timestamp } from "./entities.js";

export type PlannedTaskExecution =
  | { kind: "project" }
  | { kind: "worktree"; baseCommit: string; branch?: string;
      /** Subset of dependsOn, with the same planned keys or existing task IDs. */
      integrateFrom?: string[] };

/** The actual input location or verification point, independent of a read-only lead session. */
export interface TaskWorktreeEvidence {
  taskId: Id;
  sessionId: Id;
  /** When quoted by a lead, the exact accepted worker delivery that supplied this checkout. */
  resultId?: Id;
  title?: string;
  cwd: string;
  baseCommit: string;
  headCommit?: string;
  changedPaths?: string[];
  changeDigest?: string;
  workingTreeDirty?: boolean;
  integrations?: WorktreeIntegrationReceipt[];
}

/** Assigned by the Host before the gated first run, even if a session has not been created yet. */
export interface TaskWorktreeTarget {
  id: Id;
  cwd: string;
  baseCommit: string;
}

export interface WorktreeIntegrationRequirement {
  prerequisiteTaskId: Id;
  /** Null until the prerequisite has an eligible current result. A new result invalidates the old receipt. */
  prerequisiteResultId: Id | null;
}

export type WorktreeIntegrationEvidence =
  | { kind: "commit"; commit: string }
  | { kind: "patch"; evidenceRef: string }
  | { kind: "manual"; evidenceRef: string };

export interface WorktreeIntegrationInput {
  operationId: Id;
  prerequisiteTaskId: Id;
  prerequisiteResultId: Id;
  /** Must still identify this task's assigned checkout. Session creation can itself be gated. */
  worktreeId: Id;
  evidence: WorktreeIntegrationEvidence;
}

export interface WorktreeIntegrationReceipt extends WorktreeIntegrationInput {
  taskId: Id;
  recordedAt: Timestamp;
  verification: "git" | "needs-review" | "reviewed" | "returned";
  review?: { text: string; reviewedAt: Timestamp };
}

export interface WorktreeIntegrationReviewInput {
  prerequisiteResultId: Id;
  accept: boolean;
  review: string;
}

export interface TaskWorktreeIntegrations {
  taskId: Id;
  worktree: TaskWorktreeTarget | null;
  waiting: WorktreeIntegrationRequirement[];
  receipts: WorktreeIntegrationReceipt[];
}

export interface WorktreeIntegrationRoutes {
  "GET /api/tasks/:id/worktree-integrations": { req: void; res: TaskWorktreeIntegrations };
  "POST /api/tasks/:id/worktree-integrations": { req: WorktreeIntegrationInput; res: WorktreeIntegrationReceipt };
  "POST /api/tasks/:id/worktree-integrations/:operationId/review": { req: WorktreeIntegrationReviewInput; res: WorktreeIntegrationReceipt };
}
