import type { CanvasDoc, Id, Task } from "./entities.js";

type Relation = { id: Id; from: Id; to: Id; kind: "link" | "dependency"; source: "link" | "edge" };
export interface CanvasRelationIssue {
  kind: Relation["kind"];
  code: "duplicate" | "self" | "cycle";
  source: Relation["source"];
  ids: Id[];
  path: Id[];
}

export class CanvasRelationError extends Error {
  constructor(doc: CanvasDoc, readonly issue: CanvasRelationIssue) { super(canvasRelationMessage(doc, issue)); }
}

const relations = (doc: CanvasDoc): Relation[] => [
  ...(doc.links ?? []).map((l): Relation => ({ id: l.id, from: l.from, to: l.to, kind: "link", source: "link" })),
  ...doc.edges.map((e): Relation => ({ id: e.id, from: e.from, to: e.to, kind: "dependency", source: "edge" })),
];
const signature = (r: Relation) => JSON.stringify([r.kind, r.from, r.to]);

/** A shortest return path, scoped to one relation type. Existing unrelated cycles do not block new legal branches. */
function returnPath(edges: Relation[], start: Id, end: Id): { path: Id[]; ids: Id[] } | null {
  const next = new Map<Id, Relation[]>();
  for (const e of edges) { const list = next.get(e.from) ?? []; list.push(e); next.set(e.from, list); }
  const parents = new Map<Id, Relation | null>([[start, null]]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i]!;
    if (at === end) {
      const path = [end]; const ids: Id[] = [];
      let step = parents.get(end);
      while (step) { ids.unshift(step.id); path.unshift(step.from); step = parents.get(step.from); }
      return { path, ids };
    }
    for (const e of next.get(at) ?? []) if (!parents.has(e.to)) { parents.set(e.to, e); queue.push(e.to); }
  }
  return null;
}

/** All locatable defects. Never mutates or discards old lines, including lines with different labels. */
export function canvasRelationIssues(doc: CanvasDoc): CanvasRelationIssue[] {
  const all = relations(doc);
  const issues: CanvasRelationIssue[] = [];
  for (const kind of ["link", "dependency"] as const) {
    const list = all.filter((r) => r.kind === kind);
    const pairs = new Map<string, Relation>();
    const cycles = new Set<string>();
    for (const r of list) {
      const base = { kind, source: r.source };
      if (r.from === r.to) { issues.push({ ...base, code: "self", ids: [r.id], path: [r.from, r.to] }); continue; }
      const key = signature(r); const first = pairs.get(key);
      if (first) issues.push({ ...base, code: "duplicate", ids: [first.id, r.id], path: [r.from, r.to] });
      else pairs.set(key, r);
      const back = returnPath(list.filter((e) => e !== r), r.to, r.from);
      if (!back) continue;
      const ids = [r.id, ...back.ids];
      const cycleKey = JSON.stringify([...ids].sort());
      if (cycles.has(cycleKey)) continue;
      cycles.add(cycleKey);
      issues.push({ ...base, code: "cycle", ids, path: [r.from, ...back.path] });
    }
  }
  return issues;
}

/** Grandfather only unchanged relations. Deletion, movement, side and label edits remain possible on dirty boards. */
export function newCanvasRelationIssues(doc: CanvasDoc, previous?: CanvasDoc): CanvasRelationIssue[] {
  const issues = canvasRelationIssues(doc);
  if (!previous) return issues;
  const old = new Map(relations(previous).map((r) => [`${r.source}:${r.id}`, signature(r)]));
  const next = new Map(relations(doc).map((r) => [`${r.source}:${r.id}`, signature(r)]));
  return issues.filter((issue) => issue.ids.some((id) => old.get(`${issue.source}:${id}`) !== next.get(`${issue.source}:${id}`)));
}

export function canvasRelationMessage(doc: CanvasDoc, issue: CanvasRelationIssue, tasks: readonly Pick<Task, "id" | "title">[] = []): string {
  const names = new Map(tasks.map((t) => [t.id, t.title]));
  for (const n of doc.nodes) names.set(n.id, n.kind === "task" || n.kind === "ref" ? names.get(n.taskId) ?? n.taskId : n.kind === "item" ? `#${n.num} ${n.title}` : n.kind === "note" && typeof n.text === "string" ? n.text.slice(0, 32) || n.id : n.id);
  const title = issue.kind === "link" ? "普通线" : "依赖";
  const path = issue.path.map((id) => names.get(id) ?? id).join(" → ");
  return `${title}${issue.code === "duplicate" ? "已存在" : issue.code === "self" ? "不能连接自身" : "会形成循环"}：${path}（连线 ${issue.ids.join("、")}）`;
}

/** English diagnostics retained for callers of validateCanvas; UI and Host use the concrete Chinese message. */
export function canvasRelationDiagnostic(issue: CanvasRelationIssue): string {
  const kind = issue.kind === "dependency" ? "dependency" : issue.kind;
  if (issue.code === "duplicate") return `duplicate ${kind} ${issue.ids.join(" / ")}: ${issue.path.join(" → ")}`;
  if (issue.code === "self") return `${kind} ${issue.ids[0]} connects to itself`;
  return `${kind} cycle: ${issue.path.join(" → ")} (${issue.ids.join(" / ")})`;
}
