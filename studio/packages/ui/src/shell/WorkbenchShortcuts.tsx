import { useId, useRef, useState, useSyncExternalStore, type FocusEvent, type ReactNode } from "react";
import type { DecisionRequest, PlaneBotAttention, ScheduleProposal, Session, StateSnapshot } from "@amo-studio/protocol";
import { needsPerson, SESSION_LOOK, taskSessions, taskStatus } from "../lib/status.js";
import { toggleTheme, useThemePref } from "../lib/theme.js";
import { planeBotStatus } from "../teamtasks/PlaneBot.js";
import { planeBotNeedsAttention, planeBotTaskIds } from "../teamtasks/planeBotAttention.js";

export interface ShortcutItem {
  id: string;
  title: string;
  detail: string;
  pick(): void;
}

export function recentSessions(state: StateSnapshot, open: (session: Session) => void): ShortcutItem[] {
  const tasks = new Map(state.tasks.filter(t => !t.archivedAt).map(t => [t.id, t]));
  const topics = new Map(state.topics.filter(t => !t.archivedAt).map(t => [t.id, t]));
  return state.sessions.filter(s => !s.archivedAt && (s.taskId ? tasks.has(s.taskId) : s.topicId && topics.has(s.topicId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map(s => ({
      id: s.id, title: s.title || "新会话",
      detail: [s.taskId ? tasks.get(s.taskId)?.title : topics.get(s.topicId!)?.title, SESSION_LOOK[s.status].label].filter(Boolean).join(" · "),
      pick: () => open(s),
    }));
}

/** One row per task or pending proposal, matching the workbench's 需要你 counter. */
export function pendingItems(state: StateSnapshot, decisions: readonly DecisionRequest[], proposals: readonly ScheduleProposal[],
  openTask: (taskId: string, sessionId?: string) => void, openProposal: (id: string) => void, planeJobs: readonly PlaneBotAttention[] = []): ShortcutItem[] {
  const workers = planeBotTaskIds(planeJobs);
  const items: ShortcutItem[] = planeJobs.filter(planeBotNeedsAttention).map((job) => ({
    id: job.id, title: `${job.botName} · ${job.item.number}`, detail: `${planeBotStatus(job)} · ${job.item.title}`,
    pick: () => openTask(job.botTaskId, job.botSessionId ?? undefined),
  }));
  for (const task of state.tasks) {
    if (task.archivedAt || workers.has(task.id)) continue;
    const sessions = taskSessions(task, state.sessions);
    const status = taskStatus(sessions);
    const waiting = status && needsPerson(status) ? sessions.find(s => !s.archivedAt && s.status === status) : undefined;
    const decision = decisions.find(d => d.taskId === task.id);
    if (!waiting && !decision) continue;
    items.push({ id: task.id, title: task.title || "未命名任务", detail: waiting ? SESSION_LOOK[waiting.status].label : decision!.question,
      pick: () => openTask(task.id, waiting?.id ?? decision?.sessionId) });
  }
  for (const proposal of proposals) {
    items.push({ id: proposal.id, title: proposal.prompt, detail: "调度提案 · 等待批准", pick: () => openProposal(proposal.id) });
  }
  return items;
}

export function ShortcutMenu({ label, icon, items, empty, count, toolbar = false }: {
  label: string; icon: ReactNode; items(): ShortcutItem[]; empty: string; count?: number; toolbar?: boolean;
}) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const rows = open ? items() : [];
  const closeOnBlur = (event: FocusEvent) => {
    if (event.relatedTarget !== trigger.current && !panel.current?.contains(event.relatedTarget)) panel.current?.hidePopover();
  };
  return <>
    <button ref={trigger} type="button" className={toolbar ? "wb-bell" : "nav-row nav-shortcut"} popoverTarget={id} aria-label={label} onBlur={closeOnBlur}
      aria-expanded={open} aria-controls={id} title={toolbar ? label : undefined}>
      {icon}{!toolbar && <span className="name">{label}</span>}{count !== undefined && <span className="nav-count">{count}</span>}
    </button>
    <div id={id} ref={panel} className={toolbar ? "wb-shortcuts below" : "wb-shortcuts beside"} popover="auto"
      role="region" aria-label={label} onBlur={closeOnBlur} onToggle={e => setOpen(e.newState === "open")}>
      <h2>{label}</h2>
      {rows.length ? rows.map(row => <button type="button" key={row.id} onClick={() => { panel.current?.hidePopover(); row.pick(); }}>
        <strong>{row.title}</strong><small>{row.detail}</small>
      </button>) : <p>{empty}</p>}
    </div>
  </>;
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)");
const subscribeSystem = (notify: () => void) => {
  const media = systemDark();
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};
export function ThemeShortcut() {
  const pref = useThemePref();
  const darkSystem = useSyncExternalStore(subscribeSystem, () => systemDark().matches);
  return <button type="button" className="wb-theme" aria-pressed={pref === "dark" || (pref === "system" && darkSystem)}
    onClick={toggleTheme} title="切换深浅色主题">深色模式</button>;
}

export const BoardGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="M7 3v14m6-14v14"/></svg>;
export const RecentGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v10H8l-4 3v-3H3zM6 7h8m-8 3h5"/></svg>;
export const NeedsGlyph = () => <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5v5m0 3h.01"/></svg>;
export const BellGlyph = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16V10a6 6 0 0 1 12 0v6l2 2H4zM10 20h4"/></svg>;
