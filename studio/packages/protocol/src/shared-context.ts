import type { Id, Timestamp } from "./entities.js";

/** A published requirement is immutable; rollback publishes another version. */
export interface ContextBasis { contextId: Id; version: number }
export interface ContextSource { kind: "user_requirement" | "lead_agreement" | "suggestion"; source: string }
export interface ContextDraft { body: string; changeNote: string; sources: ContextSource[] }
export interface SharedContextVersion extends ContextDraft { version: number; publishedAt: Timestamp; publishedBySessionId: Id }
export interface SharedContext {
  id: Id;
  rootTaskId: Id;
  title: string;
  revision: number;
  draft: ContextDraft;
  currentVersion: number | null;
  versions: SharedContextVersion[];
}
/** Explicit task requirement, independent of the context's current version. */
export interface TaskContextBinding extends ContextBasis { id: Id; taskId: Id; rootTaskId: Id; managementPath: Id[]; invalidatedAt?: Timestamp; appliedAt: Timestamp; appliedByTaskId: Id; appliedBySessionId: Id }
/** Enqueued, delivered to the runtime, and declared adopted are different facts. */
export interface ContextReceipt extends ContextBasis { requirementId: Id; taskId: Id; rootTaskId: Id; sessionId: Id; queuedAt?: Timestamp; deliveredAt?: Timestamp; adoptedAt?: Timestamp }
export interface SharedContextView {
  context: SharedContext | null;
  binding: TaskContextBinding | null;
  validBinding: boolean;
  receipts: ContextReceipt[];
  prerequisiteResultIds: Id[];
}
export interface ContextSaveInput extends ContextDraft { rootTaskId: Id; baseRevision: number; title: string }
export interface ContextApplyInput extends ContextBasis { taskIds: Id[] }
export interface ContextSubmissionInput { contextBasis?: ContextBasis; prerequisiteResultIds?: Id[] }
export interface ContextResolution { explanation: string; requiredBasis?: ContextBasis }
