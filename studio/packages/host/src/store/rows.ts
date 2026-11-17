import type { SQLInputValue } from "node:sqlite";
import type { Id, Session, SessionGoal, SessionItem, SessionOptions, SessionWake, Task, TaskColumn, TaskRemote, Topic, Workspace } from "@amo-studio/protocol";

// Rows of the store's tables as entities (stage 16 split out of store.ts).

export type Row = Record<string, SQLInputValue>;

export const str = (v: SQLInputValue | undefined): string => v as string;
export const ATTACHMENT_ID = /att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
export const strOrNull = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : (v as string));

export function toWorkspace(r: Row): Workspace {
  return {
    id: str(r.id),
    name: str(r.name),
    path: str(r.path),
    ...(r.builtin === "common" ? { builtin: "common" as const } : {}),
    createdAt: str(r.created_at),
    ...(typeof r.archived_at === "string" ? { archivedAt: r.archived_at } : {}),
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
  };
}

export function toTask(r: Row): Task {
  return {
    id: str(r.id),
    title: str(r.title),
    // NULL only for tasks of the old cross-workspace area until the Host resolves them at start-up.
    workspaceId: strOrNull(r.workspace_id) ?? "",
    topicId: strOrNull(r.topic_id),
    managerTaskId: strOrNull(r.manager_task_id),
    column: str(r.column_name) as TaskColumn,
    reviewEnteredAt: strOrNull(r.review_entered_at),
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    ...(typeof r.first_message === "string" && r.first_message ? { firstMessage: r.first_message } : {}),
    ...(Number(r.lead) === 1 ? { lead: true } : {}),
    ...(Number(r.relay_auto) === 1 ? { relayAuto: true } : {}),
    ...parseRemote(r.remote),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

/** 远程 step 2: only a copy of a paired device's task carries the field; a damaged value reads as none. */
function parseRemote(v: unknown): { remote?: TaskRemote } {
  if (typeof v !== "string" || !v) return {};
  try {
    const r = JSON.parse(v) as TaskRemote;
    return r && typeof r === "object" && typeof r.device === "string" ? { remote: r } : {};
  } catch {
    return {};
  }
}

export function toTopic(r: Row): Topic {
  let workspaceIds: Id[] = [];
  try {
    const parsed = JSON.parse(str(r.workspace_ids)) as unknown;
    if (Array.isArray(parsed)) workspaceIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    // a damaged list reads as empty
  }
  return {
    id: str(r.id),
    title: str(r.title),
    workspaceIds,
    ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
  };
}

export function toSession(r: Row): Session {
  return {
    id: str(r.id),
    taskId: strOrNull(r.task_id),
    topicId: strOrNull(r.topic_id),
    parentId: strOrNull(r.parent_id),
    kind: str(r.kind) as Session["kind"],
    ...(r.started_by ? { startedBy: str(r.started_by) } : {}),
    ...(r.report_to ? { reportTo: str(r.report_to) } : {}),
    runtime: str(r.runtime) as Session["runtime"],
    profileId: str(r.profile_id),
    workspaceId: str(r.workspace_id),
    title: str(r.title),
    status: str(r.status) as Session["status"],
    writer: str(r.writer) as Session["writer"],
    runtimeRef: strOrNull(r.runtime_ref),
    options: parseOptions(r.options),
    ...parseWake(r.wake),
    ...parseGoal(r.goal),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    archivedAt: strOrNull(r.archived_at),
    endedAt: strOrNull(r.ended_at),
  };
}

/** Missing snapshots belong to older sessions; an explicit null records a native clear. */
function parseGoal(v: unknown): { goal?: SessionGoal | null } {
  if (typeof v !== "string" || !v) return {};
  try {
    const goal = JSON.parse(v) as SessionGoal | null;
    if (goal === null) return { goal: null };
    if (!goal || typeof goal !== "object" || typeof goal.threadId !== "string" || typeof goal.objective !== "string") return {};
    if (!["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(goal.status)) return {};
    if (![goal.tokensUsed, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return {};
    if (goal.tokenBudget !== null && !(typeof goal.tokenBudget === "number" && Number.isFinite(goal.tokenBudget) && goal.tokenBudget > 0)) return {};
    return { goal };
  } catch {
    return {};
  }
}

/** Only a session something will wake carries the field. */
function parseWake(v: unknown): { wake?: SessionWake } {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v) as SessionWake;
    return o.loop || o.limit ? { wake: o } : {};
  } catch {
    return {};
  }
}

function parseOptions(v: unknown): SessionOptions {
  if (typeof v !== "string" || !v) return {};
  try {
    const o = JSON.parse(v) as Record<string, unknown>;
    const out: SessionOptions = {};
    for (const k of ["model", "effort", "permission"] as const) if (typeof o[k] === "string" && o[k]) out[k] = o[k] as string;
    if (typeof o.fast === "boolean") out.fast = o.fast;
    // MCP 设置 (2026-11-04): the session's own choices by server name.
    if (o.mcp && typeof o.mcp === "object" && !Array.isArray(o.mcp)) {
      const mcp = Object.fromEntries(Object.entries(o.mcp as Record<string, unknown>).filter(([, x]) => typeof x === "boolean")) as Record<string, boolean>;
      if (Object.keys(mcp).length) out.mcp = mcp;
    }
    return out;
  } catch {
    return {};
  }
}

export function toItem(r: Row): SessionItem {
  return { ...(JSON.parse(str(r.body)) as object), seq: Number(r.seq) } as SessionItem;
}
