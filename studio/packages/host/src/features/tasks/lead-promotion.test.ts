import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { AUTO_APPROVED_WRITE_TOOLS } from "../../mcp/names.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { roleCard } from "../guide/role.js";

const PROFILES: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string, store: Store, servers: FakeServers, runtime: CodexRuntime, service: HostService, workspace: Workspace, task: Task, source: Session;
const summary = "做一次投币按钮文字演练，已有需求和验收用例；接下来拆资源、音效和玩法任务并验收。";
const tool = (sessionId: string | null = source.id) => amoToolsFor(service, sessionId ? { sessionId } : null).find((t) => t.name === "task_set_lead")!;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-self-lead-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
  workspace = store.addWorkspace({ name: "测试", path: root });
  const topic = service.topics.createTopic({ title: "教学" });
  const manager = store.createTask({ title: "上级", workspaceId: workspace.id, topicId: topic.id, lead: true });
  task = store.createTask({ title: "投币按钮", workspaceId: workspace.id, topicId: topic.id, managerTaskId: manager.id });
  const handle = await servers.ensure("test");
  const request = handle.client.request.bind(handle.client);
  vi.spyOn(handle.client, "request").mockImplementation(((method: string, params: never) => method === "config/read"
    ? Promise.resolve({ config: { mcp_servers: { amo: {}, unsafe: {} } }, origins: {}, layers: null })
    : request(method as never, params)) as typeof handle.client.request);
  source = await service.tasks.addSession(task.id, { profileId: "test", options: { permission: "full-auto", model: "test-model", effort: "high" } });
  store.updateSession(source.id, { status: "running" });
});

afterEach(async () => {
  service.removeAllListeners("event");
  for (const s of store.listSessions()) if (!s.archivedAt) store.updateSession(s.id, { status: "running" });
  await service.tasks.leadPromotion.flush();
  await servers.close();
  vi.restoreAllMocks();
  store.close();
  removeTempDir(root);
});

const settle = () => {
  const session = store.updateSession(source.id, { status: "idle" });
  service.publish({ type: "session.upserted", session });
};

describe("task_set_lead", () => {
  it("persists the pending title through reconstruction and rejects changing that title until cancellation", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null });
    const topicTitle = "DarkEvil-Story：交付代码与资源风险报告";
    const before = store.listTopics().length;
    await tool().run({ summary, topicTitle });
    expect(JSON.parse(store.getKv("tasks.lead-promotions")!.value)[task.id]).toMatchObject({ topicTitle, summary, state: "pending" });
    // A stopped Host cannot keep its old scheduled processor alive alongside the reconstructed one.
    vi.spyOn(service.tasks.leadPromotion, "flush").mockResolvedValue();
    service.removeAllListeners("event");
    runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
    await service.tasks.leadPromotion.flush();
    expect(store.listTopics()).toHaveLength(before);
    expect(await tool().run({ summary, topicTitle })).not.toHaveProperty("isError", true);
    expect(await tool().run({ summary, topicTitle: "另一个对象：交付别的目标" })).toHaveProperty("isError", true);
    expect(service.tasks.leadPromotion.status(task.id)?.topicTitle).toBe(topicTitle);
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.getTopic(store.getTask(task.id)!.topicId!)?.title).toBe(topicTitle);
    const receipt = service.tasks.leadPromotion.status(task.id)!;
    expect(receipt.state, receipt.error).toBe("done");
    const repeated = await tool(receipt.sessionId!).run({ summary, topicTitle: "已创建后也不能改专题名" });
    expect(repeated.isError, JSON.stringify(repeated)).not.toBe(true);
    expect(store.listTopics()).toHaveLength(before + 1);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
    expect(store.getTopic(store.getTask(task.id)!.topicId!)?.title).toBe(topicTitle);
  });

  it("freezes the resolved legacy title before settling instead of recomputing it after a task rename", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null, title: "投币按钮" });
    await tool().run({ summary });
    expect(service.tasks.leadPromotion.status(task.id)?.topicTitle).toBe("投币按钮");
    store.updateTask(task.id, { title: "审查" });
    expect(await tool().run({ summary })).not.toHaveProperty("isError", true);
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.getTopic(store.getTask(task.id)!.topicId!)?.title).toBe("投币按钮");
  });

  it("creates a specific topic and places the lead only after settling", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null });
    const title = "DarkEvil-Story分支交叉检查：定位缺陷并交付合并风险报告";
    const before = store.listTopics().length;
    expect(await tool().run({ summary, topicTitle: title })).not.toHaveProperty("isError", true);
    await service.tasks.leadPromotion.flush();
    expect(store.listTopics()).toHaveLength(before);
    settle();
    await service.tasks.leadPromotion.flush();
    const promoted = store.getTask(task.id)!;
    expect(store.getTopic(promoted.topicId!)?.title).toBe(title);
    expect(service.canvases.canvas(promoted.topicId!).nodes).toEqual([expect.objectContaining({ kind: "task", taskId: task.id })]);
    await service.tasks.leadPromotion.flush();
    expect(store.listTopics()).toHaveLength(before + 1);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
  });

  it("rejects generic new topics and invalid parameters before saving a promotion or a topic", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null, title: "审查" });
    const count = store.listTopics().length;
    for (const args of [{ summary }, { summary, topicTitle: "任务" }, { summary: "", topicTitle: "投币按钮：拆分资源与音效" }, { summary, topicTitle: 42 }]) {
      expect(await tool().run(args)).toHaveProperty("isError", true);
      expect(service.tasks.leadPromotion.status(task.id)).toBeNull();
      expect(store.listTopics()).toHaveLength(count);
    }
    expect(await tool().run({ summary, topicTitle: "投币按钮：拆分资源与音效" })).not.toHaveProperty("isError", true);
    service.tasks.leadPromotion.cancel(source.id);
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.listTopics()).toHaveLength(count);
  });

  it("uses a meaningful short task title for legacy calls and recovers the topic/card receipt on reconstruction", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null, title: "投币按钮" });
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    const receipt = service.tasks.leadPromotion.status(task.id)!;
    const topicId = store.getTask(task.id)!.topicId!;
    expect(store.getTopic(topicId)?.title).toBe("投币按钮");
    const count = store.listTopics().length;
    const saved = JSON.parse(store.getKv("tasks.lead-promotions")!.value);
    saved[task.id].state = "starting";
    delete saved[task.id].sessionId;
    store.setKv("tasks.lead-promotions", JSON.stringify(saved));
    service.removeAllListeners("event");
    runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "done", sessionId: receipt.sessionId });
    expect(store.listTopics()).toHaveLength(count);
    expect(service.canvases.canvas(topicId).nodes).toHaveLength(1);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
  });

  it("preserves the user's existing topic and layout while adding only missing ancestor endpoints", async () => {
    const originalTopic = store.getTopic(task.topicId!)!;
    service.canvases.canvasPlaceTask(task.id, null);
    service.canvases.canvasMove(task.topicId!, { target: task.id, x: 80, y: 125 });
    const before = service.canvases.canvas(task.topicId!).nodes[0];
    const peer = store.createTask({ title: "不归本任务管理", workspaceId: workspace.id, topicId: task.topicId });
    await tool().run({ summary, topicTitle: "不会擅自改这个专题名" });
    settle();
    await service.tasks.leadPromotion.flush();
    const doc = service.canvases.canvas(task.topicId!);
    expect(store.getTopic(task.topicId!)?.title).toBe(originalTopic.title);
    expect(doc.nodes.find((n) => n.kind === "task" && n.taskId === task.id)).toEqual(before);
    expect(doc.nodes.filter((n) => n.kind === "task").map((n) => n.taskId).sort()).toEqual([task.id, task.managerTaskId!].sort());
    expect(doc.nodes.some((n) => n.kind === "task" && n.taskId === peer.id)).toBe(false);
    expect(store.getTask(task.id)?.managerTaskId).toBe(task.managerTaskId);
  });

  it("refuses moving an unbound managed child or a changed pending scope without creating a topic", async () => {
    store.updateTask(task.managerTaskId!, { topicId: null });
    store.updateTask(task.id, { topicId: null });
    const count = store.listTopics().length;
    expect(await tool().run({ summary, topicTitle: "投币按钮：组织实现与验收" })).toHaveProperty("isError", true);
    store.updateTask(task.id, { managerTaskId: null });
    await tool().run({ summary, topicTitle: "投币按钮：组织实现与验收" });
    store.updateTask(task.id, { managerTaskId: task.managerTaskId });
    settle();
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("failed");
    expect(store.listTopics()).toHaveLength(count);
    expect(store.getSession(source.id)?.archivedAt).toBeNull();
  });

  it("takes corrected parameters after a cancelled pending request", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null });
    await tool().run({ summary, topicTitle: "投币按钮：整理需求" });
    service.tasks.leadPromotion.cancel(source.id);
    await tool().run({ summary: `${summary}补充新目标`, topicTitle: "投币按钮：交付实现与验收" });
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.getTopic(store.getTask(task.id)!.topicId!)?.title).toBe("投币按钮：交付实现与验收");
    expect(service.tasks.leadPromotion.status(task.id)?.summary).toContain("补充新目标");
  });

  it("retries a failed start from its saved handover without creating another topic or session", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null });
    await tool().run({ summary, topicTitle: "投币按钮：组织实现与验收" });
    settle();
    const start = vi.spyOn(service.tasks, "addSession").mockRejectedValueOnce(new Error("mock start failed"));
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", retryState: "starting" });
    const count = store.listTopics().length;
    const topicId = store.getTask(task.id)?.topicId;
    const retrySession = await service.tasks.addSession(task.id, { profileId: "test" });
    expect(await tool(retrySession.id).run({ summary })).not.toHaveProperty("isError", true);
    service.tasks.leadPromotion.cancel(retrySession.id);
    service.tasks.leadPromotion.cancel(retrySession.id);
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", retryState: "starting" });
    expect(await tool(retrySession.id).run({ summary })).not.toHaveProperty("isError", true);
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    expect(start).toHaveBeenCalledTimes(2);
    expect(store.listTopics()).toHaveLength(count);
    expect(store.getTask(task.id)?.topicId).toBe(topicId);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
  });

  it("rolls back a failed topic/card commit and resumes its saved switching receipt from a live main session", async () => {
    store.updateTask(task.id, { topicId: null, managerTaskId: null });
    const count = store.listTopics().length;
    await tool().run({ summary, topicTitle: "投币按钮：组织实现与验收" });
    settle();
    const place = vi.spyOn(service.canvases, "canvasPlaceTask").mockImplementationOnce(() => { throw new Error("mock card failed"); });
    await service.tasks.leadPromotion.flush();
    expect(store.listTopics()).toHaveLength(count);
    expect(store.getTask(task.id)?.topicId).toBeNull();
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", retryState: "switching" });
    place.mockRestore();
    store.updateTask(task.id, { title: "审查" });
    const retrySession = await service.tasks.addSession(task.id, { profileId: "test" });
    store.updateSession(retrySession.id, { status: "running" });
    expect(await tool(retrySession.id).run({ summary })).not.toHaveProperty("isError", true);
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("switching");
    expect(store.listTopics()).toHaveLength(count);
    store.updateSession(retrySession.id, { status: "idle" });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    expect(store.listTopics()).toHaveLength(count + 1);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(3);
  });

  it("is self-scoped and automatically approved, and cannot be called anonymously or from topic, fork or sub sessions", async () => {
    expect(tool()).toMatchObject({ readOnly: false, autoApprove: true });
    expect(AUTO_APPROVED_WRITE_TOOLS).toContain("task_set_lead");
    expect(Object.keys(tool().inputSchema)).toEqual(["summary", "topicTitle"]);
    expect(await tool(null).run({ summary })).toHaveProperty("isError", true);
    for (const kind of ["fork", "sub", "topic"] as const) {
      const session = store.createSession({ ...source, id: undefined, runtimeRef: null, status: "idle", kind: kind === "topic" ? "main" : kind, parentId: kind === "topic" ? null : source.id, taskId: kind === "topic" ? null : task.id, topicId: kind === "topic" ? task.topicId : null });
      expect(await tool(session.id).run({ summary })).toHaveProperty("isError", true);
    }
    expect(await tool().run({ summary: " " })).toHaveProperty("isError", true);
    expect(await tool().run({ summary: "x".repeat(20_001) })).toHaveProperty("isError", true);
    expect(store.getTask(task.id)?.lead).not.toBe(true);
  });

  it("waits for the current turn, then preserves ownership and starts exactly one isolated lead session with the handoff", async () => {
    expect(await tool().run({ summary, taskId: task.managerTaskId })).not.toHaveProperty("isError", true);
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("pending");
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(store.getSession(source.id)?.archivedAt).toBeNull();
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    const receipt = service.tasks.leadPromotion.status(task.id)!;
    expect(receipt.state).toBe("done");
    expect(store.getTask(task.id)).toMatchObject({ lead: true, managerTaskId: task.managerTaskId, topicId: task.topicId, workspaceId: task.workspaceId });
    expect(store.getSession(source.id)?.archivedAt).toBeTruthy();
    const target = store.getSession(receipt.sessionId!)!;
    expect(target).toMatchObject({ taskId: task.id, profileId: source.profileId, kind: "main", parentId: null, options: { permission: "read-only", model: "test-model", effort: "high" } });
    expect(store.getKv(`codex-lead-readonly:${target.id}`)?.value).toBe(target.runtimeRef);
    expect(roleCard(service, target.id)).toContain("你是主控");
    expect(store.findItems(target.id, "user").some((i) => i.type === "user" && i.text.includes(summary))).toBe(true);
    const starts = servers.fakes.get("test")!.calls.filter((c) => c.method === "thread/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", config: { "mcp_servers.unsafe.enabled": false, "features.multi_agent": false } });
    await service.tasks.leadPromotion.flush();
    expect((await tool(target.id).run({ summary })).isError).not.toBe(true);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
    await expect(service.sessions.sendMessage(source.id, "继续写文件")).rejects.toThrow(/归档/);
  });

  it("waits for peers, terminals, background commands and undelivered messages without stopping them", async () => {
    await tool().run({ summary });
    settle();
    const peer = store.createSession({ ...source, id: undefined, runtimeRef: null, status: "running" });
    await service.tasks.leadPromotion.flush();
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    store.updateSession(peer.id, { status: "idle", writer: "terminal-shared" });
    await service.tasks.leadPromotion.flush();
    expect(store.getSession(peer.id)?.archivedAt).toBeNull();
    store.updateSession(peer.id, { writer: "workbench" });
    const background = store.appendItem({ id: "background", sessionId: source.id, createdAt: new Date().toISOString(), type: "background", state: "running", taskId: "bg", command: "mock", description: "等待后台", startedAt: new Date().toISOString() });
    await service.tasks.leadPromotion.flush();
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    store.replaceItem({ ...background, state: "completed" } as typeof background);
    const message = store.appendItem({ id: "unsent", sessionId: source.id, createdAt: new Date().toISOString(), type: "user", text: "先处理新要求", delivery: "unsent" });
    await service.tasks.leadPromotion.flush();
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(store.getItem(message.id)).toMatchObject({ delivery: "unsent" });
    if (message.type !== "user") throw new Error("expected user message");
    store.replaceItem({ ...message, delivery: undefined });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    expect(store.getSession(peer.id)?.archivedAt).toBeTruthy();
  });

  it("cancels an explicitly stopped source and rejects archived callers", async () => {
    await tool().run({ summary });
    store.updateSession(source.id, { status: "interrupted" });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("被停止") });
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(store.getSession(source.id)?.archivedAt).toBeNull();
    store.archiveSubtree(source.id);
    expect(await tool().run({ summary })).toHaveProperty("isError", true);
  });

  it("cancels through the real Stop entry even when Codex reports the interrupted main session as idle", async () => {
    store.updateSession(source.id, { status: "idle" });
    await runtime.setOptions(source.id, { permission: "ask" });
    await runtime.sendMessage(source.id, "[[shell: write-file]]");
    await vi.waitFor(() => expect(store.getSession(source.id)?.status).toBe("awaiting-approval"));
    await tool().run({ summary });
    await service.sessions.interrupt(source.id);
    await vi.waitFor(() => expect(store.getSession(source.id)?.status).toBe("idle"));
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("用户停止") });
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(store.getSession(source.id)?.archivedAt).toBeNull();
  });

  it("waits for a session still starting before it has been saved", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = runtime.startSession.bind(runtime);
    const start = vi.spyOn(runtime, "startSession").mockImplementationOnce(async (input) => { await gate; return original(input); });
    const creating = service.tasks.addSession(task.id, { profileId: "test" });
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.listSessions({ taskId: task.id })).toHaveLength(1);
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    expect(() => service.tasks.updateTask(task.id, { lead: true })).toThrow(/正在创建/);
    release();
    const peer = await creating;
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    expect(store.getSession(peer.id)?.archivedAt).toBeTruthy();
    expect(store.listSessions({ taskId: task.id }).filter((s) => !s.archivedAt)).toHaveLength(1);
  });

  it("allows a fresh promotion after the user cancels the lead role", async () => {
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    const first = service.tasks.leadPromotion.status(task.id)!;
    await vi.waitFor(() => expect(store.getSession(first.sessionId!)?.status).toBe("idle"));
    service.tasks.updateTask(task.id, { lead: false });
    expect(await tool(first.sessionId!).run({ summary })).not.toHaveProperty("isError", true);
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("pending");
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "done", sourceSessionId: first.sessionId });
    expect(service.tasks.leadPromotion.status(task.id)?.sessionId).not.toBe(first.sessionId);
    expect(store.getTask(task.id)?.lead).toBe(true);
  });

  it("includes an in-flight fork in the same start barrier", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = runtime.fork.bind(runtime);
    const fork = vi.spyOn(runtime, "fork").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const creating = service.sessions.fork(source.id);
    await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    expect(store.getTask(task.id)?.lead).not.toBe(true);
    release();
    const branch = await creating;
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    expect(store.getSession(branch.id)?.archivedAt).toBeTruthy();
  });

  it("does not send a lead handoff when the user changes the role during startup", async () => {
    await tool().run({ summary });
    settle();
    const original = service.tasks.addSession.bind(service.tasks);
    vi.spyOn(service.tasks, "addSession").mockImplementationOnce(async (...args) => {
      const target = await original(...args);
      service.tasks.updateTask(task.id, { lead: false });
      return target;
    });
    await service.tasks.leadPromotion.flush();
    const receipt = service.tasks.leadPromotion.status(task.id)!;
    expect(receipt).toMatchObject({ state: "failed", error: expect.stringContaining("状态已改变") });
    expect(store.getSession(receipt.sessionId!)?.archivedAt).toBeTruthy();
    expect(store.findItems(receipt.sessionId!, "user")).toHaveLength(0);
  });

  it("rechecks an old Codex send that was awaiting the server before the archive barrier", async () => {
    store.updateSession(source.id, { status: "idle" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = servers.ensure.bind(servers);
    const ensure = vi.spyOn(servers, "ensure").mockImplementationOnce(async (id) => { await gate; return original(id); });
    const sending = runtime.sendMessage(source.id, "late old message");
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    await tool().run({ summary });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)?.state).toBe("done");
    release();
    await expect(sending).rejects.toThrow(/归档/);
    const turns = servers.fakes.get("test")!.calls.filter((c) => c.method === "turn/start");
    expect(turns.some((c) => (c.params as { threadId: string }).threadId === source.runtimeRef)).toBe(false);
  });

  it("keeps a failed start visible and never retries it on every event", async () => {
    await tool().run({ summary });
    settle();
    const start = vi.spyOn(service.tasks, "addSession").mockRejectedValue(new Error("mock start failed"));
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "failed", error: "mock start failed" });
    await service.tasks.leadPromotion.flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(store.findItems(source.id, "notice").some((i) => i.type === "notice" && i.message.includes("mock start failed"))).toBe(true);
  });

  it("recovers an already created lead session after Host reconstruction without duplicating it or its message", async () => {
    await tool().run({ summary });
    settle();
    await service.tasks.leadPromotion.flush();
    const receipt = service.tasks.leadPromotion.status(task.id)!;
    const saved = JSON.parse(store.getKv("tasks.lead-promotions")!.value);
    saved[task.id].state = "starting";
    delete saved[task.id].sessionId;
    store.setKv("tasks.lead-promotions", JSON.stringify(saved));
    service.removeAllListeners("event");
    runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
    service = new HostService(store, runtime, PROFILES, { commonDir: join(root, "common") });
    await service.tasks.leadPromotion.flush();
    expect(service.tasks.leadPromotion.status(task.id)).toMatchObject({ state: "done", sessionId: receipt.sessionId });
    expect(store.listSessions({ taskId: task.id })).toHaveLength(2);
    expect(store.findItems(receipt.sessionId!, "user").filter((i) => i.id === `lead-promotion-${source.id}`)).toHaveLength(1);
  });
});
