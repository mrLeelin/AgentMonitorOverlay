import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { managesTask } from "../../core/role.js";
import { roleCardFor } from "../guide/role.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const PROFILES: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let workspace: Workspace;
let topic: Topic;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-management-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  workspace = store.addWorkspace({ name: "测试", path: root });
  topic = service.topics.createTopic({ title: "测试专题" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  store.close();
  removeTempDir(root);
});

const task = (title: string, lead = false, managerTaskId: string | null = null) => store.createTask({ title, workspaceId: workspace.id, topicId: topic.id, lead, managerTaskId });
const session = (owner: Task | null) => store.createSession({ taskId: owner?.id ?? null, topicId: owner ? null : topic.id, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId: workspace.id, title: "", status: "idle", writer: "workbench", runtimeRef: null });

describe("stored management ownership", () => {
  it("counts the unique multi-level tree without treating a sibling or old unassigned task as owned", () => {
    const top = task("总主控", true);
    const sub = task("下级主控", true, top.id);
    const direct = task("直属执行", false, top.id);
    const indirect = task("间接执行", false, sub.id);
    task("平级主控", true);
    task("旧任务");
    const tree = service.tasks.management(top.id);
    expect(tree.direct.map((t) => t.id).sort()).toEqual([sub.id, direct.id].sort());
    expect(tree.descendants.map((t) => t.id).sort()).toEqual([sub.id, direct.id, indirect.id].sort());
    expect(tree).toMatchObject({ directLeadCount: 1, workerCount: 2 });
    expect(service.tasks.management(sub.id).descendants.map((t) => t.id)).toEqual([indirect.id]);
  });

  it("rejects self-management, cycles, invalid managers and cross-topic assignment before mutation", () => {
    const top = task("总主控", true);
    const sub = task("下级主控", true, top.id);
    const worker = task("执行", false, sub.id);
    const outside = store.createTask({ title: "别的专题主控", workspaceId: workspace.id, topicId: service.topics.createTopic({ title: "其他" }).id, lead: true });
    for (const managerTaskId of [top.id, sub.id]) expect(() => service.tasks.updateTask(top.id, { managerTaskId })).toThrow(/自管|环/);
    for (const managerTaskId of [worker.id, "missing", outside.id]) expect(() => service.tasks.updateTask(sub.id, { managerTaskId })).toThrow(/主控|专题/);
    expect(store.getTask(top.id)?.managerTaskId).toBeNull();
    expect(store.getTask(sub.id)?.managerTaskId).toBe(top.id);
  });

  it("allows topic assignment and in-tree transfer but refuses self-claim and cross-tree transfer", async () => {
    const top = task("总主控", true);
    const sub = task("下级主控", true, top.id);
    const peer = task("平级主控", true);
    const worker = task("执行");
    const topSession = session(top);
    const topicSession = session(null);
    const workerSession = session(worker);
    expect(() => service.tasks.setManager(worker.id, top.id, topSession.id)).toThrow(/管理范围/);
    expect(() => service.tasks.setManager(worker.id, top.id, workerSession.id)).toThrow(/不能自行/);
    expect(() => service.tasks.setManager(top.id, peer.id, topSession.id)).toThrow(/不能自行/);
    expect(service.tasks.setManager(worker.id, top.id, topicSession.id).managerTaskId).toBe(top.id);
    expect(service.tasks.setManager(worker.id, sub.id, topSession.id).managerTaskId).toBe(sub.id);
    expect(() => service.tasks.setManager(worker.id, peer.id, topSession.id)).toThrow(/接收主控/);
    expect(service.tasks.setManager(worker.id, peer.id, topicSession.id).managerTaskId).toBe(peer.id);
    expect(managesTask(service, topSession.id, worker.id)).toBe(false);
  });

  it("rechecks cached MCP tools after transfer and never derives rights from annotation lines", async () => {
    const top = task("主控", true);
    const peer = task("平级主控", true);
    const worker = task("执行", false, top.id);
    const topSession = session(top);
    service.canvases.canvasPlaceTask(top.id, null);
    service.canvases.canvasPlaceTask(peer.id, null);
    service.canvases.canvasPlaceTask(worker.id, null);
    const doc = service.canvases.canvas(topic.id);
    const a = doc.nodes.find((n) => n.kind === "task" && n.taskId === top.id)!;
    const b = doc.nodes.find((n) => n.kind === "task" && n.taskId === peer.id)!;
    store.putCanvas({ ...doc, links: [...(doc.links ?? []), { id: "annotation", from: a.id, fromSide: "right", to: b.id, toSide: "left", label: "仅供参考" }] });
    const tools = amoToolsFor(service, { sessionId: topSession.id });
    const update = tools.find((t) => t.name === "task_update")!;
    expect(await update.run({ taskId: worker.id, column: "review" })).not.toHaveProperty("isError", true);
    expect(await update.run({ taskId: peer.id, column: "done" })).toHaveProperty("isError", true);
    service.tasks.setManager(worker.id, peer.id);
    expect(await update.run({ taskId: worker.id, column: "done" })).toHaveProperty("isError", true);
    expect(store.getTask(worker.id)?.column).toBe("review");
  });

  it("supports a lead's explicit descendants in the same project without a topic", async () => {
    const top = store.createTask({ title: "项目主控", workspaceId: workspace.id, topicId: null, lead: true });
    const worker = store.createTask({ title: "项目执行", workspaceId: workspace.id, topicId: null, managerTaskId: top.id });
    const peer = store.createTask({ title: "未分配", workspaceId: workspace.id, topicId: null });
    const topSession = session(top);
    const update = amoToolsFor(service, { sessionId: topSession.id }).find((t) => t.name === "task_update")!;
    expect(await update.run({ taskId: worker.id, column: "review" })).not.toHaveProperty("isError", true);
    expect(await update.run({ taskId: peer.id, column: "done" })).toHaveProperty("isError", true);
    expect(service.tasks.management(top.id).descendants.map((t) => t.id)).toEqual([worker.id]);
  });

  it("keeps management separate from dependencies and gives the first session its stored owner and scope", async () => {
    const top = task("持续运行的主控", true);
    store.updateTask(top.id, { column: "doing" });
    let firstCard = "";
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner, ws) => {
      expect(store.getTask(owner.taskId!)?.managerTaskId).toBe(top.id);
      expect(store.getTask(owner.taskId!)?.description).toBe("先验证归属");
      firstCard = roleCardFor(service, { ...owner, workspaceId: ws.id, kind: "main", runtime: "codex" });
      return session(store.getTask(owner.taskId!)!);
    });
    const made = await service.tasks.createTask({ title: "执行", topicId: topic.id, workspaceId: workspace.id, managerTaskId: top.id, description: "先验证归属", firstSession: { profileId: "test", text: "开工" } });
    expect(made.session).not.toBeNull();
    expect(firstCard).toContain(`直属主控：${top.title}（${top.id}）`);
    expect(firstCard).toContain("先验证归属");
    expect(service.canvases.canvas(topic.id).edges).toEqual([]);
  });

  it("blocks role removal and moves until ownership is explicitly resolved", () => {
    const top = task("总主控", true);
    const worker = task("执行", false, top.id);
    const elsewhere = service.topics.createTopic({ title: "其他专题" });
    expect(() => service.tasks.updateTask(top.id, { lead: false })).toThrow(/直属任务/);
    expect(() => service.tasks.updateTask(top.id, { topicId: elsewhere.id })).toThrow(/移动专题/);
    expect(() => service.tasks.updateTask(worker.id, { topicId: elsewhere.id })).toThrow(/移动专题/);
    service.tasks.setManager(worker.id, null);
    expect(service.tasks.updateTask(top.id, { lead: false }).lead).not.toBe(true);
    expect(service.tasks.updateTask(worker.id, { topicId: elsewhere.id }).topicId).toBe(elsewhere.id);
  });

  it("archives descendants first, requires a restored manager, and restores a topic's tree without losing ownership", async () => {
    const top = task("总主控", true);
    const sub = task("下级主控", true, top.id);
    const worker = task("执行", false, sub.id);
    await expect(service.tasks.archiveTask(top.id)).rejects.toThrow(/直属任务/);
    await service.tasks.archiveTask(worker.id);
    await service.tasks.archiveTask(sub.id);
    await expect(service.tasks.unarchiveTask(worker.id)).rejects.toThrow(/有效/);
    await service.tasks.unarchiveTask(sub.id);
    await service.tasks.unarchiveTask(worker.id);
    const archived = await service.topics.archiveTopic(topic.id);
    expect(archived.tasks.map((t) => t.id)).toEqual([worker.id, sub.id, top.id]);
    expect(service.tasks.management(top.id).descendants).toEqual([]);
    const restored = await service.topics.unarchiveTopic(topic.id);
    expect(restored.tasks.map((t) => t.id)).toEqual([top.id, sub.id, worker.id]);
    expect(store.getTask(worker.id)?.managerTaskId).toBe(sub.id);
    expect(service.tasks.management(top.id)).toMatchObject({ directLeadCount: 1, workerCount: 1 });
  });

  it("rechecks a pending relay's authority when the person delivers it after a transfer", async () => {
    const top = task("主控", true);
    const peer = task("接收主控", true);
    const worker = task("执行", false, top.id);
    const topSession = session(top);
    const relay = service.relays.send(topSession.id, { taskId: worker.id, text: "继续验证" });
    service.tasks.setManager(worker.id, peer.id);
    expect(await service.relays.deliver(relay.id)).toMatchObject({ state: "failed", error: expect.stringContaining("归属已变更") });
    expect(store.listSessions({ taskId: worker.id })).toEqual([]);
    expect(() => service.relays.send(topSession.id, { taskId: worker.id, text: "再次传话" })).toThrow(/管理范围/);
  });

  it("invalidates a held relay after transfer, including immediate send, Host reconstruction and retry", async () => {
    const top = task("总主控", true);
    const sub = task("下级主控", true, top.id);
    const peer = task("接收主控", true);
    const worker = task("执行", false, sub.id);
    const subSession = session(sub);
    const targetSession = session(worker);
    store.updateSession(targetSession.id, { status: "running" });
    const originalResend = vi.spyOn(service.runtime, "resend").mockResolvedValue({ mode: "start" });
    const relay = service.relays.send(subSession.id, { taskId: worker.id, text: "等当前轮结束后执行" });
    expect(await service.relays.deliver(relay.id)).toMatchObject({ state: "delivered", sessionId: targetSession.id });
    const [row] = service.sessions.inbox.held(targetSession.id);
    expect(row).toMatchObject({ type: "user", delivery: "held", relayFromSessionId: subSession.id });
    expect(originalResend.mock.calls.filter(([id]) => id === targetSession.id)).toEqual([]);
    service.tasks.setManager(worker.id, peer.id);
    await expect(service.sessions.sendNow(targetSession.id, row!.id)).rejects.toThrow(/原主控/);
    expect(store.getItem(row!.id)).toMatchObject({ type: "user", delivery: "expired", deliveryReason: expect.stringContaining("原主控"), text: expect.stringContaining("等当前轮结束后执行") });
    expect(originalResend.mock.calls.filter(([id]) => id === targetSession.id)).toEqual([]);
    // A new inbox has no in-memory knowledge of the relay: its source must come from the stored message row.
    const runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    const resumedResend = vi.spyOn(runtime, "resend").mockResolvedValue({ mode: "start" });
    const resumed = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
    store.updateSession(targetSession.id, { status: "idle" });
    await resumed.sessions.inbox.flush(targetSession.id);
    expect(store.getItem(row!.id)).toMatchObject({ type: "user", delivery: "expired", relayFromSessionId: subSession.id });
    await expect(resumed.sessions.resend(targetSession.id, row!.id)).rejects.toThrow(/原主控/);
    expect(store.getItem(row!.id)).toMatchObject({ delivery: "expired" });
    expect(resumedResend.mock.calls.filter(([id]) => id === targetSession.id)).toEqual([]);
    expect(originalResend.mock.calls.filter(([id]) => id === targetSession.id)).toEqual([]);
  });

  it("revokes cached automatic management after demotion or archive", async () => {
    const top = task("主控", true);
    const topSession = session(top);
    const cached = amoToolsFor(service, { sessionId: topSession.id });
    const createGroup = cached.find((t) => t.name === "canvas_group_create")!;
    service.tasks.updateTask(top.id, { lead: false });
    expect(await createGroup.run({ title: "失效自动批准" })).toHaveProperty("isError", true);
    expect(service.canvases.canvas(topic.id).groups).toEqual([]);
    const workerTools = amoToolsFor(service, { sessionId: topSession.id });
    expect(workerTools.find((t) => t.name === "canvas_group_create")?.autoApprove).toBe(false);
    await service.tasks.archiveTask(top.id);
    expect(await workerTools.find((t) => t.name === "task_update")!.run({ title: "归档后改写" })).toHaveProperty("isError", true);
    expect(store.getTask(top.id)?.title).toBe("主控");
  });

  it("refuses restoring a project before its manager's project without partially restoring data", async () => {
    const other = store.addWorkspace({ name: "执行项目", path: join(root, "worker-project") });
    const top = task("A项目主控", true);
    const worker = store.createTask({ title: "B项目执行", workspaceId: other.id, topicId: topic.id, managerTaskId: top.id });
    await expect(service.projects.archiveWorkspace(workspace.id)).rejects.toThrow(/直属任务/);
    expect(store.getWorkspace(workspace.id)?.archivedAt).toBeFalsy();
    expect(store.getTask(top.id)?.archivedAt).toBeNull();
    await service.projects.archiveWorkspace(other.id);
    await service.projects.archiveWorkspace(workspace.id);
    const beforeWorkspace = store.getWorkspace(other.id);
    const beforeWorker = store.getTask(worker.id);
    const publish = vi.spyOn(service, "publish");
    await expect(service.projects.unarchiveWorkspace(other.id)).rejects.toThrow(/直属主控|管理链/);
    expect(store.getWorkspace(other.id)).toEqual(beforeWorkspace);
    expect(store.getWorkspace(other.id)?.archivedAt).toBeTruthy();
    expect(store.getTask(worker.id)).toEqual(beforeWorker);
    expect(publish).not.toHaveBeenCalled();
    await service.projects.unarchiveWorkspace(workspace.id);
    await service.projects.unarchiveWorkspace(other.id);
    expect(store.getWorkspace(other.id)?.archivedAt).toBeFalsy();
    expect(store.getTask(worker.id)).toMatchObject({ archivedAt: null, managerTaskId: top.id });
    expect(service.tasks.management(top.id).descendants.map((t) => t.id)).toEqual([worker.id]);
  });
});
