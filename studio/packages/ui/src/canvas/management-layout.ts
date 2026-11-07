import { sameManagementScope, type CanvasDoc, type CanvasNode, type Id, type Point, type Rect, type Task } from "@amo-studio/protocol";

const COLUMN_GAP = 60;
const ROW_GAP = 100;

/** Explicit layout only: grouped cards, notes and every relationship stay exactly as saved. */
export function arrangeManagement(doc: CanvasDoc, tasks: readonly Task[], sizeOf: (node: CanvasNode) => { w: number; h: number }, taskIds?: ReadonlySet<Id>): CanvasDoc {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cards = doc.nodes.filter((n): n is Extract<CanvasNode, { kind: "task" }> => n.kind === "task" && !n.groupId && !!byId.get(n.taskId) && !byId.get(n.taskId)?.archivedAt && (!taskIds || taskIds.has(n.taskId)));
  if (!cards.length) return doc;
  const cardByTask = new Map(cards.map((n) => [n.taskId, n]));
  const sizes = new Map(cards.map((n) => [n.id, sizeOf(n)]));
  const depths = new Map<Id, number>();
  for (const node of cards) {
    let task = byId.get(node.taskId);
    let depth = 0;
    const seen = new Set<Id>([node.taskId]);
    while (task?.managerTaskId) {
      const parent = byId.get(task.managerTaskId);
      if (!parent?.lead || parent.archivedAt || parent.remote || !sameManagementScope(task, parent) || seen.has(parent.id)) break;
      seen.add(parent.id);
      depth += 1;
      task = parent;
    }
    // Unassigned execution cards belong below the top-level leads without guessing an owner.
    if (!depth && !byId.get(node.taskId)?.lead) depth = 1;
    depths.set(node.id, depth);
  }
  const children = new Map<Id, typeof cards>();
  const roots: typeof cards = [];
  for (const node of cards) {
    const task = byId.get(node.taskId)!;
    const parent = cardByTask.get(task.managerTaskId ?? "");
    const manager = parent && byId.get(parent.taskId);
    // A malformed old hierarchy must never recurse forever or acquire an invented parent.
    if (parent && manager?.lead && !manager.remote && !manager.archivedAt && sameManagementScope(task, manager) && depths.get(parent.id)! < depths.get(node.id)!) {
      const list = children.get(parent.id) ?? [];
      list.push(node);
      children.set(parent.id, list);
    } else roots.push(node);
  }
  const order = (a: CanvasNode, b: CanvasNode) => a.pos.x - b.pos.x || a.id.localeCompare(b.id);
  roots.sort(order);
  for (const list of children.values()) list.sort(order);
  const widths = new Map<Id, number>();
  const measure = (node: typeof cards[number]): number => {
    const list = children.get(node.id) ?? [];
    const width = Math.max(sizes.get(node.id)!.w, list.reduce((sum, child) => sum + measure(child), 0) + Math.max(0, list.length - 1) * COLUMN_GAP);
    widths.set(node.id, width);
    return width;
  };
  roots.forEach(measure);
  const rowHeights = new Map<number, number>();
  for (const node of cards) rowHeights.set(depths.get(node.id)!, Math.max(rowHeights.get(depths.get(node.id)!) ?? 0, sizes.get(node.id)!.h));
  const rowY = new Map<number, number>();
  let y = Math.min(...cards.map((n) => n.pos.y));
  for (const [level, height] of [...rowHeights].sort(([a], [b]) => a - b)) { rowY.set(level, y); y += height + ROW_GAP; }
  const fixedManagers = new Map(doc.nodes.filter((n): n is Extract<CanvasNode, { kind: "task" }> => n.kind === "task" && !cardByTask.has(n.taskId)).map((n) => [n.taskId, n]));
  let down = 0;
  for (const node of cards) {
    let task = byId.get(node.taskId);
    const seen = new Set<Id>([node.taskId]);
    while (task?.managerTaskId) {
      const manager = byId.get(task.managerTaskId);
      if (!manager?.lead || manager.archivedAt || manager.remote || !sameManagementScope(task, manager) || seen.has(manager.id)) break;
      seen.add(manager.id);
      const fixed = fixedManagers.get(manager.id);
      if (fixed) down = Math.max(down, fixed.pos.y + sizeOf(fixed).h + ROW_GAP - rowY.get(depths.get(node.id)!)!);
      task = manager;
    }
  }
  // A grouped or unselected manager cannot move. Lower every row together rather than breaking alignment.
  if (down > 0) for (const [level, top] of rowY) rowY.set(level, top + down);
  const positions = new Map<Id, Point>();
  const place = (node: typeof cards[number], left: number) => {
    const width = widths.get(node.id)!;
    positions.set(node.id, { x: left + (width - sizes.get(node.id)!.w) / 2, y: rowY.get(depths.get(node.id)!)! });
    const list = children.get(node.id) ?? [];
    const childWidth = list.reduce((sum, child) => sum + widths.get(child.id)!, 0) + Math.max(0, list.length - 1) * COLUMN_GAP;
    let x = left + (width - childWidth) / 2;
    for (const child of list) { place(child, x); x += widths.get(child.id)! + COLUMN_GAP; }
  };
  let x = Math.min(...cards.map((n) => n.pos.x));
  for (const root of roots) { place(root, x); x += widths.get(root.id)! + COLUMN_GAP; }
  // Keep hand-arranged content fixed. Shift the forest as a unit so centring and level alignment survive.
  const fixed: Rect[] = [...doc.groups.map((g) => g.rect), ...doc.nodes.filter((n) => !positions.has(n.id)).map((n) => ({ ...n.pos, ...sizeOf(n) }))];
  let offset = 0;
  for (;;) {
    let next = offset;
    for (const node of cards) {
      const pos = positions.get(node.id)!;
      const size = sizes.get(node.id)!;
      for (const obstacle of fixed) {
        if (pos.y < obstacle.y + obstacle.h + 24 && pos.y + size.h + 24 > obstacle.y && pos.x + offset < obstacle.x + obstacle.w + 24 && pos.x + offset + size.w + 24 > obstacle.x) next = Math.max(next, obstacle.x + obstacle.w + 24 - pos.x);
      }
    }
    if (next === offset) break;
    offset = next;
  }
  return { ...doc, nodes: doc.nodes.map((node) => {
    const pos = positions.get(node.id);
    return pos ? { ...node, pos: { x: pos.x + offset, y: pos.y } } : node;
  }) };
}
