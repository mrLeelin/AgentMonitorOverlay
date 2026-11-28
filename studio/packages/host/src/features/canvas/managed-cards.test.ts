import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type CanvasNode, type ModelProfile, type Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { BotLeadStore } from "../../store/bot-leads.js";
import { Store } from "../../store/store.js";
import { bindLeadFixture } from "../botleads/lead.test-support.js";
import { canvasRoutes } from "./routes.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let dir: string, store: Store, servers: FakeServers, host: HostService, topicId: string, workspaceId: string;
let lead: Task, child: Task, unrelated: Task;

const current = () => host.canvases.canvas(topicId);
const card = (task: Task, x: number): CanvasNode => ({ kind: "task", id: `card-${task.id}`, taskId: task.id, groupId: null, pos: { x, y: 50 } });
const task = (title: string, lead = false, managerTaskId: string | null = null) => store.createTask({ title, lead, managerTaskId, topicId, workspaceId });
const edge = (id: string, from: Task, to: Task) => ({ id, kind: "depends" as const, from: from.id, to: to.id });
const sessionFor = (task: Task) => store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId, title: "原会话", status: "idle", writer: "workbench", runtimeRef: null });

function pauseWithAppointment(task: Task): void {
  const name = `机器人 ${task.title}`;
  const purpose = "安排分工并核对交付";
  const bot = host.bots.save({ name, purpose, memory: "", workspaceId, profileId: "test", enabled: true });
  const terms = new BotLeadStore(store);
  const term = terms.appoint(task.id, bot.id, { name, purpose, profileId: "test", runtime: "codex", options: { permission: "read-only" } }, { kind: "manual" }, "", `appoint-${task.id}`);
  terms.setRunState(term.termId, "paused");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amo-studio-canvas-integrity-"));
  store = new Store(join(dir, "studio.db"));
  servers = new FakeServers(profiles);
  host = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles);
  workspaceId = store.addWorkspace({ name: "项目", path: dir }).id;
  topicId = host.topics.createTopic({ title: "专题" }).id;
  lead = task("总主控", true);
  child = task("执行甲", false, lead.id);
  unrelated = task("独立任务");
  host.canvases.saveCanvas(topicId, { ...emptyCanvas(topicId), nodes: [card(lead, 0), card(child, 300), card(unrelated, 600)] });
});

afterEach(async () => { await servers.close(); store.close(); removeTempDir(dir); });

it("blocks managed cards disappearing through PUT, a bulk mutation, undo or the single-card toggle", () => {
  pauseWithAppointment(lead);
  const before = current();
  const routes = canvasRoutes(host);
  const put = routes.find((route) => route.method === "PUT" && route.path === "/api/topics/:id/canvas")!;
  const single = routes.find((route) => route.method === "PUT" && route.path === "/api/tasks/:id/canvas")!;
  const write = (body: CanvasDoc) => put.handle({ method: "PUT", path: `/api/topics/${topicId}/canvas`, params: { id: topicId }, query: new URLSearchParams(), body });
  const hide = (task: Task) => single.handle({ method: "PUT", path: `/api/tasks/${task.id}/canvas`, params: { id: task.id }, query: new URLSearchParams(), body: { onCanvas: false } });
  const keepOne = (doc: CanvasDoc) => ({ ...doc, nodes: doc.nodes.filter((n) => n.id === `card-${unrelated.id}`) });
  expect(() => write(keepOne(before))).toThrow(/正式卡.*收起分支/);
  expect(() => host.canvases.mutateCanvas(topicId, keepOne)).toThrow(/正式卡/);
  expect(() => hide(child)).toThrow(/正式卡/);
  expect(() => host.canvases.leaveCanvas(topicId, lead.id)).toThrow(/正式卡/);
  expect(current()).toEqual(before);

  host.canvases.canvasMove(topicId, { target: child.id, x: 400, y: 90 });
  const moved = current();
  expect(() => write(before)).toThrow(/version/);
  // An undo based on the latest version still cannot restore an older snapshot without the required card.
  expect(() => write(keepOne({ ...before, version: moved.version }))).toThrow(/正式卡/);
  expect(current()).toEqual(moved);
  hide(unrelated);
  expect(current().nodes.map((node) => node.id)).toEqual([`card-${lead.id}`, `card-${child.id}`]);
});

it("repairs an appointed branch in one write, reusing reference styling and avoiding occupied bounds", async () => {
  pauseWithAppointment(lead);
  const before = current();
  const added = task("缺卡的新下级", false, lead.id);
  const reference: CanvasNode = { kind: "ref", id: "old-ref", taskId: child.id, groupId: "existing", pos: { x: 312, y: 42 }, size: { w: 286, h: 123 }, color: "green" };
  const group = { id: "existing", title: "原组", workspaceId: null, rect: { x: 300, y: 0, w: 400, h: 600 } };
  store.putCanvas({ ...before, groups: [group], nodes: [...before.nodes.filter((n) => n.id !== `card-${child.id}`), reference] });
  host.canvases.ensureManagementCards(lead.id);
  const repaired = current();
  expect(repaired.version).toBe(before.version + 1);
  expect(repaired.groups).toEqual([group]);
  expect(repaired.nodes.find((n) => n.id === reference.id)).toEqual({ ...reference, kind: "task" });
  expect(repaired.nodes.find((n) => n.id === `card-${lead.id}`)).toEqual(before.nodes[0]);
  const addedCard = repaired.nodes.find((n) => n.kind === "task" && n.taskId === added.id);
  expect(addedCard?.pos.y).toBeGreaterThan(group.rect.y + group.rect.h);
  host.canvases.ensureManagementCards(lead.id);
  expect(current()).toEqual(repaired);

  await host.tasks.archiveTask(child.id);
  expect(current().nodes.find((n) => n.id === reference.id)).toEqual({ ...reference, kind: "task" });
  expect(store.getTask(child.id)?.managerTaskId).toBe(lead.id);
});

it("checks appointed session authority even for a canvas mutation without task endpoints", () => {
  const session = bindLeadFixture(host, sessionFor(lead));
  new BotLeadStore(store).setRunState(session.botLeadTerm!.termId, "paused");
  const before = current();
  expect(() => host.canvases.canvasCreateGroup(topicId, { title: "空组" }, session.id)).toThrow(/任期|暂停/);
  expect(current()).toEqual(before);
});

it("reports a concrete mixed cycle across roots and validates a prospective manager transfer", () => {
  const second = task("另一个主控", true);
  const secondChild = task("执行乙", false, second.id);
  host.canvases.canvasAddDependency(lead.id, secondChild.id);
  const before = current();
  expect(() => host.canvases.saveCanvas(topicId, { ...before, edges: [...before.edges, edge("cross-root", second, child)] })).toThrow(/另一个主控.*执行甲.*总主控.*执行乙.*另一个主控/);
  expect(() => host.canvases.canvasAddDependency(lead.id, child.id)).toThrow(/总主控.*执行甲.*总主控/);
  expect(current()).toEqual(before);
  host.canvases.canvasAddDependency(lead.id, unrelated.id);
  expect(() => host.tasks.setManager(unrelated.id, lead.id)).toThrow(/独立任务.*总主控.*独立任务/);
  expect(store.getTask(unrelated.id)?.managerTaskId).toBeNull();
  host.canvases.setTaskOnCanvas(unrelated.id, { onCanvas: false });
  pauseWithAppointment(second);
  expect(host.tasks.setManager(unrelated.id, second.id).managerTaskId).toBe(second.id);
  expect(current().nodes.some((n) => n.kind === "task" && n.taskId === unrelated.id)).toBe(true);
  expect(() => host.canvases.setTaskOnCanvas(unrelated.id, { onCanvas: false })).toThrow(/正式卡/);
});

it("refuses an individual restore that would activate a mixed cycle, then restores it after the edge is removed", async () => {
  pauseWithAppointment(lead);
  await host.tasks.archiveTask(child.id);
  host.canvases.canvasAddDependency(lead.id, child.id);
  const before = current();
  await expect(host.tasks.unarchiveTask(child.id)).rejects.toThrow(/等待循环/);
  expect(store.getTask(child.id)?.archivedAt).toBeTruthy();
  expect(current()).toEqual(before);
  host.canvases.saveCanvas(topicId, { ...before, edges: [] });
  host.canvases.setTaskOnCanvas(child.id, { onCanvas: false });
  const restored = await host.tasks.unarchiveTask(child.id);
  expect(restored).toMatchObject({ archivedAt: null, managerTaskId: lead.id });
  expect(current().nodes.some((n) => n.kind === "task" && n.taskId === child.id)).toBe(true);
});

it("preflights all topic members before restoring any task or session", async () => {
  const session = sessionFor(lead);
  const before = current();
  store.putCanvas({ ...before, edges: [edge("historical", lead, child)] });
  await host.topics.archiveTopic(topicId);
  const archivedTopic = store.getTopic(topicId);
  const archivedLead = store.getTask(lead.id);
  const archivedChild = store.getTask(child.id);
  const archivedSession = store.getSession(session.id);
  const doc = current();

  await expect(host.topics.unarchiveTopic(topicId)).rejects.toThrow(/总主控.*执行甲.*总主控/);
  expect(store.getTopic(topicId)).toEqual(archivedTopic);
  expect(store.getTask(lead.id)).toEqual(archivedLead);
  expect(store.getTask(child.id)).toEqual(archivedChild);
  expect(store.getSession(session.id)).toEqual(archivedSession);
  expect(current()).toEqual(doc);
});

it("rolls back a split whose new child would wait on the parent's own final delivery", async () => {
  const session = bindLeadFixture(host, sessionFor(lead));
  const before = current();
  const tasksBefore = store.listTasks();
  const queuesBefore = store.getKv("taskplans.pending-starts");
  const events: string[] = [];
  host.on("event", (event) => events.push(event.type));
  await expect(host.taskPlans.propose(session.id, { summary: "多项分工", tasks: [
    { key: "first", title: "合法工作" },
    { key: "second", title: "会形成死等", dependsOn: [lead.id, "first"] },
  ] })).rejects.toThrow(/总主控.*会形成死等.*总主控/);
  expect(store.listTasks()).toEqual(tasksBefore);
  expect(store.getKv("taskplans.pending-starts")).toEqual(queuesBefore);
  expect(current()).toEqual(before);
  expect(events).not.toContain("task.upserted");
  expect(events).not.toContain("canvas.updated");
});

it("leaves historical mixed cycles readable and allows movement and repair", () => {
  const before = current();
  store.putCanvas({ ...before, edges: [edge("historical", lead, child)] });
  host.canvases.canvasMove(topicId, { target: child.id, x: 11, y: 20 });
  const moved = current();
  expect(moved.edges).toHaveLength(1);
  expect(moved.nodes.find((n) => n.id === `card-${child.id}`)?.pos).toEqual({ x: 11, y: 20 });
  host.canvases.saveCanvas(topicId, { ...moved, edges: [] });
  expect(current().edges).toEqual([]);
  expect(() => host.canvases.canvasAddDependency(lead.id, child.id)).toThrow(/等待循环/);
});
