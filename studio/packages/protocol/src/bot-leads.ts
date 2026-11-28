import type { BotInput } from "./bots.js";
import type { Id, SessionOptions, SessionRuntime, Timestamp } from "./entities.js";

export type BotLeadTermRef = { termId: Id; generation: number };

/** Inputs to user-facing routes identify the source. The Host resolves its owner and authorization. */
export type BotLeadUserSource =
  | { kind: "manual" }
  | { kind: "bot-request"; requestId: Id }
  | { kind: "user-message"; sessionId: Id; messageId: Id };

export type BotLeadSource = BotLeadUserSource
  | { kind: "task-plan"; planId: Id; taskKey: string }
  | { kind: "plane"; jobId: Id }
  | { kind: "automation"; configurationId: Id; requestId: Id }
  | { kind: "legacy-binding" };

export type BotLeadConfigSnapshot = Pick<BotInput, "name" | "avatar" | "purpose" | "profileId" | "skills"> & {
  runtime: Extract<SessionRuntime, "codex" | "claude" | "dsh">;
  options: Pick<SessionOptions, "model" | "effort" | "fast"> & { permission: "read-only" | "plan" };
};

/** An appointed term's runtime state can change without changing its generation or any delivery status. */
export type BotLeadRunState = "pending" | "starting" | "running" | "idle" | "paused" | "failed" | "needs-reconciliation";

export interface BotLeadTermSummary extends BotLeadTermRef {
  botId: Id;
  name: string;
  avatar?: string | null;
  sessionId: Id | null;
  state: "active" | "handing-off" | "ended";
  runState: BotLeadRunState;
  reason?: string;
}

export interface BotLeadTerm extends BotLeadTermSummary {
  taskId: Id;
  snapshot: BotLeadConfigSnapshot;
  source: BotLeadSource;
  handoff: string;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
}

/** Retained on results and historical sessions even when an active session is replaced. */
export interface BotLeadAttribution extends BotLeadTermRef {
  botId: Id;
  name: string;
}

export type BotLeadHandoffBlocker =
  | { kind: "turn" | "background-command" | "terminal"; sessionId: Id }
  | { kind: "approval" | "unsent-message"; sessionId: Id; itemId: Id };

export type BotLeadTaskState =
  | { kind: "appointed"; term: BotLeadTermSummary & { state: "active" | "handing-off" }; handoff?: { operationId: Id; blockers: BotLeadHandoffBlocker[] } }
  | { kind: "pending-upgrade"; operationId: Id; botId: Id; blockers: BotLeadHandoffBlocker[]; reason?: string }
  | { kind: "legacy"; state: "needs-bot" | "historical"; issue?: string; summary?: string; topicTitle?: string };

export type BotLeadChoice = { botId: Id; newBot?: never } | { newBot: BotInput; botId?: never };
export type BotLeadTopicTarget = { topicId: Id; topicTitle?: never } | { topicTitle: string; topicId?: never };

export type BotLeadAppointmentInput = { operationId: Id; source: BotLeadUserSource } & (
  | { intent: "create"; workspaceId: Id; title: string; description?: string; firstMessage?: string;
      /** Explicitly permits a second, independent goal from a source that already has a first acceptance. */
      sourceUse?: "initial" | "new-goal"; start?: boolean; topic: BotLeadTopicTarget } & BotLeadChoice
  | { intent: "continue"; taskId: Id; expectedTerm: BotLeadTermRef; text: string; purpose: "work" | "reopen" }
  | { intent: "upgrade"; taskId: Id; expectedTerm: null; summary: string; topicTitle?: string } & BotLeadChoice
);

export type BotLeadControlInput = { operationId: Id } & (
  | { action: "replace"; expectedTerm: BotLeadTermRef; summary?: string } & BotLeadChoice
  | { action: "cancel-handoff"; expectedTerm: BotLeadTermRef | null; handoffOperationId: Id }
  | { action: "retry-start" | "pause" | "resume"; expectedTerm: BotLeadTermRef }
);

export interface BotLeadLegacyBindingsInput {
  operationId: Id;
  bindings: Array<{ taskId: Id; botId: Id; expectedTerm: null }>;
}

export interface BotLeadLegacyIssue {
  taskId: Id;
  topicId: Id | null;
  managerTaskId: Id | null;
  title: string;
  reason: string;
}

/** A committed acceptance is available before the first turn. A later read resolves the live term and canvas. */
export type BotLeadOperationReceipt = {
  operationId: Id;
  taskId: Id;
  /** An unbound task being upgraded acquires its topic when the handoff commits. */
  topicId: Id | null;
  action: "create" | "continue" | "upgrade";
  state: BotLeadTaskState;
} | {
  operationId: Id;
  taskId: Id;
  topicId: Id | null;
  action: "worker";
};

export interface BotLeadOperationView {
  receipt: BotLeadOperationReceipt;
  /** Live delivery progress is separate from the original operation's replayable receipt. */
  delivery?: {
    messageId: Id;
    stage: "queued" | "delivered" | "processed" | "failed" | "needs-reconciliation";
    reason?: string;
  };
}

/** A read also distinguishes a pending upgrade and historical anonymous lead from an unassigned task. */
export interface BotLeadTaskView {
  taskId: Id;
  topicId: Id | null;
  state: BotLeadTaskState | null;
  terms?: BotLeadTermSummary[];
}

export interface BotLeadRoutes {
  "GET /api/bot-leads/legacy-issues": { req: void; res: BotLeadLegacyIssue[] };
  "POST /api/bot-leads/appointments": { req: BotLeadAppointmentInput; res: BotLeadOperationReceipt };
  "GET /api/bot-leads/operations/:id": { req: void; res: BotLeadOperationView };
  "GET /api/tasks/:id/bot-lead": { req: void; res: BotLeadTaskView };
  "GET /api/tasks/:id/bot-lead/terms/:termId": { req: void; res: BotLeadTerm };
  "POST /api/tasks/:id/bot-lead/control": { req: BotLeadControlInput; res: BotLeadTaskView };
  "POST /api/tasks/:id/bot-lead/legacy-bindings": { req: BotLeadLegacyBindingsInput; res: BotLeadTaskView[] };
}
