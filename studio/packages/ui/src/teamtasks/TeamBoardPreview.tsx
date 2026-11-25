import { useEffect, useId, useState } from "react";
import type { TeamBoardSummary, TeamBoardTicket, TeamTaskFile, Workspace } from "@amo-studio/protocol";
import { IconOpenWindow, IconX } from "../chat/icons.js";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { BoardStatus, TeamBoardHistory, teamBoardMessage } from "./SharedTeamBoard.js";

export function TeamBoardPreview({ link, summary, target, projects, onProject, canClaim, onFile, onClaim, onClose }: {
  link: HostLink;
  summary: TeamBoardSummary;
  target?: Workspace;
  projects?: readonly Workspace[];
  onProject(id: string): void;
  canClaim: boolean;
  onFile(ticket: TeamBoardTicket, file: TeamTaskFile): Promise<void>;
  onClaim(): Promise<void>;
  onClose(): void;
}) {
  const titleId = useId();
  const [ticket, setTicket] = useState<TeamBoardTicket | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    let live = true;
    void call(link, "GET /api/team-board/:id", { id: summary.id }).then(
      (value) => { if (live) setTicket(value); },
      (err) => { if (live) setLoadError(teamBoardMessage(err)); },
    );
    return () => { live = false; };
  }, [link, summary.id, attempt]);

  async function act(operation: () => Promise<void>) {
    setActionError("");
    try { await operation(); }
    catch (err) { setActionError(teamBoardMessage(err)); }
  }

  async function claim() {
    if (claiming || !canClaim || !target || !ticket) return;
    setClaiming(true);
    try { await act(onClaim); }
    finally { setClaiming(false); }
  }

  const visible = ticket ?? summary;
  const webUrl = ticket?.webUrl;
  const openWeb = window.amo?.openExternal;
  return <Modal portal labelledBy={titleId} className="tb-preview" backdropClassName="tb-preview-backdrop" busy={claiming} onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled)");
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (!first || (event.shiftKey ? active === first || !Array.from(controls).includes(active as HTMLElement) : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }}>
    <header className="tb-preview-head">
      <div className="tb-preview-title">
        <h2 id={titleId}>{visible.title}</h2>
        <BoardStatus status={visible.status} />
      </div>
      <button type="button" className="tb-button tb-preview-close" aria-label="关闭" title="关闭（Esc）" disabled={claiming} onClick={onClose}><IconX /></button>
      <dl className="tb-preview-people">
        <div><dt>提出人</dt><dd>{visible.creator}</dd></div>
        <div><dt>执行者</dt><dd>{visible.assignee ?? "未指派"}</dd></div>
      </dl>
    </header>
    <div className="tb-preview-body" aria-busy={!ticket && !loadError}>
      {loadError ? <div className="tb-preview-load"><p role="alert">{loadError}</p><button type="button" className="tb-button" onClick={() => { setLoadError(""); setAttempt((value) => value + 1); }}>重试</button></div>
        : !ticket ? <p className="tb-meta" role="status">正在读取原单…</p>
        : <>
          <section aria-label="任务说明"><h3>任务说明</h3><p className={ticket.description.trim() ? "tb-text" : "tb-meta"}>{ticket.description.trim() ? ticket.description : "暂无说明"}</p></section>
          {ticket.events.length > 0 && <TeamBoardHistory events={ticket.events} onFile={(file) => void act(() => onFile(ticket, file))} />}
        </>}
    </div>
    <footer className="tb-preview-foot">
      {actionError ? <p className="tb-error" role="alert">{actionError}</p> : !canClaim && <p className="tb-meta" role="status">这张任务已移出可领取列表。</p>}
      <div className="tb-preview-actions">
        {projects ? <label className="tb-preview-project">接单到本地项目<select value={target?.id ?? ""} onChange={(event) => onProject(event.target.value)} disabled={claiming || !canClaim}>
          <option value="">请选择项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select></label> : <div className="tb-preview-project"><span>接单到本地项目</span><strong>{target?.name}</strong></div>}
        <div className="tb-preview-buttons">
          {webUrl && openWeb && <button type="button" className="tb-button tb-preview-original" onClick={() => void act(() => openWeb(webUrl))}>在 Plane 打开原单 <IconOpenWindow /></button>}
          <button type="button" className="tb-button tb-primary" disabled={!target || !ticket || !canClaim || claiming} onClick={() => void claim()}>{claiming ? "正在领取…" : "加入本地待办"}</button>
        </div>
      </div>
    </footer>
  </Modal>;
}
