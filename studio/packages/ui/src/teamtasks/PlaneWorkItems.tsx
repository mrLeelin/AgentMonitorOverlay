import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { PlaneProjectBoard, PlaneState, PlaneWorkItem, PlaneWorkItemChange, Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { BOARD_DRAG, teamBoardMessage } from "./SharedTeamBoard.js";
import { PlaneWorkItemDialog } from "./PlaneWorkItemDialog.js";
import { PLANE_PRIORITIES, PlaneWorkItemLayouts, planeAssignees, planeStateName, type WorkItemLayout } from "./PlaneWorkItemLayouts.js";
import "./plane-work-items.css";

export function PlaneWorkItems({ link, target, projects, topicId, onNew, onLocalOpen, onProject, publishVersion }: {
  link: HostLink;
  target?: Workspace;
  projects?: readonly Workspace[];
  topicId?: string;
  onNew(state: PlaneState): void;
  onLocalOpen(id: string): void;
  onProject(id: string): void;
  publishVersion: number;
}) {
  const [board, setBoard] = useState<PlaneProjectBoard | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [assignee, setAssignee] = useState("");
  const [layout, setLayout] = useState<WorkItemLayout>("board");
  const [stateFilter, setStateFilter] = useState("");
  const [priority, setPriority] = useState("");
  const [display, setDisplay] = useState({ assignees: true, labels: true, priority: true, dates: false });
  const [analysis, setAnalysis] = useState(false);
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<PlaneWorkItem | null>(null);
  const [dragging, setDragging] = useState<PlaneWorkItem | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const request = useRef(0);
  const writing = useRef(false);
  const copying = useRef(false);
  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const next = await call(link, "GET /api/team-board/plane/work-items");
      if (generation === request.current) { setBoard(next); setError(""); }
    } catch (err) { if (generation === request.current) setError(teamBoardMessage(err)); }
  }, [link]);

  useEffect(() => {
    void refresh();
    const sync = () => { if (!writing.current) void refresh(); };
    const timer = setInterval(sync, 5000);
    window.addEventListener("focus", sync);
    return () => { request.current++; clearInterval(timer); window.removeEventListener("focus", sync); };
  }, [refresh, publishVersion]);

  const source = board?.source;
  const viewerId = board?.viewerId;
  const copy = useCallback(async (id: string) => {
    if (copying.current || !source || !viewerId || !target) return;
    copying.current = true;
    try {
      const result = await call(link, "POST /api/team-board/plane/work-items/:id/copy", { id }, { source, workspaceId: target.id, viewerId, topicId });
      await refresh();
      if (result.existing) { setSelected(null); onLocalOpen(result.task.id); }
      else showToast(`个人任务已加入「${target.name}」的待办，团队单执行人已包含 ${result.assignee}`);
    } finally { copying.current = false; }
  }, [link, onLocalOpen, refresh, source, target, topicId, viewerId]);

  async function change(item: PlaneWorkItem, change: PlaneWorkItemChange) {
    if (writing.current) throw new Error("请等待上一次修改完成");
    writing.current = true;
    request.current++;
    try {
      const result = await call(link, "POST /api/team-board/plane/work-items/:id", { id: item.id }, change);
      // Refresh the ordering as well as the edited card.
      await refresh();
      return result.item;
    } catch (err) {
      await refresh();
      throw err;
    } finally { writing.current = false; }
  }

  async function move(event: DragEvent, stateId: string, beforeId: string | null) {
    if (!dragging || !board?.writable || !event.dataTransfer.types.includes(BOARD_DRAG)) return;
    event.preventDefault();
    event.stopPropagation();
    const item = dragging;
    setDragging(null); setOver(null);
    if (item.id === beforeId || (item.stateId === stateId && (search || assignee || priority || stateFilter)) || writing.current) return;
    setMoving(true);
    try { await change(item, { source: board.source, revision: item.revision, action: "edit", fields: { stateId, beforeId } }); }
    catch (err) { setError(teamBoardMessage(err)); }
    finally { setMoving(false); }
  }

  function dragOver(event: DragEvent, key: string) {
    if (!dragging || !board?.writable || !event.dataTransfer.types.includes(BOARD_DRAG)) return;
    event.stopPropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setOver(key);
  }

  if (!board) return <div className="plane-board-status" role={error ? "alert" : "status"}>
    {error || "正在读取 Plane 工作项…"}
    {error && <button type="button" className="tb-button" onClick={() => void refresh()}>重试</button>}
  </div>;

  const query = search.trim().toLowerCase();
  const visible = board.items.filter((item) => item.archived === archived &&
    (!query || `${item.number} ${item.title}`.toLowerCase().includes(query)) &&
    (!stateFilter || item.stateId === stateFilter) && (!priority || item.priority === priority) &&
    (!assignee || (assignee === "unassigned" ? !item.assigneeIds.length : item.assigneeIds.includes(assignee))));
  const knownStates = new Set(board.states.map((state) => state.id));
  const lanes = board.states.map((state) => ({ state, items: visible.filter((item) => item.stateId === state.id) }));
  const unassigned = visible.filter((item) => !item.stateId || !knownStates.has(item.stateId));
  const card = (item: PlaneWorkItem, reorder = false) => {
    const names = planeAssignees(board, item);
    const state = board.states.find((entry) => entry.id === item.stateId);
    const reorderable = reorder && state && !archived && !query && !assignee && !priority && !stateFilter;
    return <li key={item.id} className={over === item.id && dragging?.id !== item.id ? "plane-insert-before" : undefined}
      onDragOver={reorderable ? (event) => dragOver(event, item.id) : undefined}
      onDrop={reorderable ? (event) => void move(event, state.id, item.id) : undefined}>
      <button type="button" className="plane-card" aria-haspopup="dialog" data-team-ticket={item.id}
        draggable={!archived && !moving && (board.writable || !!target)}
        onClick={() => setSelected(item)}
        onDragStart={(event) => {
          setDragging(item);
          event.dataTransfer.effectAllowed = board.writable ? "copyMove" : "copy";
          event.dataTransfer.setData(BOARD_DRAG, item.id);
        }}
        onDragEnd={() => { setDragging(null); setOver(null); }}>
        <span className="plane-card-number">{item.number}</span>
        <strong>{item.title}</strong>
        <span className="plane-card-meta">
          {layout === "list" && <span>{state ? planeStateName(state.name) : "无状态"}</span>}
          {display.priority && item.priority !== "none" && <span className={`plane-priority ${item.priority}`}>{PLANE_PRIORITIES[item.priority]}</span>}
          {display.assignees && <span title={names}>{names}</span>}
          {display.dates && item.dueDate && <time dateTime={item.dueDate}>截止 {item.dueDate}</time>}
        </span>
        {display.labels && item.labelIds.length > 0 && <span className="plane-card-labels">{board.labels.filter((label) => item.labelIds.includes(label.id)).map((label) => <span key={label.id}>{label.name}</span>)}</span>}
      </button>
    </li>;
  };

  return <div className="plane-work-items">
    <div className="plane-board-tools">
      <input type="search" placeholder="搜索工作项" aria-label="搜索团队工作项" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="筛选执行者" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
        <option value="">全部执行者</option><option value="unassigned">未指派</option>
        {board.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
      <select aria-label="工作项布局" value={layout} onChange={(event) => setLayout(event.target.value as WorkItemLayout)}>
        <option value="board">看板</option><option value="list">列表</option><option value="calendar">日历</option><option value="table">表格</option><option value="timeline">甘特图</option>
      </select>
      <details className="plane-board-option"><summary className="tb-button">筛选{stateFilter || priority ? " ·" : ""}</summary>
        <div className="plane-options-menu">
          <label>状态<select value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
            <option value="">全部状态</option>{board.states.map((state) => <option key={state.id} value={state.id}>{planeStateName(state.name)}</option>)}
          </select></label>
          <label>优先级<select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="">全部优先级</option>{Object.entries(PLANE_PRIORITIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
      </details>
      <details className="plane-board-option"><summary className="tb-button">显示</summary><div className="plane-options-menu">
        {(["assignees", "labels", "priority", "dates"] as const).map((key) => <label key={key}><input type="checkbox" checked={display[key]} onChange={(event) => setDisplay({ ...display, [key]: event.target.checked })} />
          {{ assignees: "执行者", labels: "标签", priority: "优先级", dates: "截止日期" }[key]}
        </label>)}
      </div></details>
      <button type="button" className="tb-button tb-quiet" aria-pressed={analysis} onClick={() => setAnalysis(!analysis)}>分析</button>
      <button type="button" className="tb-button tb-quiet" aria-pressed={archived} onClick={() => setArchived(!archived)}>{archived ? "返回工作项" : `已归档 ${board.items.filter((item) => item.archived).length}`}</button>
      <button type="button" className="tb-button tb-quiet plane-refresh" aria-label="刷新团队看板" title="刷新团队看板" onClick={() => void refresh()}>
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.5 3v4h-4m3.8-.2A5.4 5.4 0 1 0 13.5 10"/></svg>
      </button>
    </div>
    {error && <p className="tb-error" role="alert">{error}</p>}
    {analysis && <dl className="plane-analysis" aria-label="按状态统计">
      <div><dt>当前工作项</dt><dd>{visible.length}</dd></div>
      {lanes.map(({ state, items }) => <div key={state.id}><dt>{planeStateName(state.name)}</dt><dd>{items.length}</dd></div>)}
      {!!unassigned.length && <div><dt>无状态</dt><dd>{unassigned.length}</dd></div>}
    </dl>}
    {archived || layout === "list"
      ? <ul className="plane-card-list plane-list" aria-label={archived ? "已归档工作项" : "团队工作项"}>
          {visible.length ? visible.map((item) => card(item)) : <li className="tb-empty">{archived ? "没有符合条件的已归档工作项" : "没有符合条件的工作项"}</li>}
        </ul>
      : layout !== "board" ? <PlaneWorkItemLayouts layout={layout} board={board} items={visible} onOpen={setSelected} />
      : <div className="plane-lanes" tabIndex={0} aria-label="Plane 状态列">
          {lanes.map(({ state, items }) => <section key={state.id} className={`plane-lane${over === state.id ? " plane-lane-over" : ""}`}
            aria-label={planeStateName(state.name)} onDragOver={(event) => dragOver(event, state.id)} onDrop={(event) => void move(event, state.id, null)}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setOver(null); }}>
            <header className="plane-lane-head"><span className="plane-state-dot" style={{ backgroundColor: state.color }} aria-hidden="true" />
              <h3 title={state.name}>{planeStateName(state.name)}</h3><span className="plane-count">{items.length}</span>
              {board.writable && <button type="button" className="tb-button tb-quiet" title="新建工作项" aria-label={`在${planeStateName(state.name)}新建工作项`} onClick={() => onNew(state)}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
              </button>}
            </header>
            <ul className="plane-card-list">{items.map((item) => card(item, true))}</ul>
          </section>)}
          {unassigned.length > 0 && <section className="plane-lane" aria-label="无状态"><header className="plane-lane-head"><h3>无状态</h3><span className="plane-count">{unassigned.length}</span></header>
            <ul className="plane-card-list">{unassigned.map((item) => card(item))}</ul>
          </section>}
          {!lanes.length && !unassigned.length && <p className="tb-empty">这个项目还没有工作项。</p>}
        </div>}
    {selected && <PlaneWorkItemDialog key={selected.id} link={link} item={selected} board={board} target={target} projects={projects} onProject={onProject}
      onCopy={async () => { await copy(selected.id); setSelected(null); }} onChange={change} onClose={() => setSelected(null)} />}
  </div>;
}
