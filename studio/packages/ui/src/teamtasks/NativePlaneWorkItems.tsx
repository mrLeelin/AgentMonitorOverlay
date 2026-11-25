import { useLayoutEffect, useRef, useState } from "react";
import { PLANE_BOARD_API, PLANE_WORK_ITEM_DRAG, TASK_FIRST_MESSAGE_MAX, topicWorkspaceIds, type ModelProfile, type PlaneWorkItemDetail, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, type HostLink, type PlaneItemRef, type PlaneRegion, type PlaneTarget, type PlaneTheme } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { showToast } from "../lib/toast.js";
import { topicProject } from "../newtask/choices.js";
import { NewTaskPage } from "../newtask/NewTaskPage.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";

type CopyRequest = { item: PlaneItemRef; destination?: { kind: "workspace" | "topic"; id: string } };

// Keep the same drag and settings channel across visits to this connection.
let nativePlaneSession: { key: string; id: string } | undefined;
export function nativePlaneKey(target: PlaneTarget): string {
  return JSON.stringify([target.server, target.workspace, target.project, target.identity]);
}

export function discardNativePlaneView() {
  if (nativePlaneSession) window.amo?.teamPlane?.discard?.(nativePlaneSession.id);
}

export function NativePlaneWorkItems({ link, target, accountName, localProjects, localProject, topics, tasks, sessions, profiles, topicId, onOpen, onSettings }: {
  link: HostLink; target: PlaneTarget; accountName: string; localProjects: readonly Workspace[]; localProject: string; topicId?: string;
  topics: readonly Topic[]; tasks: readonly Task[]; sessions: readonly Session[]; profiles: readonly ModelProfile[];
  onOpen(id: string, sessionId?: string): void; onSettings(): void;
}) {
  const api = window.amo?.teamPlane;
  const region = useRef<HTMLDivElement>(null);
  const [id] = useState(() => {
    const key = nativePlaneKey(target);
    if (nativePlaneSession?.key !== key) nativePlaneSession = { key, id: crypto.randomUUID() };
    return nativePlaneSession.id;
  });
  const [attempt, retry] = useState(0);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState<PlaneTarget | null>(null);
  const [copying, setCopying] = useState<CopyRequest | null>(null);
  const blocked = useRef(false);
  const settings = useRef(onSettings);
  settings.current = onSettings;

  useLayoutEffect(() => {
    const node = region.current;
    if (!node || !api) return;
    let live = true;
    const bounds = () => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    // The native view draws above Studio's renderer. Yield to dialogs and menus that open over its region.
    const scheme = (): PlaneTheme => getComputedStyle(document.documentElement).colorScheme === "dark" ? "dark" : "light";
    const canShow = (frame: PlaneRegion) => {
      if (blocked.current) return false;
      const right = frame.x + frame.width, bottom = frame.y + frame.height;
      return !Array.from(document.querySelectorAll(".modal-backdrop, .ctx-menu, :popover-open")).some((overlay) => {
        const box = overlay.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && box.left < right && box.right > frame.x && box.top < bottom && box.bottom > frame.y;
      });
    };
    let visible: boolean | undefined;
    const position = (resize = false, appearanceChanged = false) => {
      const frame = bounds();
      const show = canShow(frame);
      if (resize || appearanceChanged || show !== visible) api.position(id, frame, show, scheme());
      visible = show;
    };
    const resize = () => position(true);
    const overlaysChanged = () => position();
    const overlays = new MutationObserver(overlaysChanged);
    overlays.observe(document.body, { childList: true, subtree: true });
    const syncAppearance = () => position(false, true);
    const appearance = new MutationObserver(syncAppearance);
    appearance.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    systemTheme.addEventListener("change", syncAppearance);
    document.addEventListener("toggle", overlaysChanged, true);
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    window.addEventListener("resize", resize);
    const offScale = window.amo?.uiScale?.onChange(resize);
    const fail = () => {
      if (!live) return;
      blocked.current = true;
      position();
      setError(true);
    };
    const offError = api.onError((reported) => { if (reported === id) fail(); });
    const offSettings = api.onSettings((reported) => {
      if (reported === id && !blocked.current) settings.current();
    });
    const openCopy = (request: CopyRequest) => {
      if (blocked.current) return;
      blocked.current = true;
      position();
      setCopying(request);
    };
    const offCopy = api.onCopy((reported, item) => {
      if (reported === id) openCopy({ item });
    });
    // The drag crosses from Plane's WebContents into the Studio renderer. Only the current view's card payload is accepted.
    let dropOver: HTMLElement | null = null;
    const highlight = (row: HTMLElement | null) => {
      if (row === dropOver) return;
      dropOver?.removeAttribute("data-plane-drag-over");
      dropOver = row;
      dropOver?.setAttribute("data-plane-drag-over", "");
    };
    const dropRow = (event: DragEvent) => !blocked.current && event.dataTransfer?.types.includes(PLANE_WORK_ITEM_DRAG) && event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-plane-drop][data-plane-drop-id]") : null;
    const dragOver = (event: DragEvent) => {
      const row = dropRow(event);
      highlight(row);
      if (!row || !event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const dragLeave = (event: DragEvent) => {
      if (dropOver && !(event.relatedTarget instanceof Node && dropOver.contains(event.relatedTarget))) highlight(null);
    };
    const drop = (event: DragEvent) => {
      const row = dropRow(event);
      highlight(null);
      if (!row || !event.dataTransfer) return;
      event.preventDefault();
      event.stopPropagation();
      const [view, item, extra] = event.dataTransfer.getData(PLANE_WORK_ITEM_DRAG).split(":");
      const { planeDrop: kind, planeDropId: selected } = row.dataset;
      if (view === id && !extra && item && /^[0-9a-f-]{36}$/i.test(item) && selected && (kind === "workspace" || kind === "topic")) {
        openCopy({ item: { id: item }, destination: { kind, id: selected } });
      }
    };
    document.addEventListener("dragover", dragOver, true);
    document.addEventListener("dragleave", dragLeave, true);
    document.addEventListener("drop", drop, true);
    const frame = bounds();
    void api.show(id, target, frame, scheme(), canShow(frame)).then((shown) => {
      if (!shown) fail();
      else if (live) setLoaded(target);
    }, fail);
    resize();
    return () => {
      live = false;
      api.hide(id);
      overlays.disconnect();
      appearance.disconnect();
      systemTheme.removeEventListener("change", syncAppearance);
      document.removeEventListener("toggle", overlaysChanged, true);
      document.removeEventListener("dragover", dragOver, true);
      document.removeEventListener("dragleave", dragLeave, true);
      document.removeEventListener("drop", drop, true);
      highlight(null);
      observer.disconnect();
      window.removeEventListener("resize", resize);
      offScale?.();
      offError(); offSettings(); offCopy();
    };
  }, [api, attempt, id, target]);

  const destination = copying?.destination;
  const selectedTopicId = destination?.kind === "topic" ? destination.id : destination ? undefined : topicId;
  const topic = topics.find((entry) => !entry.archivedAt && entry.id === selectedTopicId);
  const preferred = topic ? topicProject(topicWorkspaceIds(topic, tasks, localProjects)) : null;
  const initialProject = destination?.kind === "workspace" ? destination.id : preferred ?? (destination ? "" : localProject);
  return <div className="plane-native-region" ref={region}>
    <div className="plane-native-status">
      {error ? <>
        <p role="alert">Plane 页面未能打开。请检查连接后重试。</p>
      <div className="tb-row"><button className="btn-primary small" type="button" onClick={() => { api?.discard?.(id); blocked.current = false; setLoaded(null); setError(false); retry((value) => value + 1); }}>重试</button>
        <button className="btn-ghost small" type="button" onClick={onSettings}>团队连接设置</button></div>
      </> : loaded !== target && <p role="status">正在打开 Plane …</p>}
    </div>
    {copying && <CopyPlaneWorkItem link={link} target={target} accountName={accountName} item={copying.item} projects={localProjects}
      projectId={initialProject || (localProjects.length === 1 ? localProjects[0]!.id : null)}
      topicId={selectedTopicId} topics={topics} tasks={tasks} sessions={sessions} profiles={profiles}
      onOpen={(taskId, sessionId) => { api?.discard?.(id); onOpen(taskId, sessionId); }} onClose={() => {
        blocked.current = false;
        setCopying(null);
      }} />}
  </div>;
}

function CopyPlaneWorkItem({ link, target, accountName, item, projects, projectId, topicId, topics, tasks, sessions, profiles, onOpen, onClose }: {
  link: HostLink; target: PlaneTarget; accountName: string; item: PlaneItemRef; projects: readonly Workspace[]; projectId: string | null;
  topicId?: string; topics: readonly Topic[]; tasks: readonly Task[]; sessions: readonly Session[]; profiles: readonly ModelProfile[];
  onOpen(id: string, sessionId?: string): void; onClose(): void;
}) {
  const [requestId] = useState(() => crypto.randomUUID());
  const [detail, setDetail] = useState<{ task: PlaneWorkItemDetail; source: string } | null>(null);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    let live = true;
    const source = `${target.server}${PLANE_BOARD_API}/workspaces/${target.workspace}/projects/${target.project}`;
    const reference = "id" in item ? Promise.resolve({ id: item.id, source }) : call(link, "POST /api/team-board/plane/resolve-item", {}, { url: item.url });
    const request = reference.then(async ({ id, source }) => ({ source, task: await call(link, "GET /api/team-board/plane/work-items/:id", { id }) }));
    void request.then((value) => { if (live) setDetail(value); }, (err) => { if (live) setError(teamBoardMessage(err)); });
    return () => { live = false; };
  }, [link, target, item]);

  const label = "创建个人任务";
  if (!detail) return <Modal portal label={label} className="team-return-modal" onClose={onClose}>
    <h2 className="modal-title">{label}</h2>
    {error ? <p className="team-return-error" role="alert">{error}</p> : <p role="status">正在读取工作项…</p>}
    <div className="settings-row end"><button type="button" className="btn-ghost small" onClick={onClose}>取消</button></div>
  </Modal>;
  const original = detail.task;
  return <NewTaskPage link={link} workspaces={projects} topics={topics} tasks={tasks} sessions={sessions} profiles={profiles}
    scope={{ kind: "all" }} onBack={onClose} onCreated={(task, session) => {
      onOpen(task.id, session?.id);
      showToast(`个人任务「${task.title}」已就绪`);
    }}
    dialog={{
      label,
      note: <>Plane {original.number} · {original.title}。创建后，{accountName} 会列为团队单的执行人。</>,
      initial: { title: original.title, projectId, topicId: topicId ?? null,
        text: [`处理团队工作项 ${original.number}`, original.url, original.description].filter(Boolean).join("\n\n").slice(0, TASK_FIRST_MESSAGE_MAX) },
      create: ({ workspaceId, topicId, title, lead, firstMessage, firstSession, worktree }) =>
        call(link, "POST /api/team-board/plane/work-items/:id/copy", { id: original.id }, {
          source: detail.source, workspaceId: workspaceId ?? null, topicId: topicId ?? undefined, viewerId: target.identity, requestId,
          draft: { title, lead, firstMessage, firstSession, worktree },
        }),
    }} />;
}
