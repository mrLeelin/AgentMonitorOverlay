import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotLeadAppointmentInput, BotLeadOperationReceipt, BotLeadOperationView, BotLeadTaskView, HostErrorBody, ModelProfile, StudioBot, Workspace } from "@amo-studio/protocol";
import { mockCodexProvider, removeTempDir, startMockModel } from "@amo-studio/testkit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { managesTask } from "../../core/role.js";
import { HostError } from "../../core/shared.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { MCP_SESSION_HEADER, McpIdentities } from "../../mcp/identity.js";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { resolveCodexCommand } from "../../runtime/codex/command.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { CodexServerManager } from "../../runtime/codex/server-manager.js";
import { StaticCredentialReader } from "../../runtime/credentials.js";
import { HostService } from "../../service.js";
import { BotLeadStore } from "../../store/bot-leads.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "local", label: "Local", runtime: "codex", provider: null, model: "mock" }];
const route = "/api/bot-leads/appointments";
let root: string, store: Store, servers: FakeServers, runtime: CodexRuntime, host: HostService, http: HostServer, workspace: Workspace, bot: StudioBot, identities: McpIdentities;

async function boot(manager?: CodexServerManager, activeProfiles = profiles) {
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(profiles);
  identities = new McpIdentities(store);
  runtime = new CodexRuntime({ store, servers: manager ?? servers, profiles: activeProfiles, identities });
  host = new HostService(store, runtime, activeProfiles, { commonDir: join(root, "common") });
  http = await startHostServer({ service: host, token: "ui", mcpToken: "model", mcpIdentities: identities, port: 0 });
}

async function close() {
  host.removeAllListeners("event");
  await host.botLeads.flush();
  vi.spyOn(host.botLeads, "flush").mockResolvedValue();
  await http.close();
  await servers.close();
  store.close();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-bot-lead-test-"));
  await boot();
  workspace = store.addWorkspace({ name: "fixture", path: root });
  bot = host.bots.save({ name: "鲸鱼", purpose: "安排并验收", memory: "", workspaceId: workspace.id, profileId: "local", enabled: true, permission: "full-auto" });
});

afterEach(async () => {
  await close();
  vi.restoreAllMocks();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown, token = "ui") {
  const response = await fetch(`${http.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as T };
}

async function mcp<T>(sessionId: string, method: string, params?: unknown) {
  const response = await fetch(`${http.url}/mcp`, { method: "POST", headers: { authorization: "Bearer model", "content-type": "application/json",
    [MCP_SESSION_HEADER]: identities.tokenFor(sessionId), accept: "application/json, text/event-stream", connection: "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return await response.json() as { result?: T; error?: { code: number; message: string } };
}

const newRoot = (operationId = "appoint", source: BotLeadAppointmentInput["source"] = { kind: "manual" }) => ({
  operationId, source, intent: "create" as const, workspaceId: workspace.id, title: "完成使用说明", firstMessage: "请分配编写使用说明",
  topic: { topicTitle: "使用说明" }, botId: bot.id,
});

const makeBot = (name: string) => host.bots.save({ name, purpose: "接任主控", memory: "", workspaceId: workspace.id, profileId: "local", enabled: true });
const leadControl = (taskId: string, input: unknown) => api<BotLeadTaskView | HostErrorBody>("POST", `/api/tasks/${taskId}/bot-lead/control`, input);
const settled = async (operationId: string) => {
  await host.botLeads.flush();
  await vi.waitFor(() => expect(host.botLeads.operation(operationId).delivery?.stage).toBe("processed"));
};

it("serializes two replacement windows, preserves the old term and brings across a concurrent child delivery exactly once", async () => {
  const next = makeBot("接任甲"), contender = makeBot("接任乙");
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const previous = host.botLeads.currentTerm(accepted.taskId)!;
  const child = host.tasks.createTaskRecord({ title: "在途执行", workspaceId: workspace.id, topicId: accepted.topicId, managerTaskId: accepted.taskId });
  const worker = await host.tasks.addSession(child.id, { profileId: "local" });
  const before = store.getCanvas(accepted.topicId!)!;
  const held = store.updateSession(previous.sessionId!, { status: "running" });
  host.publish({ type: "session.upserted", session: held });
  const requests = [next, contender].map((bot, index) => ({ operationId: `replace-${index}`, action: "replace", expectedTerm: previous, botId: bot.id }));
  const replies = await Promise.all(requests.map((request) => leadControl(accepted.taskId, request)));
  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  const winner = requests[replies.findIndex((reply) => reply.status === 200)]!;
  expect(host.botLeads.taskView(accepted.taskId).state).toMatchObject({ term: { state: "handing-off" }, handoff: { operationId: winner.operationId } });
  expect(await leadControl(accepted.taskId, winner)).toEqual(replies.find((reply) => reply.status === 200));
  expect(() => host.botLeads.assertManagementSession(previous.sessionId!)).toThrow(/管理权限/);
  const result = host.orchestration.submit(worker.id, "在交接期间提交", "已核对文件");
  host.publish({ type: "session.upserted", session: store.updateSession(held.id, { status: "idle" }) });
  await settled(winner.operationId);
  const supervisor = host.botLeads.currentTerm(accepted.taskId)!;
  expect(supervisor).toMatchObject({ generation: 2, botId: winner.botId, taskId: accepted.taskId });
  expect(supervisor.handoff).toContain(result.id);
  await vi.waitFor(() => expect(store.findItems(supervisor.sessionId!, "user").filter((item) => item.type === "user" && item.raw?.method === "user/inbox" && item.text.includes(result.id) && !item.text.includes("用户交接摘要"))).toHaveLength(1));
  expect(host.orchestration.results(child.id).map((entry) => entry.id)).toEqual([result.id]);
  expect(host.botLeads.term(accepted.taskId, previous.termId)).toMatchObject({ state: "ended", name: bot.name });
  expect(store.getSession(previous.sessionId!)?.writer).toBe("archived");
  expect(store.getCanvas(accepted.topicId!)?.nodes).toEqual(before.nodes);
  expect((await leadControl(accepted.taskId, { ...winner, operationId: "late-window" })).status).toBe(409);
});

it("cancels a handoff while original approval is pending and preserves explicit pause through Bot and global switches", async () => {
  const next = makeBot("后来");
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  host.publish({ type: "session.upserted", session: store.updateSession(term.sessionId!, { status: "awaiting-approval" }) });
  const replacement = { action: "replace", expectedTerm: term, botId: next.id, operationId: "cancel-replacement" };
  expect((await leadControl(accepted.taskId, replacement)).status).toBe(200);
  expect((await leadControl(accepted.taskId, { action: "cancel-handoff", expectedTerm: term, handoffOperationId: replacement.operationId, operationId: "cancel-it" })).status).toBe(200);
  expect(host.botLeads.currentTerm(accepted.taskId)).toMatchObject({ termId: term.termId, state: "active" });
  store.updateSession(term.sessionId!, { status: "idle" });
  expect((await leadControl(accepted.taskId, { action: "pause", expectedTerm: term, operationId: "user-pause" })).status).toBe(200);
  await expect(host.bots.remove(bot.id)).rejects.toThrow(/还负责.*换任/);
  host.bots.patch(bot.id, { enabled: false });
  host.config.updateSettings({ botsEnabled: false });
  await expect(host.sessions.sendMessage(term.sessionId!, "旧窗口写入")).rejects.toThrow();
  expect(host.botLeads.taskView(accepted.taskId).state).toMatchObject({ term: { runState: "paused" } });
  host.config.updateSettings({ botsEnabled: true });
  host.bots.patch(bot.id, { enabled: true });
  await vi.waitFor(() => expect(host.sessions.isInterrupting(term.sessionId!)).toBe(false));
  await host.botLeads.flush();
  expect(host.botLeads.currentTerm(accepted.taskId)?.runState).toBe("paused");
  expect((await leadControl(accepted.taskId, { action: "resume", expectedTerm: term, operationId: "user-resume" })).status).toBe(200);
  await vi.waitFor(() => expect(host.botLeads.currentTerm(accepted.taskId)?.runState).toBe("idle"));
});

it("holds a running worker's submission across global and individual Bot shutdown, then delivers the same result once", async () => {
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  const child = host.tasks.createTaskRecord({ title: "关闭前开始的执行", workspaceId: workspace.id, topicId: accepted.topicId, managerTaskId: accepted.taskId });
  const worker = await host.tasks.addSession(child.id, { profileId: "local" });
  host.config.updateSettings({ botsEnabled: false });
  const result = host.orchestration.submit(worker.id, "安全收尾", "原会话可查看");
  const notices = () => store.findItems(term.sessionId!, "user").filter((item) => item.type === "user" && item.text.includes(result.id));
  await host.botLeads.flush();
  expect(notices()).toEqual([]);
  host.bots.patch(bot.id, { enabled: false });
  host.config.updateSettings({ botsEnabled: true });
  await host.botLeads.flush();
  expect(notices()).toEqual([]);
  host.bots.patch(bot.id, { enabled: true });
  await vi.waitFor(() => expect(notices()).toHaveLength(1));
  await host.botLeads.flush();
  expect(notices()).toHaveLength(1);
  expect(host.orchestration.results(child.id).map((record) => record.id)).toEqual([result.id]);
});

it("projects a missing model as paused after Host restart and keeps the same term when the model returns", async () => {
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  await close();
  await boot(undefined, []);
  expect(host.botLeads.taskView(accepted.taskId).state).toMatchObject({ term: { termId: term.termId, runState: "paused", reason: expect.stringContaining("模型渠道当前不可用") } });
  expect(() => host.botLeads.assertManagementSession(term.sessionId!)).toThrow(/模型渠道当前不可用/);
  await close();
  await boot();
  await host.botLeads.flush();
  expect(host.botLeads.taskView(accepted.taskId).state).toMatchObject({ term: { termId: term.termId, sessionId: term.sessionId, runState: "idle", generation: 1 } });
  expect(store.listSessions({ taskId: accepted.taskId })).toHaveLength(1);
});

it("binds a legacy tree atomically with different Bots", async () => {
  const next = makeBot("中控");
  const topic = host.topics.createTopic({ title: "旧专题", workspaceIds: [workspace.id] });
  const root = store.createTask({ title: "旧根", workspaceId: workspace.id, topicId: topic.id, lead: true });
  const middle = store.createTask({ title: "旧中控", workspaceId: workspace.id, topicId: topic.id, managerTaskId: root.id, lead: true });
  host.botLeads.repairLegacyTrees();
  expect(host.botLeads.taskView(root.id).state).toEqual({ kind: "legacy", state: "needs-bot" });
  expect((await api("POST", `/api/tasks/${root.id}/sessions`, { profileId: "local", text: "旧启动" })).status).toBe(409);
  const bindings = [{ taskId: root.id, botId: bot.id, expectedTerm: null }, { taskId: middle.id, botId: bot.id, expectedTerm: null }];
  const endpoint = `/api/tasks/${root.id}/bot-lead/legacy-bindings`;
  expect((await api("POST", endpoint, { operationId: "same-bot", bindings })).status).toBe(409);
  expect(new BotLeadStore(store).currentTerms()).toEqual([]);
  bindings[1]!.botId = next.id;
  const success = await api<BotLeadTaskView[]>("POST", endpoint, { operationId: "bind-tree", bindings });
  expect(success.status).toBe(200);
  expect(success.data.map((item) => item.taskId)).toEqual([root.id, middle.id]);
  expect(await api("POST", endpoint, { operationId: "bind-tree", bindings })).toEqual(success);
  expect((await leadControl(root.id, { action: "replace", expectedTerm: host.botLeads.currentTerm(root.id), botId: next.id, operationId: "same-as-child" })).status).toBe(409);
});

it("still lets a person accept the existing valid anonymous root delivery without starting the old lead", async () => {
  const topic = host.topics.createTopic({ title: "旧交付专题", workspaceIds: [workspace.id] });
  const task = store.createTask({ title: "待人工验收的旧根", workspaceId: workspace.id, topicId: topic.id, lead: true, column: "review" });
  const old = store.createSession({ taskId: task.id, topicId: null, workspaceId: workspace.id, parentId: null, kind: "main", runtime: "codex",
    title: "原交付会话", status: "idle", writer: "workbench", profileId: "local", runtimeRef: null });
  const at = new Date().toISOString();
  const saved = { id: "legacy-result", taskId: task.id, sessionId: old.id, managerTaskId: null, state: "submitted",
    summary: "原交付", verification: "原证据", createdAt: at, updatedAt: at };
  store.setKv(`task-results:${task.id}`, JSON.stringify([saved]));
  expect(await api("POST", `/api/tasks/${task.id}/workflow/user-review`, { resultId: saved.id, accept: true, review: "已核对历史交付" })).toMatchObject({
    status: 200, data: { id: saved.id, reviewedBy: "user", state: "accepted", sessionId: old.id },
  });
  expect(host.botLeads.taskView(task.id).state).toEqual({ kind: "legacy", state: "historical" });
  expect(store.listSessions({ taskId: task.id }).map((session) => session.id)).toEqual([old.id]);
});

it("keeps archived session and term history after deleting a formerly appointed Bot and resumes only after explicit replacement", async () => {
  const next = makeBot("归档后接任");
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  await host.topics.archiveTopic(accepted.topicId!);
  await expect(host.bots.remove(bot.id)).resolves.toEqual({ ok: true });
  await host.topics.unarchiveTopic(accepted.topicId!);
  expect(host.botLeads.currentTerm(accepted.taskId)?.runState).toBe("paused");
  expect(store.getSession(term.sessionId!)?.archivedAt).toBeTruthy();
  expect((await leadControl(accepted.taskId, { action: "replace", operationId: "after-archive", expectedTerm: term, botId: next.id })).status).toBe(200);
  await vi.waitFor(() => expect(host.botLeads.currentTerm(accepted.taskId)).toMatchObject({ botId: next.id, runState: "paused", sessionId: null, generation: 2 }));
  expect(host.botLeads.term(accepted.taskId, term.termId)).toMatchObject({ name: bot.name, generation: 1, state: "ended" });
  const successor = host.botLeads.currentTerm(accepted.taskId)!;
  expect((await leadControl(accepted.taskId, { action: "resume", operationId: "resume-archive", expectedTerm: successor })).status).toBe(200);
  await settled("after-archive");
  expect(store.listSessions({ taskId: accepted.taskId }).map((session) => session.botLeadTerm?.generation).sort()).toEqual([1, 2]);
});

it("lists a cyclic legacy management chain and removes the anomaly after a user repairs one edge", async () => {
  const topic = host.topics.createTopic({ title: "异常链专题" });
  const a = store.createTask({ title: "异常甲", workspaceId: workspace.id, topicId: topic.id, lead: true });
  const b = store.createTask({ title: "异常乙", workspaceId: workspace.id, topicId: topic.id, lead: true, managerTaskId: a.id });
  store.updateTask(a.id, { managerTaskId: b.id });
  const before = await api("GET", "/api/bot-leads/legacy-issues");
  expect(before).toEqual({ status: 200, data: expect.arrayContaining([
    expect.objectContaining({ taskId: b.id, reason: expect.stringContaining("环") }),
    expect.objectContaining({ taskId: a.id, reason: expect.stringContaining("环") }),
  ]) });
  expect((await api("PATCH", `/api/tasks/${a.id}`, { managerTaskId: null })).status).toBe(200);
  expect(await api("GET", "/api/bot-leads/legacy-issues")).toEqual({ status: 200, data: [] });
});

it("requires a real appointment for old REST and creates a middle lead together with its formal card", async () => {
  const next = makeBot("新中控");
  const ordinary = await api<{ task: { id: string } }>("POST", "/api/tasks", { title: "普通执行", workspaceId: workspace.id });
  expect(ordinary.status).toBe(200);
  for (const result of [
    await api<HostErrorBody>("POST", "/api/tasks", { title: "匿名旧主控", workspaceId: workspace.id, lead: true }),
    await api<HostErrorBody>("PATCH", `/api/tasks/${ordinary.data.task.id}`, { lead: true }),
  ]) expect(result).toMatchObject({ status: 409, data: { error: { details: { reason: "appointment-required", action: "select-bot" } } } });
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  const propose = (botId: string) => host.taskPlans.propose(term.sessionId!, { summary: "拆出一项中控", tasks: [{ title: "负责界面", lead: true, leadBotId: botId }] });
  await expect(propose(bot.id)).rejects.toThrow(/不同机器人/);
  expect(store.listTasks().filter((task) => task.managerTaskId === accepted.taskId)).toEqual([]);
  const plan = await propose(next.id);
  expect(plan.state).toBe("accepted");
  const taskId = plan.created![0]!.taskId;
  const middle = host.botLeads.currentTerm(taskId);
  expect(middle).toMatchObject({ botId: next.id, generation: 1, source: { kind: "task-plan", planId: plan.id } });
  expect(store.getCanvas(accepted.topicId!)?.nodes).toContainEqual(expect.objectContaining({ kind: "task", taskId }));
});

it("starts a middle lead with the accepted prerequisite delivery after it stops waiting", async () => {
  const next = makeBot("有前置的中控");
  const accepted = host.botLeads.appoint(newRoot());
  await settled("appoint");
  const root = host.botLeads.currentTerm(accepted.taskId)!;
  const plan = await host.taskPlans.propose(root.sessionId!, { summary: "先调研再交给中控", tasks: [
    { key: "research", title: "确认现状" },
    { key: "middle", title: "执行移植", leadBotId: next.id, dependsOn: ["research"] },
  ] });
  const [research, middle] = plan.created!.map(({ taskId }) => taskId);
  await host.botLeads.flush();
  expect(host.botLeads.currentTerm(middle!)?.sessionId).toBeNull();
  await vi.waitFor(() => expect(store.listSessions({ taskId: research! })).toHaveLength(1));
  const worker = store.listSessions({ taskId: research! })[0]!;
  const result = host.orchestration.submit(worker.id, "前置确认", "查阅了源文件");
  host.orchestration.review(root.sessionId!, result.id, true, "已核对");
  await vi.waitFor(() => {
    const id = host.botLeads.currentTerm(middle!)?.sessionId;
    expect(id && store.findItems(id, "user").some((item) => item.type === "user" && item.text.includes(result.id))).toBe(true);
  });
  expect(host.sharedContext.prerequisites(middle!)).toEqual([result.id]);
});

function completedBotRequest(id: string) {
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO studio_bot_requests (id, bot_id, created_at, data, delivered) VALUES (?, ?, ?, ?, 1)")
    .run(id, bot.id, at, JSON.stringify({ id, botId: bot.id, botName: bot.name, text: "检查说明", result: "补充步骤", destination: "home", status: "completed", createdAt: at }));
}

it("commits one topic, one formal card and one pending term before a read-only runtime call", async () => {
  const start = vi.spyOn(runtime, "startSession");
  const body = newRoot();
  const accepted = host.botLeads.appoint(body);
  expect(start).not.toHaveBeenCalled();
  expect(accepted).toMatchObject({ action: "create", state: { kind: "appointed", term: { runState: "pending", sessionId: null } } });
  expect(host.botLeads.appoint({ ...body })).toEqual(accepted);
  const state = host.snapshot().tasks.find((task) => task.id === accepted.taskId);
  expect(state?.botLead).toEqual(accepted.action === "create" ? accepted.state : null);
  expect(host.canvases.canvas(accepted.topicId!).nodes).toEqual([expect.objectContaining({ kind: "task", taskId: accepted.taskId })]);
  expect(await api<HostErrorBody>("POST", route, { ...body, title: "不同目标" })).toMatchObject({ status: 409, data: { error: { details: { reason: "operation-conflict" } } } });
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  expect(start.mock.calls[0]?.[0]).toMatchObject({ leadSessionId: term.sessionId, options: { permission: "read-only" } });
  const threadStart = servers.fakes.get("local")?.calls.find((call) => call.method === "thread/start");
  expect(threadStart?.params).toMatchObject({
    sandbox: "read-only",
    developerInstructions: expect.stringMatching(/搜索.*mcp__amo.*amo_whoami/s),
  });
  const instructions = (threadStart?.params as { developerInstructions: string }).developerInstructions;
  for (const name of ["task_plan_propose", "task_workflow", "task_review_result", "task_submit_result", "decision_request"]) expect(instructions).toContain(name);
  await vi.waitFor(async () => expect((await api<BotLeadOperationView>("GET", "/api/bot-leads/operations/appoint")).data.delivery?.stage).toBe("processed"));
  expect(store.listSessions({ taskId: accepted.taskId })).toEqual([expect.objectContaining({ botLeadTerm: { termId: term.termId, generation: 1, botId: bot.id, name: bot.name } })]);
});

it("rolls back the task, topic, card and acceptance if formal card creation fails", () => {
  const source = { kind: "bot-request", requestId: "atomic" } as const;
  completedBotRequest(source.requestId);
  const before = host.snapshot();
  const canvas = vi.spyOn(host.canvases, "ensureManagementCards").mockImplementationOnce(() => { throw new Error("card write fault"); });
  expect(() => host.botLeads.appoint(newRoot("atomic-op", source))).toThrow("card write fault");
  expect(host.snapshot().tasks).toEqual(before.tasks);
  expect(host.snapshot().topics).toEqual(before.topics);
  expect(new BotLeadStore(store).requestAcceptance(source.requestId)).toBeNull();
  expect(new BotLeadStore(store).currentTerms()).toEqual([]);
  expect(() => host.botLeads.operation("atomic-op")).toThrow("找不到已受理的操作");
  canvas.mockRestore();
  expect(host.botLeads.appoint(newRoot("atomic-op", source)).action).toBe("create");
});

it("reuses a Bot created under the same operation after the appointment commit fails", () => {
  const { botId: _existing, ...base } = newRoot("create-bot-then-appoint");
  const input = { ...base, newBot: { name: "海豚", purpose: "安排测试", memory: "", workspaceId: workspace.id, profileId: "local", enabled: true } };
  vi.spyOn(host.canvases, "ensureManagementCards").mockImplementationOnce(() => { throw new Error("first commit failed"); });
  expect(() => host.botLeads.appoint(input)).toThrow("first commit failed");
  const prepared = new BotLeadStore(store).operation(input.operationId);
  expect(prepared?.botId).toBeTruthy();
  const receipt = host.botLeads.appoint(input);
  expect(host.botLeads.currentTerm(receipt.taskId)?.botId).toBe(prepared?.botId);
  expect(store.db.prepare("SELECT count(*) AS count FROM studio_bots WHERE name_key = '海豚'").get()).toEqual({ count: 1 });
});

it("arbitrates the old worker and lead actions for the same source and preserves the winning receipt", async () => {
  completedBotRequest("lead-wins");
  const source = { kind: "bot-request", requestId: "lead-wins" } as const;
  const [lead, worker] = await Promise.all([
    api<BotLeadOperationReceipt>("POST", route, newRoot("lead-op", source)),
    api<HostErrorBody>("POST", "/api/bot-requests/lead-wins/worker", { operationId: "worker-op" }),
  ]);
  expect(lead.status).toBe(200);
  expect(worker).toMatchObject({ status: 409, data: { error: { details: { reason: "source-already-accepted", receipt: lead.data } } } });
  expect(host.bots.requests(null).find((request) => request.id === source.requestId)?.acceptance).toEqual(lead.data);
  expect(host.botLeads.appoint(newRoot("second-window", source))).toEqual(lead.data);
  expect(host.botLeads.appoint({ ...newRoot("explicit-new-goal", source), sourceUse: "new-goal" }).taskId).not.toBe(lead.data.taskId);

  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"], { cwd: root });
  completedBotRequest("worker-wins");
  const winner = await api<{ receipt: BotLeadOperationReceipt }>("POST", "/api/bot-requests/worker-wins/worker", { operationId: "original-worker" });
  expect(winner.status).toBe(200);
  expect(host.botLeads.appoint(newRoot("loses-to-worker", { kind: "bot-request", requestId: "worker-wins" }))).toEqual(winner.data.receipt);
});

it("requires user-route provenance, binds a source to its real message, and keeps model tokens out of appointments", async () => {
  const original = store.createTask({ workspaceId: workspace.id, title: "原任务" });
  const session = await host.tasks.addSession(original.id, { profileId: "local" });
  const synthetic = store.appendItem({ id: "synthetic", sessionId: session.id, type: "user", createdAt: new Date().toISOString(), text: "模型建议带队" });
  expect(await api<HostErrorBody>("POST", route, newRoot("fake", { kind: "user-message", sessionId: session.id, messageId: synthetic.id }))).toMatchObject({ status: 409, data: { error: { code: "read_only" } } });
  expect((await api("POST", route, newRoot(), "model")).status).toBe(401);
  expect((await api("POST", `/api/sessions/${session.id}/messages`, { text: "我想请鲸鱼带队" })).status).toBe(200);
  const item = store.findItems(session.id, "user", { fromPerson: true }).at(-1)!;
  expect(item).toMatchObject({ type: "user", fromPerson: true });
  const other = await host.tasks.addSession(original.id, { profileId: "local" });
  expect(await api<HostErrorBody>("POST", route, newRoot("mismatch", { kind: "user-message", sessionId: other.id, messageId: item.id }))).toMatchObject({ status: 409, data: { error: { code: "read_only" } } });
  const accepted = await api<BotLeadOperationReceipt>("POST", route, newRoot("genuine", { kind: "user-message", sessionId: session.id, messageId: item.id }));
  expect(accepted.status).toBe(200);
  expect(host.botLeads.currentTerm(accepted.data.taskId)?.handoff).toContain("我想请鲸鱼带队");
});

it("cold-recovers a filed intent and explicitly retries a failed runtime start on the same term", async () => {
  const running = vi.spyOn(host.botLeads, "flush").mockResolvedValue();
  const accepted = host.botLeads.appoint(newRoot());
  await close();
  running.mockRestore();
  await boot();
  const start = vi.spyOn(runtime, "startSession").mockRejectedValueOnce(new Error("injected launch failure"));
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(accepted.taskId)!;
  expect(term).toMatchObject({ runState: "failed", reason: "injected launch failure", sessionId: null });
  const retry = { operationId: "retry-op", action: "retry-start", expectedTerm: { termId: term.termId, generation: term.generation } };
  const reply = await api<BotLeadTaskView>("POST", `/api/tasks/${accepted.taskId}/bot-lead/control`, retry);
  expect(reply.status).toBe(200);
  await host.botLeads.flush();
  expect(start).toHaveBeenCalledTimes(2);
  expect(host.botLeads.currentTerm(accepted.taskId)).toMatchObject({ termId: term.termId, generation: 1, sessionId: expect.any(String) });
  expect(store.listSessions({ taskId: accepted.taskId })).toHaveLength(1);
  expect(host.canvases.canvas(accepted.topicId!).nodes).toHaveLength(1);
});

it("reports a real missing Codex executable on the original Bot request and retries the same term", async () => {
  const native = resolveCodexCommand();
  const missing = join(root, "absent-codex.exe");
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome);
  const model = await startMockModel();
  const activeProfiles: ModelProfile[] = [{ ...profiles[0]!, provider: "amo-mock", model: "mock-model", credentialId: "mock" }];
  const dataDir = join(root, "codex");
  const options = { dataDir, profiles: activeProfiles, credentials: new StaticCredentialReader({ mock: "mock-key" }), cwd: root,
    env: { CODEX_HOME: codexHome }, providers: { "amo-mock": mockCodexProvider(model.baseUrl) }, mcp: () => ({ url: `${http.url}/mcp`, token: "model" }) };
  let manager = new CodexServerManager(options);
  const uncaught = vi.fn();
  process.on("uncaughtExceptionMonitor", uncaught);
  try {
    await close();
    await boot(manager, activeProfiles);
    vi.stubEnv("AMO_STUDIO_CODEX", missing);
    completedBotRequest("native-spawn-request");
    const input = newRoot("native-spawn", { kind: "bot-request", requestId: "native-spawn-request" });
    const start = performance.now();
    const accepted = await api<BotLeadOperationReceipt>("POST", route, input);
    expect(accepted).toMatchObject({ status: 200, data: { action: "create", state: { term: { runState: "pending" } } } });
    const taskId = accepted.data.taskId;
    const view = `/api/tasks/${taskId}/bot-lead`;
    const termId = host.botLeads.currentTerm(taskId)!.termId;
    await vi.waitFor(async () => {
      const failed = (await api<BotLeadTaskView>("GET", view)).data.state;
      expect(failed).toMatchObject({ kind: "appointed", term: { termId, generation: 1, runState: "failed", sessionId: null,
        reason: expect.stringContaining(missing) } });
      if (failed?.kind === "appointed") expect(failed.term.reason).toMatch(/ENOENT.*找不到可执行文件/);
    }, { timeout: 5000 });
    expect(performance.now() - start).toBeLessThan(5000);
    expect(uncaught).not.toHaveBeenCalled();
    expect(manager.handle("local")).toBeNull();
    expect(store.listSessions({ taskId })).toHaveLength(0);
    expect((await api<BotLeadOperationView>("GET", "/api/bot-leads/operations/native-spawn")).data.delivery)
      .toMatchObject({ stage: "failed", reason: expect.stringContaining("ENOENT") });
    expect(host.snapshot().tasks.find((task) => task.id === taskId)?.botLead)
      .toMatchObject({ kind: "appointed", term: { termId, runState: "failed", reason: expect.stringContaining(missing) } });

    await close();
    await manager.stopAll();
    vi.unstubAllEnvs();
    manager = new CodexServerManager({ ...options, codexCommand: { ...native, prefixArgs: [...native.prefixArgs, "-c", "features.plugins=false"] } });
    await boot(manager, activeProfiles);
    expect((await api("POST", `${view}/control`, { operationId: "retry-native-spawn", action: "retry-start", expectedTerm: { termId, generation: 1 } })).status).toBe(200);
    await vi.waitFor(async () => {
      const delivery = (await api<BotLeadOperationView>("GET", "/api/bot-leads/operations/native-spawn")).data.delivery;
      expect(delivery?.stage, delivery?.reason).toBe("processed");
    }, { timeout: 10_000 });
    await vi.waitFor(async () => expect((await api<BotLeadTaskView>("GET", view)).data.state)
      .toMatchObject({ kind: "appointed", term: { termId, generation: 1, sessionId: expect.any(String), runState: "idle" } }));
    expect(store.listSessions({ taskId })).toHaveLength(1);
    expect(host.canvases.canvas(accepted.data.topicId!).nodes).toEqual([expect.objectContaining({ kind: "task", taskId })]);
    expect(uncaught).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    process.off("uncaughtExceptionMonitor", uncaught);
    await manager.stopAll();
    await model.close();
  }
}, 30_000);

it("reconciles the exact reserved session after its host crashed before binding it", async () => {
  const recovery = vi.spyOn(host.botLeads, "flush").mockResolvedValue();
  const accepted = host.botLeads.appoint(newRoot());
  const records = new BotLeadStore(store);
  const term = records.currentTerm(accepted.taskId)!;
  const id = "s-reserved-fixture";
  records.reserveLaunch(term.termId, id);
  records.setRunState(term.termId, "starting");
  await runtime.startSession({ taskId: term.taskId, topicId: null, profileId: "local", workspace, options: { permission: "read-only" }, leadSessionId: id });
  recovery.mockRestore();
  const start = vi.spyOn(runtime, "startSession");
  await host.botLeads.flush();
  expect(start).not.toHaveBeenCalled();
  expect(host.botLeads.currentTerm(accepted.taskId)?.sessionId).toBe(id);
  expect(store.listSessions({ taskId: accepted.taskId })).toHaveLength(1);
});

it("reuses a reservation that never crossed the runtime boundary and reconciles an uncertain external start", async () => {
  const a = host.botLeads.appoint(newRoot("before-native"));
  const b = host.botLeads.appoint(newRoot("unknown-native"));
  const records = new BotLeadStore(store);
  const before = records.currentTerm(a.taskId)!;
  const unknown = records.currentTerm(b.taskId)!;
  records.reserveLaunch(before.termId, "s-before-native");
  records.reserveLaunch(unknown.termId, "s-unknown-native");
  records.setRunState(unknown.termId, "starting");
  const start = vi.spyOn(runtime, "startSession");
  await host.botLeads.flush();
  expect(start).toHaveBeenCalledTimes(1);
  expect(host.botLeads.currentTerm(a.taskId)?.sessionId).toBe("s-before-native");
  expect(host.botLeads.currentTerm(b.taskId)).toMatchObject({ termId: unknown.termId, runState: "needs-reconciliation", sessionId: null });
  expect(host.botLeads.operation("unknown-native").delivery?.stage).toBe("needs-reconciliation");
});

it("preserves an existing task, manager, topic, handoff evidence and blocks a late old tool", async () => {
  execFileSync("git", ["init", "-q"], { cwd: root });
  const topic = host.topics.createTopic({ title: "已有专题", workspaceIds: [workspace.id] });
  const manager = store.createTask({ title: "旧主控", workspaceId: workspace.id, topicId: topic.id, lead: true });
  const task = store.createTask({ title: "专项", workspaceId: workspace.id, topicId: topic.id, managerTaskId: manager.id });
  const old = await host.tasks.addSession(task.id, { profileId: "local", options: { permission: "full-auto" } });
  const cached = amoToolsFor(host, { sessionId: old.id }).find((tool) => tool.name === "task_note_add")!;
  const bg = store.appendItem({ id: "running-command", sessionId: old.id, createdAt: new Date().toISOString(),
    type: "background", taskId: "native-command", command: "check files", startedAt: new Date().toISOString(), state: "running" });
  const held = store.appendItem({ id: "retained-for-handoff", sessionId: old.id, createdAt: new Date().toISOString(),
    type: "user", text: "将这条消息放进交接", fromPerson: true, afterTurn: true, delivery: "unsent" });
  host.botLeads.appoint({ operationId: "upgrade", intent: "upgrade", taskId: task.id, expectedTerm: null, botId: bot.id, source: { kind: "manual" }, summary: "保留文件与证据" });
  expect(host.botLeads.taskView(task.id).state).toMatchObject({ kind: "pending-upgrade", blockers: [
    { kind: "background-command", sessionId: old.id }, { kind: "unsent-message", sessionId: old.id, itemId: held.id },
  ] });
  expect((await api("DELETE", `/api/sessions/${old.id}/items/${held.id}/queued?retain=lead-handoff`)).status).toBe(200);
  await host.botLeads.flush();
  expect(host.botLeads.currentTerm(task.id)).toBeNull();
  if (bg.type !== "background") throw new Error("wrong fixture");
  host.publish({ type: "item.updated", item: store.replaceItem({ ...bg, state: "completed" }) });
  writeFileSync(join(root, "uncommitted.txt"), "pending");
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(task.id)!;
  expect(term.handoff).toContain(old.id);
  expect(term.handoff).toContain("uncommitted.txt");
  expect(term.handoff).toContain("将这条消息放进交接");
  expect(store.getItem(held.id)).toMatchObject({ delivery: "expired" });
  expect(store.getTask(task.id)).toMatchObject({ topicId: topic.id, managerTaskId: manager.id, lead: true });
  expect(store.getSession(old.id)).toMatchObject({ writer: "archived" });
  expect(await cached.run({ text: "迟到的写入" })).toHaveProperty("isError", true);
  expect(amoToolsFor(host, { sessionId: term.sessionId! }).map((tool) => tool.name)).toContain("task_plan_propose");
  await expect(host.sessions.fork(term.sessionId!)).rejects.toMatchObject({ code: "read_only" });
  await expect(host.sessions.terminal(term.sessionId!, false)).rejects.toMatchObject({ code: "read_only" });
  expect(() => host.tasks.patchTask(task.id, { lead: false })).toThrow("已有机器人任期");
});

it("lists and executes current-term MCP writes over HTTP, then rejects the same call once paused", async () => {
  const receipt = host.botLeads.appoint(newRoot());
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(receipt.taskId)!;
  const active = term.sessionId!;
  const listing = await mcp<{ tools: { name: string }[] }>(active, "tools/list");
  expect(listing.result?.tools.map((tool) => tool.name)).toContain("task_plan_propose");
  expect(listing.result?.tools.map((tool) => tool.name)).not.toContain("task_set_lead");
  const write = { name: "task_note_add", arguments: { text: "现任主控进度" } };
  expect((await mcp<{ isError?: boolean }>(active, "tools/call", write)).result?.isError).not.toBe(true);
  expect(store.listTaskNotes(receipt.taskId)).toEqual([expect.objectContaining({ text: write.arguments.text })]);
  host.botLeads.control(receipt.taskId, { operationId: "pause-mcp", action: "pause", expectedTerm: term });
  const late = await mcp<{ isError?: boolean }>(active, "tools/call", write);
  expect(late.error ?? late.result?.isError).toBeTruthy();
  expect(store.listTaskNotes(receipt.taskId)).toHaveLength(1);
});

it("cancels a pending upgrade before handoff and leaves the original session writable", async () => {
  const task = store.createTask({ title: "保留的执行工作", workspaceId: workspace.id });
  const original = await host.tasks.addSession(task.id, { profileId: "local" });
  store.updateSession(original.id, { writer: "terminal-shared" });
  const request = { operationId: "upgrade-again", intent: "upgrade", taskId: task.id, expectedTerm: null, botId: bot.id, source: { kind: "manual" }, summary: "先留原会话" };
  host.botLeads.appoint(request);
  expect(host.botLeads.taskView(task.id).state).toMatchObject({ blockers: [{ kind: "terminal", sessionId: original.id }] });
  const cancelled = host.botLeads.control(task.id, { operationId: "cancel", action: "cancel-handoff", expectedTerm: null, handoffOperationId: "upgrade-again" });
  expect(cancelled.state).toBeNull();
  await host.botLeads.flush();
  expect(store.getSession(original.id)?.archivedAt).toBeNull();
  expect(host.botLeads.currentTerm(task.id)).toBeNull();
});

it("queues independent continuation messages for the chosen term and pauses before delivery", async () => {
  const receipt = host.botLeads.appoint(newRoot());
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(receipt.taskId)!;
  const expectedTerm = { termId: term.termId, generation: term.generation };
  const cached = amoToolsFor(host, { sessionId: term.sessionId! }).find((tool) => tool.name === "task_plan_propose")!;
  host.botLeads.control(receipt.taskId, { operationId: "pause", action: "pause", expectedTerm });
  await vi.waitFor(() => {
    expect(host.sessions.inbox.isPaused(term.sessionId!)).toBe(true);
    expect(host.sessions.isInterrupting(term.sessionId!)).toBe(false);
  });
  expect(await cached.run({})).toHaveProperty("isError", true);
  completedBotRequest("followup");
  const continuation = { operationId: "append", intent: "continue", taskId: receipt.taskId, expectedTerm, purpose: "work", text: "补查窄屏",
    source: { kind: "bot-request", requestId: "followup" } };
  const appended = host.botLeads.appoint(continuation);
  expect(host.botLeads.appoint({ ...continuation, operationId: "append-again" })).toEqual(appended);
  await host.botLeads.flush();
  expect(host.botLeads.operation("append").delivery?.stage).toBe("queued");
  host.botLeads.control(receipt.taskId, { operationId: "resume", action: "resume", expectedTerm });
  await vi.waitFor(() => expect(host.botLeads.operation("append").delivery?.stage).toBe("processed"));
  expect(store.findItems(term.sessionId!, "user").filter((item) => item.type === "user" && item.text.includes("补查窄屏"))).toHaveLength(1);
});

it("keeps two appointments of the same Bot in separate management scopes", async () => {
  const first = host.botLeads.appoint(newRoot("first-topic"));
  const second = host.botLeads.appoint({ ...newRoot("second-topic"), title: "另一个使用说明" });
  await host.botLeads.flush();
  const a = host.botLeads.currentTerm(first.taskId)!;
  const b = host.botLeads.currentTerm(second.taskId)!;
  const child = host.tasks.createTaskRecord({ title: "实际编写", workspaceId: workspace.id, topicId: second.topicId, managerTaskId: b.taskId });
  expect(a.botId).toBe(b.botId);
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(managesTask(host, a.sessionId!, child.id)).toBe(false);
  expect(managesTask(host, b.sessionId!, child.id)).toBe(true);
  expect(host.bots.sidebar().workers).toEqual([]);
});

it("checks deferred work before creating a session and leaves ordinary local starts available", async () => {
  const restricted = store.createTask({ title: "有限定工作树的任务", workspaceId: workspace.id });
  const plain = store.createTask({ title: "普通本地任务", workspaceId: workspace.id });
  vi.spyOn(host.taskPlans.worktrees, "assertStartable").mockImplementation((id, _cwd, work) => {
    if (id === restricted.id && work) throw new HostError("conflict", "工作树尚未接入");
  });
  const start = vi.spyOn(runtime, "startSession");
  await expect(host.tasks.addSession(restricted.id, { profileId: "local", text: "重新开工", purpose: "reopen" })).rejects.toThrow("工作树尚未接入");
  expect(start).not.toHaveBeenCalled();
  expect(store.listSessions({ taskId: restricted.id })).toHaveLength(0);
  expect((await host.tasks.addSession(plain.id, { profileId: "local", text: "普通回合" })).taskId).toBe(plain.id);
});

it("passes the confirmed prerequisite scope to the first turn without overriding the worktree gate", async () => {
  const topic = host.topics.createTopic({ title: "提早开工", workspaceIds: [workspace.id] });
  const make = (title: string) => host.tasks.createTaskRecord({ title, topicId: topic.id, workspaceId: workspace.id });
  const before = make("尚未完成的前置");
  const task = make("用户确认开工");
  host.canvases.canvasPlaceTask(before.id, null);
  host.canvases.canvasPlaceTask(task.id, null);
  host.canvases.canvasAddDependency(before.id, task.id);
  const endpoint = `/api/tasks/${task.id}/sessions`;
  const input = { profileId: "local", text: "执行第一轮" };
  expect((await api("POST", endpoint, input)).status).toBe(409);
  const check = vi.spyOn(host.taskPlans.worktrees, "assertStartable").mockImplementation((id, _cwd, work) => {
    if (id === task.id && work) throw new HostError("conflict", "仍缺实际改动");
  });
  expect((await api<HostErrorBody>("POST", endpoint, { ...input, confirmed: true })).data.error.message).toBe("仍缺实际改动");
  expect(store.listSessions({ taskId: task.id })).toHaveLength(0);
  check.mockRestore();
  expect((await api("POST", endpoint, { ...input, confirmed: true })).status).toBe(200);
  expect(store.listTaskNotes(task.id).some((note) => note.text.includes("确认提前开始"))).toBe(true);
});

it("keeps a previous execution directory as evidence while the appointed lead starts read-only in the project", async () => {
  const task = store.createTask({ title: "由执行转主控", workspaceId: workspace.id });
  const checkout = join(root, "old-checkout");
  const original = store.createSession({ taskId: task.id, topicId: null, workspaceId: workspace.id, parentId: null, kind: "main", runtime: "codex",
    title: "原执行", status: "idle", writer: "workbench", profileId: "local", runtimeRef: null, cwd: checkout });
  vi.spyOn(host.taskPlans.worktrees, "assertStartable").mockImplementation((id, cwd) => {
    if (id === task.id && cwd !== checkout) throw new HostError("conflict", "执行须使用原工作树");
  });
  host.botLeads.appoint({ operationId: "handoff-checkout", intent: "upgrade", taskId: task.id, expectedTerm: null, source: { kind: "manual" }, botId: bot.id, summary: "保留执行证据" });
  await host.botLeads.flush();
  const term = host.botLeads.currentTerm(task.id)!;
  expect(term.handoff).toContain(checkout);
  expect(store.getSession(original.id)?.archivedAt).toBeTruthy();
  expect(store.getSession(term.sessionId!)).toMatchObject({ options: { permission: "read-only" } });
  await vi.waitFor(() => expect(host.botLeads.operation("handoff-checkout").delivery?.stage).toBe("processed"));
});

it("rechecks a worktree at the native start boundary before sending thread/start", async () => {
  const task = store.createTask({ title: "检查异步启动", workspaceId: workspace.id });
  const handle = await servers.ensure("local");
  const request = vi.spyOn(handle.client, "request");
  let permitted = true;
  vi.spyOn(host.taskPlans.worktrees, "assertStartable").mockImplementation((id) => {
    if (id === task.id && !permitted) throw new HostError("conflict", "启动前工作树已变化");
  });
  const start = runtime.startSession.bind(runtime);
  vi.spyOn(runtime, "startSession").mockImplementationOnce((input) => {
    permitted = false;
    return start(input);
  });
  await expect(host.tasks.addSession(task.id, { profileId: "local", text: "尝试启动" })).rejects.toThrow("启动前工作树已变化");
  expect(request.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
  expect(store.listSessions({ taskId: task.id })).toHaveLength(0);
});

it("rechecks dispatch authority in real checkout allocation before Git creates another worktree", async () => {
  const cwd = join(root, "allocation-project");
  mkdirSync(cwd);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  git("commit", "--allow-empty", "-qm", "approved base");
  const project = store.addWorkspace({ name: "allocation-project", path: cwd });
  const task = store.createTask({ title: "权限变化前分出的任务", workspaceId: project.id });
  host.taskPlans.worktrees.assign(task, git("rev-parse", "HEAD"), []);
  let authorized = true;
  const prepare = host.taskPlans.worktrees.prepare.bind(host.taskPlans.worktrees);
  vi.spyOn(host.taskPlans.worktrees, "prepare").mockImplementationOnce((id, beforeAllocate) => prepare(id, () => {
    authorized = false;
    beforeAllocate?.();
  }));
  await expect(host.tasks.addSession(task.id, { profileId: "local", text: "派工内容" }, () => {
    if (!authorized) throw new HostError("conflict", "派工授权已变化");
  })).rejects.toThrow("派工授权已变化");
  expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  expect(store.listSessions({ taskId: task.id })).toHaveLength(0);
});

it("keeps a retryable message when execution eligibility changes inside the runtime", async () => {
  const task = store.createTask({ title: "检查重试边界", workspaceId: workspace.id });
  const session = await host.tasks.addSession(task.id, { profileId: "local" });
  const id = "retryable-worktree-message";
  store.appendItem({ id, sessionId: session.id, createdAt: new Date().toISOString(), type: "user", text: "重新执行", delivery: "unsent" });
  let permitted = true;
  vi.spyOn(host.taskPlans.worktrees, "assertStartable").mockImplementation((_id, _cwd, work) => {
    if (!permitted && work) throw new HostError("conflict", "接入需重新核对");
  });
  const resend = runtime.resend.bind(runtime);
  vi.spyOn(runtime, "resend").mockImplementationOnce((...args) => { permitted = false; return resend(...args); });
  await expect(host.sessions.resend(session.id, id)).rejects.toThrow("接入需重新核对");
  expect(store.getItem(id)).toMatchObject({ delivery: "unsent" });
  await expect(host.runtime.setGoal!(session.id, { objective: "恢复" })).rejects.toThrow("接入需重新核对");
  permitted = true;
  await host.sessions.resend(session.id, id);
  await vi.waitFor(() => expect(store.getItem(id)).toMatchObject({ raw: { turnId: expect.any(String) } }));
});

it("skips a blocked Codex thread during runtime recovery and reattaches it on an eligible retry", async () => {
  const task = store.createTask({ title: "恢复受限会话", workspaceId: workspace.id });
  const old = await host.tasks.addSession(task.id, { profileId: "local", text: "创建一轮可恢复的对话" });
  await vi.waitFor(() => expect(store.findItems(old.id, "turn", { state: "completed" })).toHaveLength(1));
  const handle = await servers.ensure("local");
  const request = vi.spyOn(handle.client, "request");
  const coldRuntime = new CodexRuntime({ store, servers, profiles, identities });
  let permitted = false;
  coldRuntime.setExecutionValidation((id) => {
    if (id === old.id && !permitted) throw new HostError("conflict", "恢复前需核对工作树");
  });
  const other = store.createTask({ title: "恢复期间的普通任务", workspaceId: workspace.id });
  await coldRuntime.startSession({ taskId: other.id, topicId: null, profileId: "local", workspace });
  const resumedOld = () => request.mock.calls.some(([method, params]) => method === "thread/resume" && (params as { threadId?: string }).threadId === old.runtimeRef);
  expect(resumedOld()).toBe(false);
  permitted = true;
  await coldRuntime.sendMessage(old.id, "接入后重试");
  expect(resumedOld()).toBe(true);
});
