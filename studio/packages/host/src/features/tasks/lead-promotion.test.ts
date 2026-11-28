import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
import type { ModelProfile, Session, Task, Workspace } from "@amo-studio/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let dir: string, store: Store, servers: FakeServers, runtime: CodexRuntime, host: HostService, task: Task, workspace: Workspace, source: Session, botId: string;
const summary = "保留原任务目标、结果和待分工记录";
const key = "tasks.lead-promotions";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "amo-lead-promotion-"));
  store = new Store(join(dir, "studio.db"));
  servers = new FakeServers(profiles);
  runtime = new CodexRuntime({ store, servers, profiles });
  host = new HostService(store, runtime, profiles, { commonDir: join(dir, "common") });
  workspace = store.addWorkspace({ name: "试验项目", path: dir });
  task = store.createTask({ title: "投币按钮", workspaceId: workspace.id });
  source = await host.tasks.addSession(task.id, { profileId: "test", options: { permission: "full-auto" } });
  botId = host.bots.save({ name: "验收机器人", purpose: "带队", memory: "", workspaceId: workspace.id, profileId: "test", enabled: true }).id;
});

afterEach(async () => {
  host.removeAllListeners("event");
  await host.botLeads.flush();
  vi.spyOn(host.botLeads, "flush").mockResolvedValue();
  await servers.close();
  store.close();
  removeTempDir(dir);
  vi.restoreAllMocks();
});

const appoint = (operationId: string, topicTitle = "投币按钮 · 交付与验证") => host.botLeads.appoint({
  operationId, botId, taskId: task.id, expectedTerm: null, summary, topicTitle, intent: "upgrade", source: { kind: "manual" },
});
const status = (status: Session["status"]) => host.publish({ type: "session.upserted", session: store.updateSession(source.id, { status }) });

it("returns instructions to the old MCP entry without writing a promotion", async () => {
  const tool = amoToolsFor(host, { sessionId: source.id }).find((candidate) => candidate.name === "task_set_lead")!;
  expect(await tool.run({ summary })).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("选择机器人带队") }] });
  expect(store.getKv(key)).toBeUndefined();
  expect(store.getTask(task.id)?.lead).toBeFalsy();
  expect(store.getSession(source.id)?.archivedAt).toBeNull();
});

it("retains an old queued request, waits for its original turn, and assigns the same task explicitly", async () => {
  const legacy = { taskId: task.id, sourceSessionId: source.id, summary: "旧的冻结原文", topicTitle: "旧的专题目标", oldSessionIds: [source.id], state: "switching" };
  store.setKv(key, JSON.stringify({ [task.id]: legacy }));
  status("running");
  await host.botLeads.flush();
  expect(host.botLeads.taskView(task.id).state).toMatchObject({ kind: "legacy", summary: legacy.summary, topicTitle: legacy.topicTitle });
  expect(JSON.parse(store.getKv(key)!.value)[task.id]).toEqual(legacy);
  expect(store.getTask(task.id)?.lead).toBeFalsy();
  const receipt = appoint("take-pending", legacy.topicTitle);
  expect(receipt).toMatchObject({ action: "upgrade", state: { kind: "pending-upgrade", blockers: [{ sessionId: source.id, kind: "turn" }] } });
  status("idle");
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(task.id)!;
  expect(term.handoff).toContain(legacy.summary);
  expect(store.getTopic(store.getTask(task.id)!.topicId!)?.title).toBe(legacy.topicTitle);
  expect(host.tasks.leadPromotion.status(task.id)).toMatchObject({ ...legacy, state: "done" });
  expect(store.getSession(source.id)?.writer).toBe("archived");
  expect(store.getSession(term.sessionId!)?.options.permission).toBe("read-only");
});

it("rolls back topic, task, session archive and term when the formal card cannot be saved", async () => {
  const before = store.listTopics();
  const place = vi.spyOn(host.canvases, "ensureManagementCards").mockImplementationOnce(() => { throw new Error("mock card failed"); });
  appoint("bad-card");
  await host.botLeads.flush();
  expect(store.listTopics()).toEqual(before);
  expect(store.getTask(task.id)?.topicId).toBeNull();
  expect(store.getSession(source.id)?.writer).toBe("workbench");
  expect(host.botLeads.currentTerm(task.id)).toBeNull();
  expect(host.botLeads.taskView(task.id).state).toMatchObject({ kind: "pending-upgrade", reason: "mock card failed" });
  place.mockRestore();
  host.botLeads.control(task.id, { action: "cancel-handoff", operationId: "cancel-fault", expectedTerm: null, handoffOperationId: "bad-card" });
  appoint("retry-card");
  await host.botLeads.flush();
  expect(host.botLeads.currentTerm(task.id)?.generation).toBe(1);
  expect(store.listTopics()).toHaveLength(before.length + 1);
});

it("leaves the plan to bind in place when a pending promotion is interrupted and reopened", async () => {
  const legacy = { taskId: task.id, sourceSessionId: source.id, summary, oldSessionIds: [source.id], state: "pending" };
  store.setKv(key, JSON.stringify({ [task.id]: legacy }));
  status("running");
  appoint("cancel-before-commit");
  host.botLeads.control(task.id, { action: "cancel-handoff", operationId: "cancel", expectedTerm: null, handoffOperationId: "cancel-before-commit" });
  status("idle");
  await host.botLeads.flush();
  expect(host.botLeads.taskView(task.id).state).toMatchObject({ kind: "legacy", state: "needs-bot", summary });
  expect(store.getTask(task.id)?.lead).toBeFalsy();
  expect(store.getSession(source.id)?.archivedAt).toBeNull();
});
