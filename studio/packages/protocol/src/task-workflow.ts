import type { DecisionRequest, Id, Session, Task, Timestamp } from "./entities.js";
import type { BotLeadAttribution, BotLeadTaskState } from "./bot-leads.js";
import type { ContextBasis, ContextResolution } from "./shared-context.js";
import type { TaskWorktreeEvidence, WorktreeIntegrationRequirement } from "./worktree-integrations.js";

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
  /** The user-approved Plane scope in force when this delivery was filed. */
  planePlanHash?: string;
  id: Id;
  taskId: Id;
  sessionId: Id;
  managerTaskId: Id | null;
  summary: string;
  verification: string;
  /** Captured by the Host from the actual submitting session. */
  submittedByLead?: BotLeadAttribution;
  worktrees?: TaskWorktreeEvidence[];
  contextBasis?: ContextBasis;
  prerequisiteResultIds?: Id[];
  /** Submission is saved even when its declared evidence needs a manager's decision. */
  contextMismatch?: string;
  contextResolution?: ContextResolution;
  state: "submitted" | "accepted" | "returned";
  review?: string;
  /** Explicit reviewer of this result; absent on historical records. A root's final review belongs to the user. */
  reviewedBy?: "user" | "manager";
  /** Original human decision, retained if subsequent work invalidates this result. Never inferred from board moves. */
  userReview?: { state: "accepted" | "returned"; review: string; reviewedAt: Timestamp };
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

export interface TaskResultHeader extends Omit<TaskResult, "summary" | "verification" | "review" | "userReview" | "contextMismatch" | "contextResolution" | "worktrees"> {
  userReview?: Omit<NonNullable<TaskResult["userReview"]>, "review">;
  hasContextMismatch: boolean;
  hasContextResolution: boolean;
  textLengths: { summary: number; verification: number; review: number; userReview: number };
}

/** Complete TaskResult as JSON; concatenate text chunks before parsing. Offsets count UTF-16 code units. */
export interface TaskResultPage {
  result: TaskResultHeader;
  latest: boolean;
  acceptedCurrent: boolean;
  text: string;
  nextOffset: number | null;
  length: number;
}

/** Query on a root route. Omitted parentTaskId starts with the root and its direct children. */
export interface TaskWorkflowSummaryQuery {
  parentTaskId?: Id;
  limit?: number;
  cursor?: string;
}

export interface TaskWorkflowSummaryRow {
  taskId: Id;
  title: string;
  managerTaskId: Id | null;
  lead: boolean;
  column: Task["column"];
  botLead?: BotLeadTaskState;
  directTaskCount: number;
  latestResult: TaskResultHeader | null;
  acceptedCurrent: boolean;
  prerequisiteResultIds: readonly Id[];
  waitingForTaskIds: readonly Id[];
  waitingForWorktree?: WorktreeIntegrationRequirement[];
  /** The selected main session only. History is read on demand. */
  session: Pick<Session, "id" | "status" | "createdAt"> | null;
}

export interface TaskWorkflowSummaryPage {
  rootTaskId: Id;
  parentTaskId: Id | null;
  nextCursor: string | null;
  tasks: TaskWorkflowSummaryRow[];
  /** Direct children of the root and unique execution descendants of the root, independent of the page. */
  counts: { directTasks: number; executionTasks: number; acceptedExecutionTasks: number };
  /** IDs point to the same decisions and result version used by the task and Focus views. */
  decisions: Array<Pick<DecisionRequest, "id" | "taskId" | "sessionId" | "createdAt">>;
  pendingUserReviewResultId: Id | null;
}

export interface TaskResultPageQuery { offset?: number }

export interface TaskWorkflowRoutes {
  "GET /api/tasks/:id/workflow/summary": { req: void; res: TaskWorkflowSummaryPage };
  "GET /api/tasks/:id/workflow/results/:resultId": { req: void; res: TaskResultPage };
}
