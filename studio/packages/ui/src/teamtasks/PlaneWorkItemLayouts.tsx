import { useState } from "react";
import type { PlanePriority, PlaneProjectBoard, PlaneWorkItem } from "@amo-studio/protocol";

export const PLANE_PRIORITIES: Record<PlanePriority, string> = { none: "无优先级", urgent: "紧急", high: "高", medium: "中", low: "低" };
const STATE_NAMES: Record<string, string> = { backlog: "待规划", "in progress": "进行中", done: "完成", cancelled: "已取消", canceled: "已取消" };
export function planeStateName(name: string): string { return STATE_NAMES[name.toLowerCase()] ?? name; }
export function planeAssignees(board: PlaneProjectBoard, item: PlaneWorkItem): string {
  return item.assigneeIds.map((id) => board.members.find((member) => member.id === id)?.name ?? "项目成员").join("、") || "未指派";
}

export type WorkItemLayout = "board" | "list" | "table" | "calendar" | "timeline";
export function PlaneWorkItemLayouts({ layout, board, items, onOpen }: {
  layout: "table" | "calendar" | "timeline"; board: PlaneProjectBoard; items: PlaneWorkItem[]; onOpen(item: PlaneWorkItem): void;
}) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth());
  });
  const year = month.getFullYear(), monthIndex = month.getMonth();
  const days = new Date(year, monthIndex + 1, 0).getDate();
  const iso = (day: number) => `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const inMonth = (date: string | null) => date !== null && date >= iso(1) && date <= iso(days);
  const open = (item: PlaneWorkItem, label = item.title) => <button type="button" className="tb-button tb-quiet plane-view-item" title={`${item.number} · ${item.title}`} onClick={() => onOpen(item)}>{label}</button>;
  const stateNames = new Map(board.states.map((s) => [s.id, planeStateName(s.name)]));

  if (layout === "table") return <div className="plane-alt-scroll" tabIndex={0} aria-label="工作项表格"><table className="plane-table">
    <thead><tr><th scope="col">编号</th><th scope="col">标题</th><th scope="col">状态</th><th scope="col">执行者</th><th scope="col">优先级</th><th scope="col">截止日期</th></tr></thead>
    <tbody>{items.map((item) => <tr key={item.id}><td>{item.number}</td><td>{open(item)}</td>
      <td>{stateNames.get(item.stateId ?? "") ?? "无状态"}</td><td>{planeAssignees(board, item)}</td>
      <td>{PLANE_PRIORITIES[item.priority]}</td><td>{item.dueDate || "—"}</td></tr>)}
      {!items.length && <tr><td colSpan={6}>没有符合条件的工作项</td></tr>}
    </tbody>
  </table></div>;

  const byDay = Array.from({ length: days }, (_, index) => iso(index + 1));
  const scheduled = items.filter((item) => {
    const start = item.startDate || item.dueDate;
    const end = item.dueDate || item.startDate;
    return start && end && start <= iso(days) && end >= iso(1);
  });
  const noDates = items.filter((item) => !item.startDate && !item.dueDate);
  return <section className="plane-date-view" aria-label={layout === "calendar" ? "日历" : "甘特图"}>
    <div className="tb-between plane-month"><strong>{year} 年 {monthIndex + 1} 月</strong><div className="tb-row">
      <button type="button" className="tb-button" onClick={() => setMonth(new Date(year, monthIndex - 1))}>上月</button>
      <button type="button" className="tb-button" onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth())); }}>本月</button>
      <button type="button" className="tb-button" onClick={() => setMonth(new Date(year, monthIndex + 1))}>下月</button>
    </div></div>
    <div className="plane-alt-scroll" tabIndex={0} aria-label="日期视图">
      {layout === "calendar" ? <div className="plane-month-grid">
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => <b key={day}>周{day}</b>)}
        {byDay.map((date, index) => <div key={date} className="plane-calendar-day" style={index ? undefined : { gridColumnStart: (month.getDay() + 6) % 7 + 1 }}>
          <time dateTime={date}>{index + 1}</time>
          {scheduled.filter((item) => (item.dueDate || item.startDate) === date).map((item) => <div key={item.id}>{open(item)}</div>)}
        </div>)}
      </div> : <div className="plane-timeline" style={{ "--plane-days": days } as React.CSSProperties}>
        <div className="plane-timeline-days" aria-hidden="true">{byDay.map((date, index) => <span key={date}>{index + 1}</span>)}</div>
        {scheduled.map((item) => {
          const start = item.startDate || item.dueDate;
          const end = item.dueDate || item.startDate;
          return <div key={item.id} className="plane-timeline-row"><div className="plane-timeline-block"
            style={{ gridColumn: `${inMonth(start) ? Number(start!.slice(-2)) : 1} / ${inMonth(end) ? Number(end!.slice(-2)) + 1 : days + 1}` }}>{open(item)}</div></div>;
        })}
        {!scheduled.length && <p className="tb-empty">本月没有排期</p>}
      </div>}
    </div>
    {!!noDates.length && <details className="plane-check-list"><summary>未排期 {noDates.length}</summary>{noDates.map((item) => <div key={item.id}>{open(item)}</div>)}</details>}
  </section>;
}
