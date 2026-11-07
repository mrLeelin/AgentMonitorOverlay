import type { Id, Task } from "./entities.js";

export interface TaskManagement {
  direct: Task[];
  descendants: Task[];
  directLeadCount: number;
  workerCount: number;
}

/** Topics may span projects; tasks outside a topic share management only within their own project. */
export function sameManagementScope(a: Task, b: Task): boolean {
  return a.topicId === b.topicId && (!!a.topicId || a.workspaceId === b.workspaceId);
}

const live = (task: Task) => !task.archivedAt && !task.remote;

/** An invalid, missing, archived, remote or cyclic parent chain cannot confer authority. */
function managers(task: Task, byId: ReadonlyMap<Id, Task>): Id[] | null {
  if (!live(task)) return null;
  const seen = new Set<Id>([task.id]);
  const chain: Id[] = [];
  let current = task;
  while (current.managerTaskId) {
    const parent = byId.get(current.managerTaskId);
    if (!parent || !parent.lead || !live(parent) || !sameManagementScope(current, parent) || seen.has(parent.id)) return null;
    seen.add(parent.id);
    chain.push(parent.id);
    current = parent;
  }
  return chain;
}

/** Strict descendant check: a task never manages itself. No canvas position, label or collaboration is consulted. */
export function isManagedBy(tasks: readonly Task[], taskId: Id, managerId: Id): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const task = byId.get(taskId);
  return !!task && !!managers(task, byId)?.includes(managerId);
}

/** Unique live descendants in stable input order; malformed legacy chains remain readable but grant no authority. */
export function taskManagement(tasks: readonly Task[], managerId: Id): TaskManagement {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const manager = byId.get(managerId);
  const descendants = !manager?.lead || managers(manager, byId) === null ? [] : [...byId.values()].filter((task) => managers(task, byId)?.includes(managerId));
  const direct = descendants.filter((task) => task.managerTaskId === managerId);
  return { direct, descendants, directLeadCount: direct.filter((task) => task.lead).length, workerCount: descendants.filter((task) => !task.lead).length };
}
