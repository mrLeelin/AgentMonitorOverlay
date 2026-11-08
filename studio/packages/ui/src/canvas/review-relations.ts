import type { CanvasDoc, CanvasItem, CanvasNode, Rect, Session, Task } from "@amo-studio/protocol";
import { managementPath } from "./management-routing.js";

export function itemThreads(item: CanvasItem, sessions: readonly Session[]): Session[] {
  const ids = new Set(item.threads ?? []);
  return sessions.filter((s) => ids.has(s.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Continue the most recently used live discussion, never the session which posted the review. */
export function continuingThread(item: CanvasItem, sessions: readonly Session[]): Session | undefined {
  return itemThreads(item, sessions).find((s) => !s.archivedAt && s.taskId);
}

export interface ReviewRelationCard { id: string; rect: Rect; title: string; taskId?: string; sessionId?: string; lead?: boolean; session?: Session; missing?: boolean }
export interface ReviewRelationLine { id: string; from: Rect; to: Rect; label: "整理出" | "讨论" }
export interface ReviewRelations { sources: ReviewRelationCard[]; discussions: ReviewRelationCard[]; lines: ReviewRelationLine[]; obstacles: Rect[] }

/** Reuse obstacle routing with axes swapped: source right → destination left, without crossing other cards. */
export function reviewRelationPath(line: ReviewRelationLine, obstacles: readonly Rect[]) {
  const transpose = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w });
  const routed = managementPath(transpose(line.from), transpose(line.to), obstacles.map(transpose));
  const points = routed.points.map((p) => ({ x: p.y, y: p.x }));
  return { points, d: points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ") };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + 16 && a.x + a.w + 16 > b.x && a.y < b.y + b.h + 16 && a.y + a.h + 16 > b.y;

/** Derived view only: neither these connectors nor the small session cards are written into CanvasDoc. */
export function reviewRelations(doc: CanvasDoc, sessions: readonly Session[], tasks: readonly Task[], expanded: string | null, rectOf: (node: CanvasNode) => Rect): ReviewRelations {
  const result: ReviewRelations = { sources: [], discussions: [], lines: [], obstacles: [] };
  const bySession = new Map(sessions.map((s) => [s.id, s]));
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const byGroup = new Map(doc.groups.map((g) => [g.id, g]));
  const occupied = [...doc.nodes.map(rectOf), ...doc.groups.map((g) => g.rect)];
  const place = (x: number, y: number): Rect => {
    const rect = { x, y, w: 220, h: 76 };
    // Jump below each blocking rectangle; only derived cards move, even when a group is manually resized.
    for (;;) {
      const blockers = occupied.filter((r) => overlaps(rect, r));
      if (!blockers.length) break;
      rect.y = Math.max(...blockers.map((r) => r.y + r.h)) + 24;
    }
    occupied.push(rect);
    return rect;
  };
  const sources = new Map<string, Rect>();
  const seen = new Set<string>();
  for (const item of doc.nodes) {
    if (item.kind !== "item") continue;
    const group = item.groupId ? byGroup.get(item.groupId) : undefined;
    const target = group ? { ...group.rect, h: 30 } : rectOf(item);
    if (item.sessionId) {
      const session = bySession.get(item.sessionId);
      const task = session?.taskId ? byTask.get(session.taskId) : undefined;
      const sourceId = task ? `task:${task.id}` : `session:${item.sessionId}`;
      const relationId = `${sourceId}:${group?.id ?? item.id}`;
      if (!seen.has(relationId)) {
        seen.add(relationId);
        let source = sources.get(sourceId);
        if (!source) {
          const card = task && doc.nodes.find((n) => (n.kind === "task" || n.kind === "ref") && n.taskId === task.id);
          source = card ? rectOf(card) : place(target.x - 260, target.y);
          sources.set(sourceId, source);
          if (!card) result.sources.push({ id: sourceId, rect: source, title: task?.title || (session ? "来源会话不在任务中" : "来源会话已不在"), taskId: task?.id, sessionId: task ? session?.id : undefined, lead: task?.lead, missing: !task });
        }
        result.lines.push({ id: relationId, from: source, to: target, label: "整理出" });
      }
    }
    if (item.id === expanded) {
      const anchor = rectOf(item);
      for (const id of new Set(item.threads ?? [])) {
        const session = bySession.get(id);
        const task = session?.taskId ? byTask.get(session.taskId) : undefined;
        const rect = place(group ? group.rect.x + group.rect.w + 40 : anchor.x + anchor.w + 80, anchor.y);
        result.discussions.push({ id, rect, title: session?.title || (session ? "未命名讨论" : "讨论会话已不在"), taskId: task?.id, sessionId: session?.id, session, missing: !task });
        result.lines.push({ id: `discussion:${item.id}:${id}`, from: anchor, to: rect, label: "讨论" });
      }
    }
  }
  result.obstacles = [...doc.nodes.map(rectOf), ...result.sources.map((c) => c.rect), ...result.discussions.map((c) => c.rect)];
  return result;
}
