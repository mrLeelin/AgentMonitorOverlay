/** The latest native Goal snapshot. The underlying Agent remains the source of truth. */
export interface SessionGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  /** Native timestamps, in Unix seconds. */
  createdAt: number;
  updatedAt: number;
  /** Native continuation checks, when the Agent exposes them. */
  iterations?: number;
  lastReason?: string;
  /** DSH's native round cap, distinct from a token budget. */
  roundBudget?: number;
}

export interface SessionGoalState {
  goal: SessionGoal | null;
  unavailable?: string;
  /** Older Codex Hosts omit this; all four capabilities were supported there. */
  capabilities?: { tokenBudget: boolean; pause: boolean; tokens: boolean; elapsed: boolean; roundBudget?: boolean };
  /** A user-facing difference in this Agent's native Goal behavior. */
  note?: string;
}

/** Explicit user actions only; automatic lifecycle changes arrive from the runtime. */
export interface SessionGoalUpdate {
  objective?: string;
  tokenBudget?: number;
  roundBudget?: number;
  status?: "active" | "paused";
}
