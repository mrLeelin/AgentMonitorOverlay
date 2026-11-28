import { sameManagementScope, type Id, type Task } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";

type Dependency = { from: Id; to: Id };
type WaitGraph = Map<Id, Set<Id>>;

function waits(tasks: readonly Task[], dependencies: readonly Dependency[]): WaitGraph {
  const live = new Map(tasks.filter((task) => !task.archivedAt && !task.remote).map((task) => [task.id, task]));
  const graph: WaitGraph = new Map();
  const add = (from: Id, to: Id) => {
    const next = graph.get(from) ?? new Set<Id>();
    next.add(to);
    graph.set(from, next);
  };
  for (const { from, to } of dependencies) if (live.has(from) && live.has(to)) add(from, to);
  for (const task of live.values()) {
    const manager = task.managerTaskId ? live.get(task.managerTaskId) : undefined;
    // A parent's completion requires its child's delivery. Both edge types point from the blocker to the waiter.
    if (manager?.lead && sameManagementScope(task, manager)) add(task.id, manager.id);
  }
  return graph;
}

function path(graph: WaitGraph, start: Id, end: Id): Id[] | null {
  const queue = [start];
  const previous = new Map<Id, Id | null>([[start, null]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!;
    if (current === end) {
      const found: Id[] = [];
      for (let id: Id | null = current; id !== null; id = previous.get(id)!) found.push(id);
      return found.reverse();
    }
    for (const next of graph.get(current) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  return null;
}

/** Refuse a new cyclic wait without making existing malformed data impossible to move or repair. */
export function checkWaitGraph(beforeTasks: readonly Task[], beforeDeps: readonly Dependency[], afterTasks: readonly Task[], afterDeps: readonly Dependency[]): void {
  const before = waits(beforeTasks, beforeDeps);
  const after = waits(afterTasks, afterDeps);
  for (const [from, next] of after) {
    for (const to of next) {
      if (before.get(from)?.has(to)) continue;
      const returnPath = path(after, to, from);
      if (!returnPath) continue;
      const titles = new Map(afterTasks.map((task) => [task.id, task.title]));
      const cycle = [from, ...returnPath].map((id) => `「${titles.get(id) || id}」(${id})`).join(" → ");
      throw new HostError("bad_request", `管理关系与前置依赖形成等待循环：${cycle}。请调整管理关系或依赖后重试。`);
    }
  }
}
