import { expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type CanvasItem, type CanvasNode, type Session, type Task } from "@amo-studio/protocol";
import { continuingThread, reviewRelationPath, reviewRelations } from "./review-relations.js";

const task = (id: string, lead = false): Task => ({ id, title: id, lead, managerTaskId: null, workspaceId: "ws", topicId: "topic", column: "todo", createdAt: "", updatedAt: "", archivedAt: null });
const session = (id: string, taskId: string, updatedAt = "2026-11-08"): Session => ({ id, taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: "ws", title: id, status: "idle", writer: "workbench", runtimeRef: null, options: {}, createdAt: "", updatedAt, archivedAt: null });
const item = (id: string, sessionId: string): CanvasItem => ({ id, num: 1, kind: "item", title: id, sessionId, status: "todo", groupId: "g", pos: { x: 400, y: 150 } });
const rect = (n: CanvasNode) => ({ ...n.pos, w: 240, h: 124 });
const canvas = (): CanvasDoc => ({ ...emptyCanvas(), groups: [{ id: "g", title: "审阅", workspaceId: null, rect: { x: 380, y: 100, w: 600, h: 400 } }], nodes: [item("one", "s1"), item("two", "s2")] });

it("connects each distinct source task to a group once, without inventing management or mutating the canvas", () => {
  const doc = canvas();
  const original = JSON.stringify(doc);
  const model = reviewRelations(doc, [session("s1", "t"), session("s2", "t")], [task("t")], null, rect);
  expect(model.lines).toHaveLength(1);
  expect(model.lines[0]?.label).toBe("整理出");
  expect(model.sources).toHaveLength(1);
  expect(model.sources[0]).toMatchObject({ taskId: "t", lead: false });
  expect(JSON.stringify(doc)).toBe(original);
  const mixed = reviewRelations(doc, [session("s1", "t"), session("s2", "other")], [task("t", true), task("other")], null, rect);
  expect(mixed.lines).toHaveLength(2);
  expect(mixed.sources.map((s) => s.lead)).toEqual([true, false]);
});

it("uses an existing task card and gracefully shows missing sources and ungrouped items", () => {
  const doc = canvas();
  doc.nodes.push({ id: "source", kind: "task", taskId: "t", groupId: null, pos: { x: 0, y: 0 } });
  const model = reviewRelations(doc, [session("s1", "t"), session("s2", "t")], [task("t")], null, rect);
  expect(model.sources).toHaveLength(0);
  expect(model.lines[0]?.from).toEqual(rect(doc.nodes[2]!));
  const missing = reviewRelations({ ...doc, nodes: [{ ...item("one", "gone"), groupId: null }] }, [], [], null, rect);
  expect(missing.sources[0]).toMatchObject({ missing: true, title: "来源会话已不在" });
  expect(missing.lines).toHaveLength(1);
});

it("expands only the requested item's discussions without covering manual cards or groups", () => {
  const doc = canvas();
  doc.nodes[0] = { ...item("one", "s1"), threads: ["thread", "gone", "thread"] };
  doc.nodes.push({ id: "blocker", kind: "note", text: "固定", groupId: null, pos: { x: 1020, y: 150 } });
  const sessions = [session("s1", "t"), session("s2", "t"), session("thread", "t")];
  expect(reviewRelations(doc, sessions, [task("t")], null, rect).discussions).toHaveLength(0);
  const model = reviewRelations(doc, sessions, [task("t")], "one", rect);
  expect(model.discussions).toHaveLength(2);
  expect(model.discussions[1]?.missing).toBe(true);
  for (const card of model.discussions) {
    for (const obstacle of [...doc.nodes.map(rect), ...doc.groups.map((g) => g.rect)]) expect(card.rect.x >= obstacle.x + obstacle.w || card.rect.x + card.rect.w <= obstacle.x || card.rect.y >= obstacle.y + obstacle.h || card.rect.y + card.rect.h <= obstacle.y).toBe(true);
  }
});

it("continues the latest live discussion, excluding archived, missing and source sessions", () => {
  const card = { ...item("one", "poster"), threads: ["older", "newer", "archived", "gone"] };
  const sessions = [session("poster", "t", "9"), session("older", "t", "1"), session("newer", "t", "2"), { ...session("archived", "t", "3"), archivedAt: "4" }];
  expect(continuingThread(card, sessions)?.id).toBe("newer");
  expect(continuingThread({ ...card, threads: ["archived", "gone"] }, sessions)).toBeUndefined();
});

it("routes a discussion around cards between its source and session", () => {
  const from = { x: 0, y: 100, w: 240, h: 124 };
  const blocker = { x: 280, y: 100, w: 240, h: 124 };
  const to = { x: 600, y: 100, w: 220, h: 76 };
  const path = reviewRelationPath({ id: "test", from, to, label: "讨论" }, [from, blocker, to]);
  expect(path.points[0]).toEqual({ x: 240, y: 162 });
  expect(path.points.at(-1)).toEqual({ x: 600, y: 138 });
  for (let i = 1; i < path.points.length; i++) {
    const a = path.points[i - 1]!; const b = path.points[i]!;
    expect(a.x === b.x || a.y === b.y).toBe(true);
    const crossing = a.x === b.x ? a.x > blocker.x && a.x < blocker.x + blocker.w && Math.max(a.y, b.y) > blocker.y && Math.min(a.y, b.y) < blocker.y + blocker.h : a.y > blocker.y && a.y < blocker.y + blocker.h && Math.max(a.x, b.x) > blocker.x && Math.min(a.x, b.x) < blocker.x + blocker.w;
    expect(crossing).toBe(false);
  }
});
