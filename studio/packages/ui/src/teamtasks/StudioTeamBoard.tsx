import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LinkedTeamBoardTicket, ModelProfile, PlaneBoardConnection, PlaneState, PlaneTaskReference, Session, Task, TeamBoardAction, TeamBoardSnapshot, TeamBoardSummary, TeamBoardTicket, TeamTaskFile, Topic, Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import type { ViewDef } from "../shell/views.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { BoardStatus, TeamBoardDetail, isTeamBoardActor, teamBoardMessage } from "./SharedTeamBoard.js";
import { PlaneTeamBoardPicker } from "./PlaneTeamBoardPicker.js";
import { PlaneWorkItems } from "./PlaneWorkItems.js";
import { discardNativePlaneView, NativePlaneWorkItems, nativePlaneKey } from "./NativePlaneWorkItems.js";
import { PublishPlaneTaskDialog } from "./PlaneTaskDialogs.js";
import { TeamBoardPreview } from "./TeamBoardPreview.js";
import { below, PopMenu, type Anchor } from "../task/TaskHead.js";
import "./teamtasks.css";

const empty: TeamBoardSnapshot = { name: null, tickets: [], notices: [] };

async function save(ticket: TeamBoardTicket, file: TeamTaskFile, taskId?: string) {
  if (!window.amo?.saveTeamTaskAttachment) throw new Error("请在 Studio 桌面客户端保存附件");
  await window.amo.saveTeamTaskAttachment(ticket.id, file.id, file.name, true, taskId);
}

function openOriginal(url: string | undefined, fail: (message: string) => void): (() => void) | undefined {
  if (!url || !window.amo?.openExternal) return undefined;
  return () => { void window.amo?.openExternal?.(url).catch((err) => fail(teamBoardMessage(err))); };
}

export const teamBoardView: ViewDef<"team"> = {
  kind: "team",
  render: (view, { link, scope, state, setView }) =>
    <StudioTeamBoard link={link} scope={scope} workspaces={state.workspaces} topics={state.topics} tasks={state.tasks}
      sessions={state.sessions} profiles={state.profiles} configure={!!view.configure} originalUrl={view.originalUrl}
      onConfigure={(configure) => setView({ ...view, configure })}
      onOpen={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId, created: true } : {}), back: { kind: "team" } })} />,
};

export function StudioTeamBoard({ link, scope, workspaces, topics, tasks, sessions, profiles, configure, originalUrl, onConfigure, onOpen }: {
  link: HostLink; scope: Scope; workspaces: readonly Workspace[]; topics: readonly Topic[]; tasks: readonly Task[];
  sessions: readonly Session[]; profiles: readonly ModelProfile[];
  configure: boolean; originalUrl?: string; onConfigure(open: boolean): void; onOpen(id: string, sessionId?: string): void;
}) {
  const [connection, setConnection] = useState<PlaneBoardConnection | null>(null);
  const [nativeSession, setNativeSession] = useState<{ key: string; valid: boolean } | null>(null);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const [snapshot, setSnapshot] = useState(empty);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<TeamBoardSummary | null>(null);
  const [project, setProject] = useState("");
  const [error, setError] = useState("");
  const [publishing, setPublishing] = useState<{ state?: PlaneState } | null>(null);
  const [publishVersion, setPublishVersion] = useState(0);
  const busy = useRef(false);
  const request = useRef(0);
  const connectionRequest = useRef(0);
  const options = workspaces.filter((entry) => !entry.archivedAt && !entry.builtin);
  const scopeProject = scope.kind === "workspace" ? options.find((entry) => entry.id === scope.id) : undefined;
  const topicId = scope.kind === "topic" ? scope.id : undefined;
  const localTarget = scopeProject ?? options.find((entry) => entry.id === project);
  const legacy = !!connection?.legacy;
  const activeProject = connection?.catalog?.workspaces.find((entry) => entry.slug === connection.selected?.workspace)
    ?.projects.find((entry) => entry.id === connection.selected?.project);
  const planeTarget = useMemo(() => connection?.server && connection.selected && connection.catalog
    ? { server: connection.server, ...connection.selected, identity: connection.catalog.identity.id, name: activeProject?.name, originalUrl } : null,
  [connection, activeProject?.name, originalUrl]);
  const checkSession = window.amo?.teamPlane?.checkSession;
  const nativeKey = planeTarget ? nativePlaneKey(planeTarget) : null;
  let originalProblem = "";
  if (originalUrl && connection && !configure && !connection.error) {
    if (!planeTarget) originalProblem = "请先连接这张原单所属的 Plane 服务器，并选择团队项目。";
    else if (URL.parse(originalUrl)?.origin !== URL.parse(planeTarget.server)?.origin) originalProblem = "请切换到这张原单所属的 Plane 服务器。";
  }
  const showBoard = !!planeTarget && !configure && !legacy && !choosingWorkspace && !originalProblem;
  const checkingSession = showBoard && !!checkSession && nativeSession?.key !== nativeKey;
  const claimable = snapshot.writable === false ? [] : snapshot.tickets.filter((ticket) =>
    ticket.status === "pending" || (ticket.status === "doing" && !ticket.localTaskId && isTeamBoardActor(ticket.assignee, ticket.assigneeId, snapshot)));

  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const next = await call(link, "GET /api/team-board");
      if (generation === request.current) { setSnapshot(next); setError(""); }
    } catch (err) { if (generation === request.current) setError(teamBoardMessage(err)); }
    finally { if (generation === request.current) setLoaded(true); }
  }, [link]);

  const applyConnection = useCallback((next: PlaneBoardConnection) => {
    if (!next.error && (!next.selected || !next.catalog || !next.server)) discardNativePlaneView();
    request.current++;
    setNativeSession(null);
    setChoosingWorkspace(false);
    setSelected(null); setSnapshot(empty);
    setLoaded(false); setError(""); setConnection(next);
  }, []);
  const loadConnection = useCallback(async () => {
    const generation = ++connectionRequest.current;
    try {
      const value = await call(link, "GET /api/team-board/plane");
      if (generation === connectionRequest.current) applyConnection(value);
    } catch (err) { if (generation === connectionRequest.current) setError(teamBoardMessage(err)); }
  }, [link, applyConnection]);

  useEffect(() => {
    void loadConnection();
    return () => { connectionRequest.current++; };
  }, [loadConnection]);

  useEffect(() => {
    if (!showBoard || !checkSession || !planeTarget || !nativeKey) return;
    let live = true;
    const report = (valid: boolean) => { if (live) setNativeSession({ key: nativeKey, valid }); };
    void checkSession(planeTarget).then(report, () => report(false));
    return () => { live = false; };
  }, [showBoard, checkSession, planeTarget, nativeKey]);

  useEffect(() => {
    if (!legacy || configure) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { clearInterval(timer); request.current++; };
  }, [legacy, configure, refresh]);

  async function importTicket(id: string) {
    const ticket = claimable.find((entry) => entry.id === id);
    if (!localTarget || !ticket || busy.current) return;
    busy.current = true;
    try {
      const result = await call(link, "POST /api/team-board/:id/import", { id }, { workspaceId: localTarget.id, revision: ticket.revision, source: snapshot.source, topicId });
      setSelected(null);
      if (result.existing) onOpen(result.task.id);
      else showToast(`已加入 ${localTarget.name} 的待办，团队原单进入「进行中」`);
    } finally { busy.current = false; void refresh(); }
  }

  if (checkingSession) return <section className="studio-team-native" id="studio-team-board" aria-label="Plane 团队任务"><div className="plane-native-status"><p role="status">正在打开 Plane …</p></div></section>;
  if (showBoard && nativeKey && nativeSession?.key === nativeKey && nativeSession.valid) return <section className="studio-team-native" id="studio-team-board" aria-label="Plane 团队任务">
    <NativePlaneWorkItems key={nativeKey} link={link} target={planeTarget} accountName={connection?.catalog?.identity.name ?? "当前 Plane 账号"}
      localProjects={options} localProject={scopeProject?.id ?? ""} topics={topics} tasks={tasks} sessions={sessions} profiles={profiles} topicId={topicId}
      onOpen={onOpen} onSettings={() => onConfigure(true)} onUnavailable={() => setNativeSession({ key: nativeKey, valid: false })} />
  </section>;

  const fallback = showBoard;
  const openInPlane = fallback ? openOriginal(originalUrl ?? `${planeTarget.server}/${planeTarget.workspace}/projects/${planeTarget.project}/issues/`, setError) : undefined;
  return <section className={`tb-panel studio-team-page${fallback ? " studio-team-fallback" : ""}`} id="studio-team-board" aria-labelledby="studio-team-board-title">
    <header className="tb-between tb-head">
      <h2 id="studio-team-board-title">{legacy && !configure ? "可领取任务" : fallback ? activeProject?.name ?? "团队看板" : "团队连接设置"}</h2>
      <div className="tb-row">
        {fallback && activeProject?.writable && <button type="button" className="tb-button tb-primary" onClick={() => setPublishing({})}>新建工作项</button>}
        {openInPlane && <button type="button" className="tb-button tb-quiet" onClick={openInPlane}>在 Plane 打开</button>}
        {configure && (planeTarget || legacy) && <button type="button" className="tb-button tb-primary" disabled={choosingWorkspace} onClick={() => onConfigure(false)}>返回工作项</button>}
        {!fallback && <button type="button" className="tb-button tb-quiet" onClick={() => void (legacy && !configure ? refresh() : loadConnection())}>刷新</button>}
        {!configure && (fallback || legacy) && (
          <button type="button" className="tb-button" aria-label="团队连接设置" title="团队连接设置" onClick={() => onConfigure(true)}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
              <path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z" />
              <circle cx="8" cy="8" r="2.2" />
            </svg>
          </button>
        )}
      </div>
    </header>
    {error && <p className="tb-error" role="alert">{error}</p>}
    {originalProblem && <p className="tb-error" role="alert">{originalProblem}</p>}
    {!connection && !error && <p className="tb-empty" role="status">正在读取团队任务连接…</p>}
    {connection && (!legacy || configure) && !fallback && <PlaneTeamBoardPicker link={link} connection={connection}
      onChange={(next) => { connectionRequest.current++; applyConnection(next); }} onDraft={setChoosingWorkspace} />}
    {fallback && <PlaneWorkItems key={nativeKey} link={link} target={localTarget} originalUrl={originalUrl}
      projects={scopeProject ? undefined : options} onProject={setProject} topicId={topicId} onNew={(state) => setPublishing({ state })}
      onLocalOpen={onOpen} publishVersion={publishVersion} />}
    {legacy && !configure && <>
      {!loaded && !error && <p className="tb-empty" role="status">正在读取任务…</p>}
      {loaded && !snapshot.name && !error && <p className="tb-empty">请先在 AMO 平台里登录，再点刷新。</p>}
      {snapshot.name && !claimable.length && !error && <p className="tb-empty">暂无可领取的任务</p>}
      {!!claimable.length && <ul className="tb-claim-list" aria-label="可领取任务">
        {claimable.map((ticket) => <li key={ticket.id}>
          <button type="button" className="tb-card" data-team-ticket={ticket.id} aria-haspopup="dialog" onClick={() => setSelected(ticket)}>
            <strong>{ticket.title}</strong><span>提出人 {ticket.creator} · {ticket.assignee ? `执行者 ${ticket.assignee}` : "未指派"}</span>
          </button>
        </li>)}
      </ul>}
      {selected && <TeamBoardPreview key={selected.id} link={link} summary={selected} target={localTarget} projects={scopeProject ? undefined : options} onProject={setProject}
        canClaim={claimable.some((ticket) => ticket.id === selected.id)} onFile={save} onClaim={() => importTicket(selected.id)} onClose={() => setSelected(null)} />}
    </>}
    {publishing && <PublishPlaneTaskDialog link={link} state={publishing.state} project={activeProject?.name}
      onClose={() => setPublishing(null)} onDone={() => setPublishVersion((value) => value + 1)} />}
  </section>;
}

export function LocalTeamBoardTask({ link, taskId, archived, onOpenPlaneOriginal, actions, onDescribe }: {
  link: HostLink; taskId: string; archived: boolean; onOpenPlaneOriginal?(url: string): void; actions?(openOriginal: ReactNode): ReactNode; onDescribe?(): void;
}) {
  const [data, setData] = useState<LinkedTeamBoardTicket | null>(null);
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<TeamBoardAction | null>(null);
  const [error, setError] = useState("");
  const [reference, setReference] = useState<PlaneTaskReference | null>();
  const [options, setOptions] = useState<Anchor | null>(null);
  useEffect(() => {
    let live = true;
    void call(link, "GET /api/team-board/local/:id/reference", { id: taskId }).then(
      (value) => { if (live) setReference(value); },
      () => { if (live) setReference(null); },
    );
    const load = () => call(link, "GET /api/team-board/local/:id", { id: taskId }).then(
      (value) => { if (live) setData(value); },
      (err) => { if (live && !(err instanceof HostApiError && err.status === 404)) setError(teamBoardMessage(err)); },
    );
    void load();
    const timer = open ? setInterval(() => void load(), 5000) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [link, taskId, open]);
  if (!reference && !data && !error && !actions) return null;
  const unlink = () => void call(link, "DELETE /api/team-board/local/:id/reference", { id: taskId }).then(
    () => { setReference(null); showToast("原单链接已移除。"); }, (err) => setError(teamBoardMessage(err)),
  );
  if (actions) return <section className="tb-panel tb-local plane-bot-task" aria-label="关联的团队原单">
    <div className="plane-bot-source">
      <h3>Plane 原单</h3>
      {!archived && (onDescribe || reference) && <button type="button" className="btn-ghost small plane-bot-options" aria-label="原单与任务说明" aria-haspopup="menu"
        aria-expanded={!!options} onClick={(event) => setOptions(options ? null : below(event.currentTarget))}>
        <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="13" cy="8" r="1.2"/></svg>
      </button>}
      {options && <PopMenu at={options} label="原单与任务说明" onClose={() => setOptions(null)}>
        {onDescribe && <button type="button" role="menuitem" onClick={() => { setOptions(null); onDescribe(); }}>任务说明…</button>}
        {reference && <button type="button" role="menuitem" onClick={() => { setOptions(null); unlink(); }}>移除 Plane 原单链接</button>}
      </PopMenu>}
    </div>
    {reference && <div className="plane-bot-reference">
      {reference.number && <strong>{reference.number}</strong>}
      <p>{reference.title}</p>
    </div>}
    {reference === null && <p className="side-note">Plane 原单链接不可用</p>}
    {actions(reference && <button type="button" className="btn-ghost small" title={reference.title} disabled={!onOpenPlaneOriginal}
      aria-label={reference.number ? `查看原单 ${reference.number}` : undefined} onClick={() => onOpenPlaneOriginal?.(reference.url)}>查看原单</button>)}
    {error && <p className="tb-error" role="alert">{error}</p>}
  </section>;
  return <section className="tb-panel tb-local" aria-label="关联的团队原单">
    <div className={reference ? "tb-row tb-source-row" : "tb-row"}>
      {reference && <>
        {reference.number && <strong className="tb-source-summary" title={reference.title}>{reference.number} · {reference.title}</strong>}
        {reference.creator && <span className="tb-source-avatar" role="img" aria-label={`提出人 ${reference.creator}`} title={`提出人 ${reference.creator}`}>
          <span aria-hidden="true">{Array.from(reference.creator.trim())[0]?.toUpperCase() ?? "?"}</span>
          {reference.creatorAvatarUrl && <img key={reference.creatorAvatarUrl} src={reference.creatorAvatarUrl} alt="" referrerPolicy="no-referrer"
            onError={(event) => { event.currentTarget.hidden = true; }} />}
        </span>}
        <button type="button" className="tb-button" disabled={!onOpenPlaneOriginal}
          onClick={() => onOpenPlaneOriginal?.(reference.url)}>打开 Plane 原单</button>
        {!archived && <button type="button" className="tb-button tb-quiet" onClick={unlink}>移除链接</button>}
      </>}
      {data && <><button type="button" className="tb-button" aria-expanded={open} onClick={() => setOpen(!open)}>团队原单</button><BoardStatus status={data.ticket.status} /></>}
    </div>
    {error && <p className="tb-error" role="alert">{error}</p>}
    {open && data && <TeamBoardDetail ticket={data.ticket} onOpenOriginal={openOriginal(data.ticket.webUrl, setError)} name={archived ? null : data.name} viewerId={data.viewerId} writable={data.writable} action={action} setAction={setAction} allowWithdraw={!!data.viewerId}
      onFile={(file) => void save(data.ticket, file, taskId).catch((err) => setError(teamBoardMessage(err)))} onChange={async (next) => {
      const ticket = await call(link, "POST /api/team-board/local/:id/change", { id: taskId }, next);
      setData({ ...data, ticket }); setAction(null);
      if (next.action === "deliver") showToast(`已通知提出人 ${ticket.creator} 验收`);
      if (next.action === "withdraw") showToast("已撤回交付，原单回到进行中。");
    }} />}
  </section>;
}
