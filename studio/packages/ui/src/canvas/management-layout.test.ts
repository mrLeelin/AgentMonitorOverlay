import { expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type Task } from "@amo-studio/protocol";
import { arrangeManagement } from "./management-layout.js";

it("arranges hierarchy by level with real widths and leaves grouped contents and relations unchanged", () => {
  const task = (id: string, lead: boolean, managerTaskId: string | null = null): Task => ({ id, title: id, lead, managerTaskId, workspaceId: "ws", topicId: "topic", column: "todo", createdAt: "", updatedAt: "", archivedAt: null });
  const tasks = [task("root", true), task("child", true, "root"), task("worker", false, "child"), task("direct", false, "root"), task("grouped", false, "root")];
  const doc = { ...emptyCanvas(), nodes: tasks.map((t, i) => ({ id: t.id, kind: "task" as const, taskId: t.id, groupId: t.id === "grouped" ? "group" : null, pos: { x: i * 30, y: 400 - i * 40 } })), groups: [{ id: "group", title: "保留分组", workspaceId: null, rect: { x: 100, y: 100, w: 300, h: 300 } }] };
  const next = arrangeManagement(doc, tasks, (n) => ({ w: n.id === "child" ? 400 : 220, h: n.id === "child" ? 140 : 90 }));
  const node = (id: string) => next.nodes.find((n) => n.id === id)!;
  expect(node("root").pos.y).toBeLessThan(node("child").pos.y);
  expect(node("child").pos.y).toBe(node("direct").pos.y);
  expect(node("direct").pos.x).toBeGreaterThanOrEqual(node("child").pos.x + 400 + 60);
  expect(node("worker").pos.y).toBeGreaterThanOrEqual(node("child").pos.y + 140 + 100);
  expect(node("grouped")).toBe(doc.nodes[4]);
  expect(next.groups).toBe(doc.groups);
  expect(next.edges).toBe(doc.edges);
  expect(next.links).toBe(doc.links);
});

const task = (id: string, lead: boolean, managerTaskId: string | null = null): Task => ({ id, title: id, lead, managerTaskId, workspaceId: "ws", topicId: "topic", column: "todo", createdAt: "", updatedAt: "", archivedAt: null });
const canvas = (tasks: Task[]): CanvasDoc => ({ ...emptyCanvas(), nodes: tasks.map((t, i) => ({ id: t.id, kind: "task", taskId: t.id, groupId: null, pos: { x: i * 10, y: 0 } })) });

it("centres parents over unequal subtrees and never overlaps variable-size cards", () => {
  const tasks = [task("root", true), task("left", true, "root"), task("right", true, "root"), task("a", false, "left"), task("b", false, "left"), task("c", false, "right")];
  const size = (n: { id: string }) => ({ w: n.id === "a" ? 430 : n.id === "right" ? 350 : 220, h: n.id === "left" ? 240 : 90 });
  const next = arrangeManagement(canvas(tasks), tasks, size);
  const rect = (id: string) => { const n = next.nodes.find((n) => n.id === id)!; return { ...n.pos, ...size(n) }; };
  const cx = (id: string) => rect(id).x + rect(id).w / 2;
  expect(cx("left")).toBe((rect("a").x + rect("b").x + rect("b").w) / 2);
  expect(cx("right")).toBe(cx("c"));
  expect(cx("root")).toBe((rect("a").x + rect("right").x + rect("right").w) / 2);
  expect(rect("a").y).toBe(rect("c").y);
  expect(rect("a").y).toBeGreaterThanOrEqual(rect("left").y + 240 + 100);
  for (let i = 0; i < next.nodes.length; i++) for (const other of next.nodes.slice(i + 1)) {
    const a = rect(next.nodes[i]!.id); const b = rect(other.id);
    expect(a.x >= b.x + b.w || b.x >= a.x + a.w || a.y >= b.y + b.h || b.y >= a.y + a.h).toBe(true);
  }
});

it("limits layout to a requested tree and avoids fixed groups and cards", () => {
  const tasks = [task("root", true), task("child", false, "root"), task("other", false)];
  const doc = canvas(tasks);
  doc.nodes[2]!.pos = { x: 300, y: 0 };
  doc.groups = [{ id: "fixed", title: "保留分组", workspaceId: null, rect: { x: 0, y: 0, w: 250, h: 450 } }];
  const next = arrangeManagement(doc, tasks, () => ({ w: 220, h: 90 }), new Set(["root", "child"]));
  expect(next.nodes[2]).toBe(doc.nodes[2]);
  expect(next.groups).toBe(doc.groups);
  expect(next.nodes[0]!.pos.x).toBeGreaterThanOrEqual(544);
  expect(next.nodes[0]!.pos.x).toBe(next.nodes[1]!.pos.x);
});

it("tolerates incomplete and cyclic old management data without changing ownership", () => {
  const tasks = [task("a", true, "b"), task("b", true, "a"), task("c", false, "missing")];
  const original = canvas(tasks);
  const next = arrangeManagement(original, tasks, () => ({ w: 220, h: 90 }));
  expect(next.nodes).toHaveLength(3);
  expect(tasks.map((t) => t.managerTaskId)).toEqual(["b", "a", "missing"]);
  expect(next.edges).toBe(original.edges);
});

it("keeps movable children below fixed grouped or out-of-scope managers and preserves level alignment", () => {
  const tasks = [task("groupedRoot", true), task("fixedRoot", true), task("child", true, "groupedRoot"), task("sibling", false, "fixedRoot"), task("worker", false, "child")];
  const doc = canvas(tasks);
  doc.nodes[0] = { ...doc.nodes[0]!, groupId: "group", pos: { x: 0, y: 800 } };
  doc.nodes[1] = { ...doc.nodes[1]!, pos: { x: 600, y: 1100 } };
  doc.nodes[2]!.pos.y = 30;
  doc.groups = [{ id: "group", title: "固定主控", workspaceId: null, rect: { x: -20, y: 780, w: 300, h: 200 } }];
  const next = arrangeManagement(doc, tasks, () => ({ w: 220, h: 90 }), new Set(["child", "sibling", "worker"]));
  expect(next.nodes[0]).toBe(doc.nodes[0]);
  expect(next.nodes[1]).toBe(doc.nodes[1]);
  expect(next.groups).toBe(doc.groups);
  expect(next.nodes[2]!.pos.y).toBeGreaterThanOrEqual(1100 + 90 + 100);
  expect(next.nodes[2]!.pos.y).toBe(next.nodes[3]!.pos.y);
  expect(next.nodes[4]!.pos.y).toBeGreaterThanOrEqual(next.nodes[2]!.pos.y + 90 + 100);
});
