import { useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import type { TeamBoardAction, TeamBoardChange, TeamBoardSnapshot, TeamBoardSummary, TeamBoardTicket, TeamTaskFile, TeamTaskFileInput, TeamTaskPerson, TeamTaskStatus } from "@amo-studio/protocol";
import { readTeamTaskFiles, teamDate } from "./shared.js";
import "./team-board.css";

export const TEAM_BOARD_COLUMNS = { pending: "待定", doing: "进行中", review: "审查", done: "完成" } as const;
export const BOARD_DRAG = "application/x-amo-team-task";
const ACTION = { create: "提出任务", claim: "接单", release: "退回待定", deliver: "送审", accept: "确认完成", return: "验收退回", withdraw: "撤回交付", note: "评论" };

export const teamBoardMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");

export function isTeamBoardActor(displayName: string | null, actorId: string | null | undefined, identity: { name: string | null; viewerId?: string }): boolean {
  return identity.viewerId ? identity.viewerId === actorId : !!identity.name && identity.name === displayName;
}

function dropAction(ticket: TeamBoardSummary, identity: { name: string | null; viewerId?: string; writable?: boolean }, column: TeamTaskStatus): TeamBoardAction | null {
  if (identity.writable === false) return null;
  if (isTeamBoardActor(ticket.assignee, ticket.assigneeId, identity) && ticket.status === "doing" && column === "review") return "deliver";
  if (isTeamBoardActor(ticket.creator, ticket.creatorId, identity) && ticket.status === "review") {
    if (column === "pending") return "return";
    if (column === "done") return "accept";
  }
  return null;
}

export function BoardStatus({ status }: { status: TeamTaskStatus }) {
  return <span className={`tb-status tb-${status}`}>{TEAM_BOARD_COLUMNS[status]}</span>;
}

export function TeamBoardColumns({ snapshot, onOpen, onMove }: { snapshot: TeamBoardSnapshot; onOpen(id: string): void; onMove(ticket: TeamBoardSummary, action: TeamBoardAction): void }) {
  const dragging = useRef<string | null>(null);
  const [over, setOver] = useState<TeamTaskStatus | null>(null);
  function onDrag(event: DragEvent, column: TeamTaskStatus) {
    const ticket = snapshot.tickets.find(({ id }) => id === dragging.current);
    const action = ticket && dropAction(ticket, snapshot, column);
    if (!ticket || !action) return;
    event.preventDefault();
    if (event.type === "drop") { dragging.current = null; setOver(null); onMove(ticket, action); }
    else { event.dataTransfer.dropEffect = "move"; setOver(column); }
  }
  return <div className="tb-columns" aria-label="团队任务状态列">
    {(Object.entries(TEAM_BOARD_COLUMNS) as Array<[TeamTaskStatus, string]>).map(([column, label]) => {
      const tickets = snapshot.tickets.filter((ticket) => ticket.status === column);
      return <section key={column} data-team-column={column} aria-label={label} className={`tb-column tb-${column}${over === column ? " tb-over" : ""}`}
        onDragOver={(event) => onDrag(event, column)} onDrop={(event) => onDrag(event, column)}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => current === column ? null : current); }}>
        <div className="tb-column-head"><h3>{label}</h3><span>{tickets.length}</span></div>
        <div className="tb-cards">{tickets.map((ticket) => {
          const move = dropAction(ticket, snapshot, "review") || dropAction(ticket, snapshot, "done");
          return <button type="button" key={ticket.id} className="tb-card" data-team-ticket={ticket.id} draggable={!!move} onClick={() => onOpen(ticket.id)}
            onDragStart={(event) => { dragging.current = ticket.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", ticket.id); }}
            onDragEnd={() => { dragging.current = null; setOver(null); }}>
            <strong>{ticket.title}</strong><span>提出人 {ticket.creator}</span><span>执行者 {ticket.assignee ?? "未指派"}</span>
          </button>;
        })}{!tickets.length && <p className="tb-empty">暂无任务</p>}</div>
      </section>;
    })}
  </div>;
}

export function TeamBoardNotices({ snapshot, onOpen }: { snapshot: TeamBoardSnapshot; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false);
  const unread = snapshot.notices.filter((notice) => notice.unread).length;
  return <div className="tb-notice-wrap">
    <button className="tb-button" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>待审核{unread > 0 && <span className="tb-count">{unread}</span>}</button>
    {open && <section className="tb-notices" aria-label="待审核通知">
      {snapshot.notices.map((notice) => <button type="button" key={notice.ticketId} className="tb-card" onClick={() => { setOpen(false); onOpen(notice.ticketId); }}><strong>{notice.title}</strong><span>{notice.actor} 已送审{notice.unread && " · 新通知"}</span></button>)}
      {!snapshot.notices.length && <p className="tb-empty">暂无待审核任务</p>}
    </section>}
  </div>;
}

export function TeamBoardDetail({ ticket, name = null, viewerId, writable, allowFiles = true, allowWithdraw = false, action, setAction, onChange, onFile, onOpenOriginal, extra, onClose }: { ticket: TeamBoardTicket; name?: string | null; viewerId?: string; writable?: boolean; allowFiles?: boolean; allowWithdraw?: boolean; action?: TeamBoardAction | null; setAction?(action: TeamBoardAction | null): void; onChange?(change: TeamBoardChange): Promise<void>; onFile(file: TeamTaskFile): void; onOpenOriginal?(): void; extra?: ReactNode; onClose?(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || !onChange || busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const files = await readTeamTaskFiles(form.getAll("files").filter((item): item is File => item instanceof File && !!item.name));
      await onChange({ action, revision: ticket.revision, text: String(form.get("text") ?? "").trim(), files });
    } catch (err) { setError(teamBoardMessage(err)); }
    finally { setBusy(false); }
  }
  const identity = { name, viewerId, writable };
  const assigned = isTeamBoardActor(ticket.assignee, ticket.assigneeId, identity);
  function usable(next: TeamBoardAction) {
    if (!onChange || !setAction || !name || writable === false) return false;
    if (next === "note") return isTeamBoardActor(ticket.creator, ticket.creatorId, identity) || assigned;
    if (next === "withdraw") return allowWithdraw && assigned && ticket.status === "review";
    return dropAction(ticket, identity, next === "deliver" ? "review" : next === "accept" ? "done" : "pending") === next;
  }
  return <section className="tb-detail" aria-label="团队原单">
    <div className="tb-between"><h3>{ticket.title}</h3><div className="tb-row"><BoardStatus status={ticket.status} />{onClose && <button type="button" className="tb-button" onClick={onClose}>关闭</button>}</div></div>
    <p className="tb-meta">提出人 {ticket.creator} · 执行者 {ticket.assignee ?? "未指派"}</p>
    <p className="tb-text">{ticket.description}</p>
    <div className="tb-row">{extra}{onOpenOriginal && <button className="tb-button" type="button" onClick={onOpenOriginal}>在 Plane 打开原单</button>}{(["deliver", "accept", "return", "withdraw", "note"] as const).filter(usable).map((next) => <button className={`tb-button${next === "deliver" || next === "accept" ? " tb-primary" : ""}`} type="button" key={next} disabled={busy} onClick={() => { setError(""); setAction?.(next); }}>{ACTION[next]}</button>)}</div>
    {error && <p className="tb-error" role="alert">{error}</p>}
    {action && usable(action) && <form className="tb-form tb-divider" key={action} onSubmit={(event) => void submit(event)}>
      <label>{action === "deliver" ? "处理说明（选填）" : action === "note" ? "评论" : action === "withdraw" ? "撤回说明（选填）" : "验收评论（选填）"}<textarea name="text" maxLength={6000} /></label>
      {allowFiles && <label>附件（选填）<input name="files" type="file" multiple /></label>}
      <div className="tb-row"><button className="tb-button tb-primary" disabled={busy} type="submit">{ACTION[action]}</button><button className="tb-button" type="button" disabled={busy} onClick={() => setAction?.(null)}>取消</button></div>
    </form>}
    <TeamBoardHistory events={ticket.events} onFile={onFile} />
  </section>;
}

export function TeamBoardHistory({ events, onFile }: { events: TeamBoardTicket["events"]; onFile(file: TeamTaskFile): void }) {
  return <section className="tb-divider" aria-label="流转与评论"><h3>流转与评论</h3><ol className="tb-events">{[...events].reverse().map((entry) => <li key={entry.id}>
      <div className="tb-between"><strong>{ACTION[entry.action]}</strong><span className="tb-meta">{entry.actor} · {teamDate(entry.at)}</span></div>
      {entry.text && <p className="tb-text">{entry.text}</p>}
      {!!entry.files.length && <div className="tb-row">{entry.files.map((file) => <button className="tb-button" type="button" key={file.id} onClick={() => onFile(file)}>{file.name}</button>)}</div>}
    </li>)}</ol></section>;
}

export function TeamBoardForm({ people, onSubmit, onClose }: { people: TeamTaskPerson[]; onSubmit(input: { title: string; description: string; assignee: string; files: TeamTaskFileInput[] }): Promise<void>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError("");
    try {
      const files = await readTeamTaskFiles(data.getAll("files").filter((item): item is File => item instanceof File && !!item.name));
      await onSubmit({ title: String(data.get("title")).trim(), description: String(data.get("description")).trim(), assignee: String(data.get("assignee")), files });
    } catch (err) { setError(teamBoardMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="tb-form" onSubmit={(event) => void submit(event)}>
    <label>标题<input name="title" maxLength={120} required /></label>
    <label>执行者（选填）<select name="assignee"><option value="">暂不指定执行者</option>{people.map((person) => <option key={person.name} value={person.name}>{person.nick || person.name}</option>)}</select></label>
    <label>说明<textarea name="description" maxLength={4000} required /></label>
    <label>附件（选填）<input type="file" name="files" multiple /></label>
    {error && <p role="alert" className="tb-error">{error}</p>}
    <div className="tb-row"><button className="tb-button tb-primary" type="submit" disabled={busy}>提交到待定</button><button className="tb-button" type="button" disabled={busy} onClick={onClose}>取消</button></div>
  </form>;
}
