import { join } from "node:path";
import { newCanvasRelationIssues, canvasRelationMessage, canvasRelationDiagnostic } from "@amo-studio/protocol";
import type { CanvasDoc, CanvasNode, Id, Task } from "@amo-studio/protocol";
import { addDependency, addGroupAuto, CANVAS_COLORS, CanvasLayoutError, canvasOutline, emptyCanvas, isCanvasColor, pruneLinks, isCommon, ITEM_CARD, LAYOUT, placeTask, refsToCard, removeTask, unplaceTask, validateCanvas } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { managesTask } from "../../core/role.js";

const nodeExtent = (node: CanvasNode) => node.size ?? (node.kind === "item" ? ITEM_CARD : LAYOUT.card);

function layoutTarget(doc: CanvasDoc, target: string) {
  const group = doc.groups.find((g) => g.id === target);
  if (group) return { target, id: group.id, kind: "group", parent: null, pos: { x: group.rect.x, y: group.rect.y }, size: { w: group.rect.w, h: group.rect.h } };
  const node = doc.nodes.find((n) => n.id === target || ((n.kind === "task" || n.kind === "ref") && n.taskId === target) || (n.kind === "item" && `#${n.num}` === target));
  if (!node) throw new HostError("bad_request", `nothing on this canvas is ${target}`);
  return { target, id: node.id, kind: node.kind, parent: node.groupId, pos: node.pos, size: nodeExtent(node) };
}

/** Only layout changes: preserve all contents, and grow a moved card's group rather than change its membership. */
function applyLayout(doc: CanvasDoc, moves: ReadonlyMap<Id, { x: number; y: number; dx: number; dy: number }>, parent: Id | null): CanvasDoc {
  const nodes = doc.nodes.map((n) => {
    const move = moves.get(n.id);
    if (move) return { ...n, pos: { x: move.x, y: move.y } };
    const groupMove = n.groupId ? moves.get(n.groupId) : undefined;
    return groupMove ? { ...n, pos: { x: n.pos.x + groupMove.dx, y: n.pos.y + groupMove.dy } } : n;
  });
  const groups = doc.groups.map((g) => {
    const move = moves.get(g.id);
    if (move) return { ...g, rect: { ...g.rect, x: move.x, y: move.y } };
    if (g.id !== parent) return g;
    const members = nodes.filter((n) => n.groupId === g.id);
    const x = Math.min(g.rect.x, ...members.map((n) => n.pos.x - LAYOUT.pad));
    const y = Math.min(g.rect.y, ...members.map((n) => n.pos.y - LAYOUT.header - LAYOUT.pad));
    const right = Math.max(g.rect.x + g.rect.w, ...members.map((n) => n.pos.x + nodeExtent(n).w + LAYOUT.pad));
    const bottom = Math.max(g.rect.y + g.rect.h, ...members.map((n) => n.pos.y + nodeExtent(n).h + LAYOUT.pad));
    return { ...g, rect: { x, y, w: right - x, h: bottom - y } };
  });
  return { ...doc, groups, nodes };
}

/** Each topic's canvas, and the canvas changes agents ask for. */
export class CanvasFeature extends Feature {
  canvas(topicId: Id): CanvasDoc {
    this.requireTopic(topicId);
    return this.store.getCanvas(topicId) ?? emptyCanvas(topicId);
  }

  saveCanvas(topicId: Id, input: unknown, actorSessionId?: Id): CanvasDoc {
    let doc = input as CanvasDoc;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.groups) || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
      throw new HostError("bad_request", "canvas needs groups, nodes and edges arrays");
    }
    if (doc.links !== undefined && !Array.isArray(doc.links)) throw new HostError("bad_request", "links must be an array");
    if (this.requireTopic(topicId).archivedAt) throw new HostError("read_only", "the topic is archived");
    const current = this.canvas(topicId);
    if (doc.version !== current.version) {
      throw new HostError("conflict", `canvas changed elsewhere (version ${current.version}, yours ${String(doc.version)}); reload and retry`);
    }
    // Archived tasks keep their cards and dependencies (hidden while archived, back on restore), so they count too:
    // refusing them made every later save of that canvas fail (S11-A: an empty group that would not go away).
    const known = this.store.listTasks().filter((t) => t.topicId === topicId);
    // 连线 to a card that was just taken off go with it (the page need not remember to drop them).
    doc = pruneLinks(doc);
    const errors = validateCanvas(doc, new Set(known.map((t) => t.id)), current);
    if (errors.length) {
      const messages = new Map(newCanvasRelationIssues(doc, current).map((issue) => [canvasRelationDiagnostic(issue), canvasRelationMessage(doc, issue, known)]));
      throw new HostError("bad_request", errors.slice(0, 5).map((error) => messages.get(error) ?? error).join("; "));
    }
    this.checkManagementScope(topicId, current, doc, actorSessionId);
    const next: CanvasDoc = {
      id: topicId,
      version: current.version + 1,
      groups: doc.groups,
      nodes: doc.nodes,
      edges: doc.edges,
      links: doc.links ?? [],
      updatedAt: new Date().toISOString(),
    };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next, ...(actorSessionId ? { actorSessionId } : {}) });
    return next;
  }

  /** The topic's live tasks (the ones its canvas may show). */
  private topicTasks(topicId: Id): Task[] {
    return this.store.listTasks().filter((t) => t.topicId === topicId && !t.archivedAt);
  }

  /** A task leaving a topic takes its card and its dependencies off that topic's canvas. */
  leaveCanvas(topicId: Id, taskId: Id): void {
    const current = this.store.getCanvas(topicId);
    if (!current || !current.nodes.some((n) => n.kind === "task" && n.taskId === taskId)) return;
    const next: CanvasDoc = { ...removeTask(current, taskId), version: current.version + 1, updatedAt: new Date().toISOString() };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
  }

  /**
   * A task joining a topic: a reference card to it on that topic's canvas becomes its own card, in the same place (a
   * reference to one of the topic's own tasks is not allowed); further references to it there go.
   */
  joinCanvas(topicId: Id, taskId: Id): void {
    const current = this.store.getCanvas(topicId);
    if (!current || !current.nodes.some((n) => n.kind === "ref" && n.taskId === taskId)) return;
    const next: CanvasDoc = { ...refsToCard(current, taskId), version: current.version + 1, updatedAt: new Date().toISOString() };
    this.store.putCanvas(next);
    this.publish({ type: "canvas.updated", canvas: next });
  }

  canvasCreateGroup(topicId: Id, input: { title?: unknown; workspace?: unknown }, actorSessionId?: Id): { groupId: Id; title: string } {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title) throw new HostError("bad_request", "title is required");
    let workspaceId: Id | null = null;
    if (typeof input.workspace === "string" && input.workspace) {
      const ws = this.store.listWorkspaces().find((w) => !isCommon(w) && (w.id === input.workspace || w.name === input.workspace));
      if (!ws) throw new HostError("bad_request", `workspace ${input.workspace} not found`);
      workspaceId = ws.id;
    }
    const id = newId("g");
    this.mutateCanvas(topicId, (doc) => addGroupAuto(doc, { id, title, workspaceId }), actorSessionId);
    return { groupId: id, title };
  }

  canvasAddDependency(fromTaskId: unknown, toTaskId: unknown, actorSessionId?: Id): { from: Id; to: Id } {
    const from = this.requireTask(String(fromTaskId));
    const to = this.requireTask(String(toTaskId));
    if (!from.topicId || from.topicId !== to.topicId) throw new HostError("bad_request", "dependencies connect two tasks of the same topic");
    this.mutateCanvas(from.topicId, (doc) => addDependency(doc, from.id, to.id, newId("e")), actorSessionId);
    return { from: from.id, to: to.id };
  }

  /**
   * A colour mark on the canvas (2026-10-17): `target` is a group's or a note's id, or a task with a card (its own or a
   * reference) there; `color` one of CANVAS_COLORS, or "none" to take the mark off.
   */
  canvasSetColor(topicId: Id, input: { target?: unknown; color?: unknown }, actorSessionId?: Id): { target: Id; color: string } {
    const target = typeof input.target === "string" ? input.target.trim() : "";
    const color = input.color === "none" || input.color === null || input.color === "" ? null : input.color;
    if (!target) throw new HostError("bad_request", "target is required: a group or note id, or a task id");
    if (color !== null && !isCanvasColor(color)) throw new HostError("bad_request", `color must be one of ${CANVAS_COLORS.map((c) => c.id).join(", ")} or none`);
    const paint = <T extends { color?: unknown }>(o: T): T => {
      const { color: _old, ...rest } = o;
      return (color ? { ...rest, color } : rest) as T;
    };
    this.mutateCanvas(topicId, (doc) => {
      if (doc.groups.some((g) => g.id === target)) return { ...doc, groups: doc.groups.map((g) => (g.id === target ? paint(g) : g)) };
      const node = doc.nodes.find((n) => n.id === target || ((n.kind === "task" || n.kind === "ref") && n.taskId === target));
      if (!node) throw new HostError("bad_request", `nothing on this canvas is ${target}: give a group or note id, or a task with a card here`);
      return { ...doc, nodes: doc.nodes.map((n) => (n === node ? paint(n) : n)) };
    }, actorSessionId);
    return { target, color: color ?? "none" };
  }

  canvasPlaceTask(taskId: unknown, groupId: unknown, actorSessionId?: Id): { taskId: Id; groupId: Id | null } {
    const task = this.requireTask(String(taskId));
    if (!task.topicId) throw new HostError("bad_request", "the task is not in a topic, so it has no canvas");
    const group = typeof groupId === "string" && groupId ? groupId : null;
    this.mutateCanvas(task.topicId, (doc) => placeTask(doc, task.id, group, newId("n")), actorSessionId);
    return { taskId: task.id, groupId: group };
  }

  /** Reorder without changing membership: groups travel with their cards, and resized cards keep enough room. */
  canvasArrange(topicId: Id, input: { targets?: unknown; direction?: unknown }, actorSessionId?: Id) {
    if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > 200 || input.targets.some((t) => typeof t !== "string" || !t.trim())) throw new HostError("bad_request", "targets must contain between 1 and 200 card or group ids");
    const targets = input.targets.map((t: string) => t.trim());
    const direction = input.direction ?? "vertical";
    if (direction !== "vertical" && direction !== "horizontal") throw new HostError("bad_request", "direction must be vertical or horizontal");
    const arranged: Array<{ target: string; id: Id; kind: string; pos: { x: number; y: number }; size: { w: number; h: number } }> = [];
    const next = this.mutateCanvas(topicId, (doc) => {
      const chosen = targets.map((target) => layoutTarget(doc, target));
      const ids = new Set(chosen.map((c) => c.id));
      if (ids.size !== chosen.length) throw new HostError("bad_request", "targets contain the same card or group more than once");
      if (chosen.some((c) => c.parent && ids.has(c.parent))) throw new HostError("bad_request", "a group and one of its cards cannot be arranged together");
      if (chosen.some((c) => c.parent !== chosen[0]!.parent)) throw new HostError("bad_request", "arrange cards of the same group, or ungrouped cards and groups");
      let x = Math.min(...chosen.map((c) => c.pos.x));
      let y = Math.min(...chosen.map((c) => c.pos.y));
      const moves = new Map<Id, { x: number; y: number; dx: number; dy: number }>();
      for (const c of chosen) {
        moves.set(c.id, { x, y, dx: x - c.pos.x, dy: y - c.pos.y });
        arranged.push({ target: c.target, id: c.id, kind: c.kind, pos: { x, y }, size: { ...c.size } });
        if (direction === "horizontal") x += c.size.w + LAYOUT.gap;
        else y += c.size.h + LAYOUT.gap;
      }
      return applyLayout(doc, moves, chosen[0]!.parent);
    }, actorSessionId);
    return { version: next.version, direction, arranged };
  }

  canvasMove(topicId: Id, input: { target?: unknown; x?: unknown; y?: unknown }, actorSessionId?: Id) {
    if (typeof input.target !== "string" || !input.target.trim()) throw new HostError("bad_request", "target is required");
    if (typeof input.x !== "number" || !Number.isFinite(input.x) || typeof input.y !== "number" || !Number.isFinite(input.y)) throw new HostError("bad_request", "x and y must be finite numbers");
    const target = input.target.trim();
    const { x, y } = input;
    let id = "";
    const next = this.mutateCanvas(topicId, (doc) => {
      const chosen = layoutTarget(doc, target);
      id = chosen.id;
      return applyLayout(doc, new Map([[id, { x, y, dx: x - chosen.pos.x, dy: y - chosen.pos.y }]]), chosen.parent);
    }, actorSessionId);
    return { version: next.version, target, id, pos: { x, y } };
  }

  /**
   * Shows or hides a task's card on its topic's canvas ("显示在画布上"). Shown, a task not on the canvas yet goes below
   * everything ungrouped; hidden, only its card goes (it stays in the topic, with its dependencies).
   */
  setTaskOnCanvas(taskId: Id, input: { onCanvas?: unknown }): CanvasDoc {
    const task = this.requireTask(taskId);
    if (!task.topicId) throw new HostError("bad_request", "the task is not in a topic, so it has no canvas");
    if (typeof input.onCanvas !== "boolean") throw new HostError("bad_request", "onCanvas must be true or false");
    const placed = this.canvas(task.topicId).nodes.some((n) => n.kind === "task" && n.taskId === task.id);
    if (placed === input.onCanvas) return this.canvas(task.topicId);
    return this.mutateCanvas(task.topicId, (doc) => (input.onCanvas ? placeTask(doc, task.id, null, newId("n")) : unplaceTask(doc, task.id)));
  }

  /** Applies a change to the latest canvas and saves it (one synchronous read-modify-write, so no version race here). */
  mutateCanvas(topicId: Id, change: (doc: CanvasDoc) => CanvasDoc, actorSessionId?: Id): CanvasDoc {
    const current = this.canvas(topicId);
    let next: CanvasDoc;
    try {
      next = change(current);
    } catch (err) {
      if (err instanceof CanvasLayoutError) throw new HostError("bad_request", err.message);
      throw err;
    }
    return this.saveCanvas(topicId, { ...next, version: current.version }, actorSessionId);
  }

  /** Validate the complete prospective write before persisting: moving a group must not move another team's cards. */
  private checkManagementScope(topicId: Id, before: CanvasDoc, after: CanvasDoc, actorSessionId?: Id): void {
    if (!actorSessionId) return; // The local HTTP UI is the person's entry point.
    const session = this.store.getSession(actorSessionId);
    if (!session || session.archivedAt) throw new HostError("read_only", "调用会话不存在或已归档，不能修改画布。");
    const own = session.taskId ? this.store.getTask(session.taskId) : null;
    if (session.taskId && (!own || own.archivedAt || own.remote)) throw new HostError("read_only", "调用任务不存在、已归档或为远程副本，不能修改画布。");
    if ((session.topicId ?? own?.topicId) !== topicId) throw new HostError("read_only", "只能修改所在专题的画布。");
    if (!own?.lead) return; // Other roles retain the existing person-approved editing flow.
    const task = (id: Id) => {
      if (!managesTask(this.host, actorSessionId, id)) throw new HostError("read_only", `任务 ${id} 不在你的管理范围内；请由直属主控或用户调整画布。`);
    };
    const node = (n: CanvasNode | undefined) => {
      if (n && (n.kind === "task" || n.kind === "ref")) task(n.taskId);
    };
    const changed = <T extends { id: Id }>(old: readonly T[], next: readonly T[], check: (value: T) => void) => {
      const left = new Map(old.map((value) => [value.id, value]));
      const right = new Map(next.map((value) => [value.id, value]));
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        const a = left.get(id), b = right.get(id);
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (a) check(a);
        if (b) check(b);
      }
    };
    const groupMembers = (groupId: Id) => {
      for (const n of [...before.nodes, ...after.nodes]) if (n.groupId === groupId) node(n);
    };
    changed(before.nodes, after.nodes, (value) => {
      node(value);
      const oldGroup = before.nodes.find((n) => n.id === value.id)?.groupId;
      const newGroup = after.nodes.find((n) => n.id === value.id)?.groupId;
      if (oldGroup !== newGroup) {
        if (oldGroup) groupMembers(oldGroup);
        if (newGroup) groupMembers(newGroup);
      }
    });
    changed(before.groups, after.groups, (group) => {
      groupMembers(group.id);
    });
    changed(before.edges, after.edges, (edge) => { task(edge.from); task(edge.to); });
    changed(before.links ?? [], after.links ?? [], (link) => {
      for (const doc of [before, after]) {
        node(doc.nodes.find((n) => n.id === link.from));
        node(doc.nodes.find((n) => n.id === link.to));
      }
    });
  }

  /** Callouts live outside CanvasDoc, but obey the same task/group boundary as canvas edits. */
  checkTargetScope(topicId: Id, target: Id, actorSessionId?: Id): void {
    const doc = this.canvas(topicId);
    const group = doc.groups.find((g) => g.id === target);
    const targetNode = doc.nodes.find((n) => n.id === target || ((n.kind === "task" || n.kind === "ref") && n.taskId === target));
    const nodes = group ? doc.nodes.filter((n) => n.groupId === group.id) : targetNode ? [targetNode] : [];
    // A synthetic metadata change lets every canvas-backed write share the same validation path.
    this.checkManagementScope(topicId, { ...doc, nodes }, { ...doc, nodes: [] }, actorSessionId);
  }

  /** `reader`: the session asking (its own bubbles are marked). */
  canvasOutline(topicId: Id, reader: Id | null = null) {
    return canvasOutline(
      this.canvas(topicId),
      this.topicTasks(topicId),
      this.store.listWorkspaces(),
      this.store.listSessions(),
      { tasks: this.store.listTasks(), topics: this.store.listTopics() },
      this.store.listCallouts(topicId),
      reader,
    );
  }
}
