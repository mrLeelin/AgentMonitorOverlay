import type { Session, SessionGoalUpdate, SessionRuntime, Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";

export interface DraftGoal { tokenBudget: string; roundBudget: string }
export interface PendingGoalStart { taskId: string; sessionId: string; goal: SessionGoalUpdate; onCanvas?: boolean }
const KEY = "amo.pendingGoalStart";

export const supportsDraftGoal = (runtime?: SessionRuntime) => runtime === "codex" || runtime === "claude" || runtime === "dsh";

/** Validate before creating an empty session: Goal itself supplies its first work turn. */
export function draftGoalInput(text: string, draft: DraftGoal, runtime?: SessionRuntime): SessionGoalUpdate {
  if (!supportsDraftGoal(runtime)) throw new Error("这个模型尚未接入 Goal，请关闭 Goal 或换一个模型。");
  const objective = text.trim();
  if (!objective || [...objective].length > 4000) throw new Error("Goal 目标不能为空，且不能超过 4000 个字符（含引用内容）。");
  if (runtime === "claude" && /^(clear|off)$/i.test(objective)) throw new Error("clear 和 off 是 Claude 的清除命令，请填写具体目标。");
  const budget = (runtime === "codex" ? draft.tokenBudget : runtime === "dsh" ? draft.roundBudget : "").trim();
  if (budget && (!/^\d+$/.test(budget) || !Number.isSafeInteger(Number(budget)) || Number(budget) < 1)) throw new Error(`${runtime === "dsh" ? "续跑轮数上限" : "Token 预算"}请输入大于 0 的整数。`);
  return { objective, status: "active", ...(budget ? runtime === "dsh" ? { roundBudget: Number(budget) } : { tokenBudget: Number(budget) } : {}) };
}

export function readPendingGoalStart(): PendingGoalStart | null {
  const value = readStoredJson(KEY) as PendingGoalStart | null;
  return value && typeof value.taskId === "string" && typeof value.sessionId === "string" && typeof value.goal?.objective === "string" ? value : null;
}
export const savePendingGoalStart = (value: PendingGoalStart | null) => writeStoredJson(KEY, value);

export class GoalStartError extends Error {
  constructor(readonly pending: PendingGoalStart, error: unknown) {
    super(error instanceof HostApiError && error.status === 404 ? "当前 Host 没有提供 Goal 接口，请在会话空闲后手动重启新版 Host。" : error instanceof Error ? error.message : String(error));
  }
}

export async function activateDraftGoal(link: HostLink, pending: PendingGoalStart, recover = false): Promise<void> {
  try {
    if (pending.onCanvas) await call(link, "PUT /api/tasks/:id/canvas", { id: pending.taskId }, { onCanvas: true });
    // A reload may lose the activation response. Keep a Goal that already exists, including a human pause.
    if (recover) {
      const state = await call(link, "GET /api/sessions/:id/goal", { id: pending.sessionId });
      if (state.goal?.objective === pending.goal.objective) { savePendingGoalStart(null); return; }
    }
    const state = await call(link, "PUT /api/sessions/:id/goal", { id: pending.sessionId }, pending.goal);
    if (state.unavailable || !state.goal) throw new Error(state.unavailable || "Agent 未确认 Goal 已开启，请重试。");
    savePendingGoalStart(null);
  } catch (error) { throw new GoalStartError(pending, error); }
}

/** Recovery reads the existing session; it must never create another task or resend a first message. */
export async function existingGoalStart(link: HostLink, pending: PendingGoalStart): Promise<{ task: Task; session: Session }> {
  const state = await call(link, "GET /api/state");
  const task = state.tasks.find((t) => t.id === pending.taskId && !t.archivedAt);
  const session = state.sessions.find((s) => s.id === pending.sessionId && s.taskId === task?.id && !s.archivedAt);
  if (!task || !session) throw new Error("已建任务或会话已归档、删除，请放弃这次开启后重新创建。");
  return { task, session };
}
