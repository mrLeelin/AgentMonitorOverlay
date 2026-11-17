import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, SessionGoal, SessionGoalState, SessionGoalUpdate, Task, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { withMentionRefs, type MentionPick } from "../attach/mentions.js";
import { resourceMessage } from "../attach/inlineResources.js";
import { GoalObjectiveInput } from "./GoalObjectiveInput.js";
import "./goal.css";

const STATUS: Record<SessionGoal["status"], string> = { active: "进行中", paused: "已暂停", blocked: "遇到阻碍", usageLimited: "额度已用尽", budgetLimited: "预算已用尽", complete: "已完成" };
const CODEX_CAPABILITIES = { tokenBudget: true, pause: true, tokens: true, elapsed: true, roundBudget: false };
const UNKNOWN_CAPABILITIES = { tokenBudget: false, pause: false, tokens: false, elapsed: false, roundBudget: false };
type GoalView = { sessionId: string; state: SessionGoalState | null; error: string | null };
type GoalDraft = { sessionId: string; objective: string; refs: ReadonlyMap<string, MentionPick>; budget: string; busy: boolean; note: string | null };

function errorText(error: unknown): string {
  if (error instanceof HostApiError && error.status === 404) return "当前 Host 没有提供 Goal 接口。请在会话空闲后手动重启新版 Host，再刷新重试。";
  return error instanceof Error ? error.message : String(error);
}

function budgetValue(text: string, label = "Token 预算"): number | undefined {
  if (!text.trim()) return undefined;
  const value = /^\d+$/.test(text.trim()) ? Number(text) : NaN;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label}请输入大于 0 的整数。`);
  return value;
}

function statusLabel(goal: SessionGoal, roundBudget: boolean): string {
  return goal.status === "budgetLimited" && roundBudget ? "轮数已用尽" : STATUS[goal.status];
}

/** Goal stays in the Agent; a fresh read and its native notifications are the only source of truth here. */
export function useSessionGoal(link: HostLink, session: Session) {
  const scope = useMemo(() => ({}), [link.url, link.token, session.id]);
  const current = useRef<object | null>(scope);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    return () => { if (current.current === scope) current.current = null; };
  }, [scope]);
  const initial: GoalView = { sessionId: session.id, state: null, error: null };
  const latestView = useRef<GoalView>(initial);
  const supported = session.runtime === "codex" || session.runtime === "claude" || session.runtime === "dsh";
  const [view, , refresh] = useLiveResource<GoalView>({
    initial,
    reset: true,
    load: supported ? async () => {
      try { return { sessionId: session.id, state: await call(link, "GET /api/sessions/:id/goal", { id: session.id }), error: null }; }
      catch (error) { return { sessionId: session.id, state: null, error: errorText(error) }; }
    } : null,
    onEvent: (value, event) => event.type === "session.goal" && event.sessionId === session.id ? { sessionId: session.id, state: { ...(value.sessionId === session.id ? value.state : null), unavailable: undefined, goal: event.goal }, error: null } : value,
    // Claude exposes reliable consumption only after its native completion check. Refresh capabilities on that
    // transition, and when an unavailable runtime starts reporting again, without polling every Goal snapshot.
    reloadOn: (event) => event.type === "session.goal" && event.sessionId === session.id && (!!latestView.current.state?.unavailable || (session.runtime !== "codex" && (event.goal?.status === "complete" || event.goal?.status === "blocked") && latestView.current.state?.goal?.status !== event.goal.status)),
    reloadDelay: 100,
  }, [link.url, link.token, session.id, session.runtime]);
  latestView.current = view;
  const empty: GoalDraft = { sessionId: session.id, objective: "", refs: new Map(), budget: "", busy: false, note: null };
  const [savedDraft, setDraft] = useState<GoalDraft>(empty);
  useEffect(() => { setDraft({ sessionId: session.id, objective: "", refs: new Map(), budget: "", busy: false, note: null }); }, [scope]);
  const draft = savedDraft.sessionId === session.id ? savedDraft : empty;
  const data = view.sessionId === session.id ? view : initial;
  const state = data.state;
  const goal = state?.goal ?? null;
  // A native event may precede the first GET; only Codex had these capabilities before explicit discovery.
  const capabilities = state?.capabilities ?? (session.runtime === "codex" ? CODEX_CAPABILITIES : UNKNOWN_CAPABILITIES);
  const updateDraft = (patch: Partial<GoalDraft>) => setDraft((previous) => ({ ...(previous.sessionId === session.id ? previous : empty), ...patch }));

  async function change(action: "create" | "pause" | "resume" | "budget" | "clear") {
    if (draft.busy || !state || state.unavailable) return;
    const rounds = capabilities.roundBudget === true;
    const hasBudget = rounds || capabilities.tokenBudget;
    let body: SessionGoalUpdate = {};
    try {
      if (action === "create") {
        const objective = resourceMessage(withMentionRefs(draft.objective.trim(), draft.refs), []).text;
        if (!objective || objective.length > 4000) throw new Error("请填写目标，最多 4000 个字符。");
        const budget = hasBudget ? budgetValue(draft.budget, rounds ? "续跑轮数上限" : "Token 预算") : undefined;
        body = { objective, status: "active", ...(budget === undefined ? {} : rounds ? { roundBudget: budget } : { tokenBudget: budget }) };
      } else if (action === "budget") {
        if (!hasBudget) throw new Error("当前 Agent 不支持调整 Goal 上限。");
        const budget = budgetValue(draft.budget, rounds ? "续跑轮数上限" : "Token 预算");
        const minimum = goal ? rounds ? Math.max(goal.iterations ?? 0, goal.roundBudget ?? 0) : Math.max(goal.tokensUsed, goal.tokenBudget ?? 0) : 0;
        if (!goal || budget === undefined || budget <= minimum) throw new Error(rounds ? "新的轮数上限必须大于已续跑轮数和原上限。" : "新总预算必须大于已用 Token 数和原预算。");
        body = { status: "active", ...(rounds ? { roundBudget: budget } : { tokenBudget: budget }) };
      } else if (action !== "clear") {
        if (action === "pause" && !capabilities.pause) throw new Error("当前 Agent 不支持暂停 Goal。");
        body = { status: action === "pause" ? "paused" : "active" };
      }
    } catch (error) {
      updateDraft({ note: errorText(error) });
      return;
    }
    updateDraft({ busy: true, note: null });
    try {
      if (action === "clear") await call(link, "DELETE /api/sessions/:id/goal", { id: session.id });
      else await call(link, "PUT /api/sessions/:id/goal", { id: session.id }, body);
      if (current.current === scope && (action === "create" || action === "budget" || action === "clear")) updateDraft({ objective: "", refs: new Map(), budget: "" });
    } catch (error) {
      if (current.current === scope) updateDraft({ note: errorText(error) });
    } finally {
      if (current.current === scope) {
        updateDraft({ busy: false });
        // A response can arrive after a newer native event. Re-read instead of overwriting that event with it.
        refresh();
      }
    }
  }

  return { link, session, state, goal, capabilities, supported, runtime: session.runtime, error: data.error, draft, updateDraft, change, refresh };
}

type GoalControl = ReturnType<typeof useSessionGoal>;

export function SessionGoalButton({ control, expanded, onClick }: { control: GoalControl; expanded: boolean; onClick(): void }) {
  const { goal, state, capabilities, error } = control;
  const label = error ? "读取失败" : state?.unavailable ? "不可用" : goal ? statusLabel(goal, capabilities.roundBudget === true) : state ? "未开启" : "";
  return (
    <button type="button" className="seg-btn goal-toggle" data-status={goal?.status} aria-expanded={expanded} onClick={onClick} title={error || state?.unavailable || (goal ? goal.objective : "设定目标，让 Agent 持续执行")} data-testid="switch-goal">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" /><circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.3" /></svg>
      <span>Goal{label ? ` ${label}` : ""}</span>
    </button>
  );
}

export function SessionGoalTray({ control, disabled, tasks, sessions, projects }: { control: GoalControl; disabled: boolean; tasks: readonly Task[]; sessions: readonly Session[]; projects: readonly Workspace[] }) {
  const { state, goal, capabilities, runtime, error, draft, updateDraft, change, refresh } = control;
  const locked = disabled || draft.busy || !state || !!state.unavailable || !!error;
  const format = (value: number) => value.toLocaleString("zh-CN");
  const seconds = goal && capabilities.elapsed && Number.isFinite(goal.timeUsedSeconds) && goal.timeUsedSeconds >= 0 ? Math.floor(goal.timeUsedSeconds) : null;
  const elapsed = seconds === null ? null : seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分`;
  const showTokens = goal && capabilities.tokens && Number.isFinite(goal.tokensUsed) && goal.tokensUsed >= 0;
  const iterations = goal?.iterations !== undefined && Number.isFinite(goal.iterations) && goal.iterations >= 0 ? goal.iterations : null;
  const rounds = capabilities.roundBudget === true;
  const hasBudget = rounds || capabilities.tokenBudget;
  const roundLimit = rounds && goal?.roundBudget !== undefined && Number.isFinite(goal.roundBudget) && goal.roundBudget > 0 ? goal.roundBudget : null;
  const minimumBudget = goal ? rounds ? Math.max(goal.iterations ?? 0, goal.roundBudget ?? 0) : Math.max(goal.tokensUsed, goal.tokenBudget ?? 0) : 0;
  const runtimeNote = state?.note ?? (runtime === "codex" && goal && goal.status !== "complete" ? "暂停续跑或清除目标不会中断当前回复；要立即停止，请使用会话的停止按钮。" : null);
  return (
    <div className="goal-content" data-testid="goal-tray">
      <div className="tray-h goal-heading"><span>Goal 目标</span>{goal && <span className="goal-status" data-status={goal.status} data-testid="goal-status">{statusLabel(goal, rounds)}</span>}<button type="button" className="link-btn goal-refresh" disabled={draft.busy} onClick={refresh}>刷新</button></div>
      {!state && !error && <div className="tray-note" role="status">正在读取 Goal…</div>}
      {(error || state?.unavailable) && <div className="form-error" role="alert" data-testid="goal-unavailable">{error || state?.unavailable}</div>}
      {goal ? (
        <>
          <div className="goal-objective" data-testid="goal-objective">{goal.objective}</div>
          {(showTokens || elapsed !== null || iterations !== null || roundLimit !== null) && <div className="goal-metrics">{showTokens && <span>已用 <b>{format(goal.tokensUsed)}</b> Token{capabilities.tokenBudget ? goal.tokenBudget === null ? " · 未设预算" : ` / ${format(goal.tokenBudget)}` : ""}</span>}{elapsed !== null && <span>累计用时 {elapsed}</span>}{iterations !== null ? <span data-testid="goal-iterations">{rounds ? `已续跑 ${format(iterations)}${roundLimit === null ? "" : ` / ${format(roundLimit)}`} 轮` : `目标检查 ${format(iterations)} 次`}</span> : roundLimit !== null && <span>续跑上限 {format(roundLimit)} 轮</span>}</div>}
          {goal.lastReason?.trim() && <div className="goal-reason" data-testid="goal-reason">状态说明：{goal.lastReason}</div>}
          {goal.status === "budgetLimited" && hasBudget && <label className="goal-field goal-budget">{rounds ? "新的续跑轮数上限" : "新的 Token 总预算"}<input inputMode="numeric" value={draft.budget} placeholder={`大于 ${format(minimumBudget)}`} disabled={locked} onChange={(event) => updateDraft({ budget: event.target.value, note: null })} data-testid="goal-budget" /></label>}
          <div className="goal-actions">
            {goal.status === "active" && capabilities.pause && <button type="button" className="btn-ghost small" disabled={locked} onClick={() => void change("pause")} data-testid="goal-pause">{runtime === "codex" ? "暂停续跑" : "暂停 Goal"}</button>}
            {goal.status === "budgetLimited" && hasBudget ? <button type="button" className="btn-primary small" disabled={locked || !draft.budget.trim()} onClick={() => void change("budget")} data-testid="goal-budget-resume">{rounds ? "增加轮数并继续" : "增加预算并继续"}</button> : goal.status !== "active" && goal.status !== "complete" && <button type="button" className="btn-primary small" disabled={locked} onClick={() => void change("resume")} data-testid="goal-resume">继续执行</button>}
            <button type="button" className="btn-ghost small" disabled={locked} onClick={() => void change("clear")} data-testid="goal-clear">清除目标</button>
            {draft.busy && <span className="tray-note" role="status">正在更新…</span>}
          </div>
          {goal.status === "complete" && <div className="tray-note">目标已完成，清除后可设定新目标。</div>}
        </>
      ) : (
        <>
          <GoalObjectiveInput key={control.session.id} link={control.link} session={control.session} tasks={tasks} sessions={sessions} projects={projects} value={draft.objective} refs={draft.refs} onChange={(objective) => updateDraft({ objective, note: null })} onRefs={(refs) => updateDraft({ refs })} disabled={locked} />
          <div className="goal-create-row">{hasBudget && <label className="goal-field goal-budget">{rounds ? "续跑轮数上限（可选）" : "Token 预算（可选）"}<input inputMode="numeric" value={draft.budget} placeholder={rounds ? "使用 Agent 默认上限" : "留空不设预算"} disabled={locked} onChange={(event) => updateDraft({ budget: event.target.value, note: null })} data-testid="goal-budget" /></label>}<button type="button" className="btn-primary small" disabled={locked || !draft.objective.trim()} onClick={() => void change("create")} data-testid="goal-start">{draft.busy ? "正在开启…" : "开启 Goal"}</button></div>
          <div className="tray-note">开启后，Agent 会围绕目标自动继续执行。</div>
        </>
      )}
      {runtimeNote && <div className="tray-note" data-testid="goal-runtime-note">{runtimeNote}</div>}
      {draft.note && <div className="form-error" role="alert" data-testid="goal-error">{draft.note}</div>}
      {disabled && <div className="tray-note">当前会话只读，不能修改 Goal。</div>}
    </div>
  );
}
