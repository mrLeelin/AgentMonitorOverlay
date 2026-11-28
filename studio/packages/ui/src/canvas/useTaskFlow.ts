import { useEffect, useMemo, useRef, useState } from "react";
import type { HostEvent, Id, Task, TaskWorkflowSummaryPage, TaskWorkflowSummaryRow } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

/** Resolve each task once so events for an entire branch can use the same root. */
export function workflowRoots(tasks: readonly Task[]): Map<Id, Id | null> {
  const local = new Map(tasks.filter((task) => !task.archivedAt && !task.remote).map((task) => [task.id, task]));
  const roots = new Map<Id, Id | null>();
  for (const task of local.values()) {
    const path = new Set<Id>();
    let current = task;
    let root: Id | null = null;
    while (!path.has(current.id)) {
      if (roots.has(current.id)) { root = roots.get(current.id)!; break; }
      path.add(current.id);
      if (!current.managerTaskId) { root = current.lead ? current.id : null; break; }
      const parent = local.get(current.managerTaskId);
      if (!parent?.lead || parent.topicId !== current.topicId || (!current.topicId && parent.workspaceId !== current.workspaceId)) break;
      current = parent;
    }
    for (const id of path) roots.set(id, root);
  }
  return roots;
}

export type WorkflowBranch = { rootId: Id; parentId: Id };
type PageSet = { pages: TaskWorkflowSummaryPage[]; loading: boolean; error?: string };
const EMPTY: PageSet = { pages: [], loading: true };
const pageKey = (root: Id, parent?: Id) => JSON.stringify([root, parent ?? null]);

export function useTaskFlow(link: HostLink, tasks: readonly Task[], branch: WorkflowBranch | null = null, rootFilter?: readonly Id[]) {
  const roots = useMemo(() => workflowRoots(tasks), [tasks]);
  const rootIds = [...new Set(rootFilter ?? [...roots.values()].filter((id): id is Id => !!id))].sort();
  const key = JSON.stringify(rootIds);
  const [cache, setCache] = useState(new Map<string, PageSet>());
  const current = useRef({ link, roots, branch, rootIds });
  current.current = { link, roots, branch, rootIds };
  const actions = useRef({ refresh: (_root: Id) => {}, more: () => {}, sync: () => {} });
  const openBranch = branch && branch.parentId !== branch.rootId ? branch : null;
  const branchKey = openBranch && pageKey(openBranch.rootId, openBranch.parentId);

  useEffect(() => {
    const data = new Map<string, PageSet>();
    const versions = new Map<string, number>();
    const dirty = new Set<Id>();
    let previousRoots = current.current.roots;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const save = (id: string, page: PageSet) => {
      data.set(id, page);
      if (active) setCache(new Map(data));
    };
    const load = async (root: Id, parent?: Id, append = false) => {
      const id = pageKey(root, parent);
      const old = data.get(id);
      if (append && old?.loading) return;
      const version = (versions.get(id) ?? 0) + 1;
      versions.set(id, version);
      const isCurrent = () => active && versions.get(id) === version;
      const pages = append ? [...(old?.pages ?? [])] : [];
      let cursor = append ? pages.at(-1)?.nextCursor : undefined;
      if (append && !cursor) return;
      save(id, { pages: old?.pages ?? [], loading: true });
      try {
        const count = append ? pages.length + 1 : Math.max(old?.pages.length ?? 0, 1);
        for (let index = pages.length; index < count; index++) {
          const page = await call(current.current.link, "GET /api/tasks/:id/workflow/summary", { id: root }, undefined, {
            ...(parent ? { parentTaskId: parent } : {}), ...(cursor ? { cursor } : {}),
          });
          if (!isCurrent()) return;
          pages.push(page);
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        save(id, { pages, loading: false });
      } catch (err) {
        if (!isCurrent()) return;
        if (append && err instanceof HostApiError && err.details?.reason === "stale-workflow-page") {
          void load(root, parent);
          return;
        }
        save(id, { pages: old?.pages ?? [], loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    const open = () => {
      const next = current.current.branch;
      return next && next.rootId !== next.parentId ? next : null;
    };
    const refresh = (root: Id) => {
      void load(root);
      const selected = open();
      if (selected?.rootId === root) void load(root, selected.parentId);
      for (const id of data.keys()) {
        const [owner, parent] = JSON.parse(id) as [Id, Id | null];
        if (owner === root && parent && parent !== selected?.parentId) {
          data.delete(id);
          versions.set(id, (versions.get(id) ?? 0) + 1);
        }
      }
    };
    const schedule = (ids: Iterable<Id>) => {
      const visible = new Set(current.current.rootIds);
      let changed = false;
      for (const root of ids) {
        if (!visible.has(root) || dirty.has(root)) continue;
        dirty.add(root);
        for (const [id, page] of data) {
          if ((JSON.parse(id) as [Id, Id | null])[0] !== root || page.loading) continue;
          data.set(id, { ...page, loading: true });
          changed = true;
        }
      }
      if (changed) setCache(new Map(data));
      if (!dirty.size || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        for (const id of dirty) if (current.current.rootIds.includes(id)) refresh(id);
        dirty.clear();
      }, 75);
    };
    const changed = (event: HostEvent) => {
      const affected = new Set<Id>();
      const add = (id: Id | null | undefined) => {
        if (!id) return;
        const root = current.current.roots.get(id) ?? previousRoots.get(id);
        if (root) affected.add(root);
        const old = previousRoots.get(id);
        if (old) affected.add(old);
        if (current.current.rootIds.includes(id)) affected.add(id);
      };
      switch (event.type) {
        case "task.upserted": add(event.task.id); add(event.task.managerTaskId); break;
        case "bot-lead.changed": add(event.taskId); break;
        case "session.upserted": add(event.session.taskId); break;
        case "decision.upserted": add(event.decision.taskId); add(event.decision.routedToTaskId); break;
        case "canvas.updated":
          for (const edge of event.canvas.edges) { add(edge.from); add(edge.to); }
          break;
        case "data.purged": for (const id of event.taskIds) add(id); break;
      }
      previousRoots = current.current.roots;
      schedule(affected);
    };
    const sync = () => {
      const configured = new Set(current.current.rootIds);
      let changed = false;
      for (const id of data.keys()) {
        if (configured.has((JSON.parse(id) as [Id, Id | null])[0])) continue;
        data.delete(id);
        versions.set(id, (versions.get(id) ?? 0) + 1);
        changed = true;
      }
      if (changed) setCache(new Map(data));
      for (const root of configured) if (!data.has(pageKey(root))) void load(root);
      const selected = open();
      if (selected && configured.has(selected.rootId) && !data.has(pageKey(selected.rootId, selected.parentId))) void load(selected.rootId, selected.parentId);
    };
    actions.current = {
      refresh: (root) => schedule([root]),
      more: () => { const target = current.current.branch; if (target) void load(target.rootId, target.parentId === target.rootId ? undefined : target.parentId, true); },
      sync,
    };
    const offEvent = onHostEvent(changed);
    const offReconnect = onHostReconnect(() => schedule(current.current.rootIds));
    setCache(new Map());
    sync();
    return () => {
      active = false;
      clearTimeout(timer);
      offEvent();
      offReconnect();
    };
  }, [link.url, link.token]);

  useEffect(() => actions.current.sync(), [key, branchKey]);

  const homes = new Map(rootIds.flatMap((id) => {
    const page = cache.get(pageKey(id))?.pages[0];
    return page ? [[id, page] as const] : [];
  }));
  const rows = new Map<Id, TaskWorkflowSummaryRow>();
  const addRows = (set?: PageSet) => {
    for (const page of set?.pages ?? []) for (const row of page.tasks) rows.set(row.taskId, row);
  };
  for (const root of rootIds) addRows(cache.get(pageKey(root)));
  const selected = branch ? cache.get(pageKey(branch.rootId, openBranch?.parentId)) ?? EMPTY : null;
  for (const [id, pages] of cache) {
    const [root, parent] = JSON.parse(id) as [Id, Id | null];
    if (parent && rootIds.includes(root)) addRows(pages);
  }
  if (openBranch) addRows(selected ?? undefined);
  return {
    roots, homes, rows, selected,
    results: new Map([...rows].flatMap(([id, row]) => row.latestResult ? [[id, row.latestResult] as const] : [])),
    loading: rootIds.some((id) => (cache.get(pageKey(id)) ?? EMPTY).loading),
    unavailable: rootIds.some((id) => !!cache.get(pageKey(id))?.error),
    refresh: (id: Id) => actions.current.refresh(id),
    more: () => actions.current.more(),
  };
}
