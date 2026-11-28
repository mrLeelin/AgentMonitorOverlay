import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backup } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task, TaskResult } from "@amo-studio/protocol";
import { mockCodexProvider, removeTempDir, startMockModel } from "@amo-studio/testkit";
import { startHostServer, type HostServer } from "../../http/server.js";
import { MCP_SESSION_HEADER, McpIdentities } from "../../mcp/identity.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { resolveCodexCommand } from "../../runtime/codex/command.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { CodexRpcClient, type ParamsOf, type ServerNotification } from "../../runtime/codex/rpc-client.js";
import { CodexServerManager } from "../../runtime/codex/server-manager.js";
import { StaticCredentialReader } from "../../runtime/credentials.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
const crashConfig = process.env.AMO_TEST_REOPEN_CRASH_FIXTURE;
type CrashPhase = "before-inbox" | "after-turn-rpc";
type CrashFixture = { phase: CrashPhase; dbPath: string; checkpointPath: string; managerId: string; taskId: string; url: string; port: number; token: string };
const crashMessage = "从已经冻结的 B 恢复首轮";
let folder: string, store: Store, servers: FakeServers, service: HostService, http: HostServer, identities: McpIdentities;
let ancestor: Session, manager: Session, source: Session, downstream: Task, contextId: string;

async function call(session: Session, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${http.url}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-mcp", "content-type": "application/json", [MCP_SESSION_HEADER]: identities.tokenFor(session.id), accept: "application/json, text/event-stream", connection: "close" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await response.json() as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: { message: string } };
  return { error: body.error?.message ?? (body.result?.isError ? body.result.content[0]?.text : undefined), text: body.result?.content[0]?.text };
}

async function ok<T = unknown>(session: Session, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await call(session, name, args);
  expect(result.error).toBeUndefined();
  return JSON.parse(result.text!) as T;
}

async function openHost(dbPath: string, port = 0) {
  store = new Store(dbPath);
  identities = new McpIdentities(store);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles, identities }), profiles, { commonDir: join(folder, "common") });
  http = await startHostServer({ service, token: "fixture-ui", mcpToken: "fixture-mcp", mcpIdentities: identities, port });
}

const message = (session: Session, taskId: string, text: string, purpose: "work" | "reopen" | "inquiry") =>
  ok<{ relayId: string }>(session, "task_message", { taskId, text, purpose });
const basis = () => ({ contextId, version: 1 });
const submit = (session: Session, summary: string) => ok<TaskResult>(session, "task_submit_result", { summary, verification: "隔离 Host 验证证据" });
const review = (result: TaskResult, accept = true) => ok<TaskResult>(manager, "task_review_result", { resultId: result.id, accept, review: accept ? "通过" : "补齐验证" });
async function settled(session: Session, text: string) {
  await vi.waitFor(() => {
    expect(store.getSession(session.id)?.status).toBe("idle");
    expect(store.listItems(session.id).some((item) => item.type === "agent" && !item.streaming && item.markdown.includes(text))).toBe(true);
  });
}

beforeEach(async () => {
  if (crashConfig) return;
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-reopen-mcp-"));
  servers = new FakeServers(profiles);
  await openHost(join(folder, "studio.db"));
  const workspace = store.addWorkspace({ name: "隔离前置换版", path: folder });
  const topic = service.topics.createTopic({ title: "前置换版" });
  const root = store.createTask({ title: "总主控", workspaceId: workspace.id, topicId: topic.id, lead: true });
  const middle = store.createTask({ title: "直属主控", workspaceId: workspace.id, topicId: topic.id, managerTaskId: root.id, lead: true });
  const upstream = store.createTask({ title: "前置交付", workspaceId: workspace.id, topicId: topic.id, managerTaskId: middle.id });
  downstream = store.createTask({ title: "下游执行", workspaceId: workspace.id, topicId: topic.id, managerTaskId: middle.id });
  const rootBot = service.bots.save({ name: "总主控机器人", purpose: "核对共同需求", memory: "", workspaceId: workspace.id, profileId: "test", enabled: true });
  const managerBot = service.bots.save({ name: "直属主控机器人", purpose: "安排下游并验收", memory: "", workspaceId: workspace.id, profileId: "test", enabled: true });
  service.botLeads.bindLegacy(root.id, { operationId: "bind-reopen-fixture", bindings: [
    { taskId: root.id, botId: rootBot.id, expectedTerm: null }, { taskId: middle.id, botId: managerBot.id, expectedTerm: null },
  ] });
  service.canvases.canvasAddDependency(upstream.id, downstream.id);
  await vi.waitFor(() => {
    expect(service.botLeads.currentTerm(root.id)).toMatchObject({ sessionId: expect.any(String), runState: "idle" });
    expect(service.botLeads.currentTerm(middle.id)).toMatchObject({ sessionId: expect.any(String), runState: "idle" });
  });
  ancestor = store.getSession(service.botLeads.currentTerm(root.id)!.sessionId!)!;
  manager = store.getSession(service.botLeads.currentTerm(middle.id)!.sessionId!)!;
  source = await service.tasks.addSession(upstream.id, { profileId: "test" });
  const draft = service.sharedContext.save(ancestor.id, { rootTaskId: root.id, baseRevision: 0, title: "共同要求", body: "先核对已验收版本。", changeNote: "初版", sources: [{ kind: "user_requirement", source: "回归夹具" }] });
  const published = service.sharedContext.publishVersion(ancestor.id, draft.id, draft.revision);
  contextId = published.id;
  service.sharedContext.apply(ancestor.id, { ...basis(), taskIds: [upstream.id, downstream.id] });
  await ok(source, "context_get", {});
  await ok(source, "context_adopt", basis());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await http?.close();
  await servers?.close();
  store?.close();
  if (folder && !crashConfig) removeTempDir(folder);
});

async function startOnA() {
  const a = await review(await submit(source, "前置 A"));
  const start = await message(manager, downstream.id, "使用前置 A", "work");
  await vi.waitFor(() => expect(store.getRelay(start.relayId)?.state).toBe("delivered"));
  const old = store.getSession(store.getRelay(start.relayId)!.sessionId!)!;
  await settled(old, "使用前置 A");
  await ok(old, "context_adopt", basis());
  const previous = await review(await submit(old, "使用 A 的交付"));
  expect(previous.prerequisiteResultIds).toEqual([a.id]);
  return { a, old, previous };
}

async function replaceA(a: TaskResult) {
  await message(manager, source.taskId!, "前置重新开工", "reopen");
  await settled(source, "前置重新开工");
  expect(service.orchestration.results(source.taskId!).find((r) => r.id === a.id)?.state).toBe("returned");
  const submitted = await submit(source, "前置 B");
  expect(submitted.state).toBe("submitted");
  expect((await call(manager, "task_message", { taskId: downstream.id, text: "过早重开", purpose: "reopen" })).error).toContain("前置交付");
  const b = await review(submitted);
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([a.id]);
  return b;
}

it("explicitly reopens the same downstream task on B after its A-based session has already worked", async () => {
  const { a, old, previous } = await startOnA();
  const b = await replaceA(a);

  const continued = await message(manager, downstream.id, "普通继续", "work");
  await vi.waitFor(() => expect(store.getRelay(continued.relayId)?.error).toContain("启动时的前置交付依据已失效"));
  expect(store.listSessions({ taskId: downstream.id }).map((session) => session.id)).toEqual([old.id]);

  const args = { taskId: downstream.id, text: "使用前置 B 重新开始", purpose: "reopen" };
  expect((await call(ancestor, "task_message", args)).error).toContain("直属主控");
  const [reopen, simultaneous] = await Promise.all([message(manager, downstream.id, args.text, "reopen"), message(manager, downstream.id, args.text, "reopen")]);
  expect(simultaneous.relayId).toBe(reopen.relayId);
  await vi.waitFor(() => expect(store.getRelay(reopen.relayId)?.state).toBe("delivered"));
  const current = store.getSession(store.getRelay(reopen.relayId)!.sessionId!)!;
  expect(current.id).not.toBe(old.id);
  expect(store.getSession(old.id)).toMatchObject({ writer: "archived", archivedAt: expect.any(String) });
  await settled(current, "使用前置 B 重新开始");
  expect(await ok(manager, "task_message", args)).toMatchObject({ relayId: reopen.relayId, sessionId: current.id, state: "delivered" });
  expect(store.listSessions({ taskId: downstream.id })).toHaveLength(2);
  expect(servers.fakes.get("test")!.calls.filter((entry) => entry.method === "turn/start" && (entry.params as ParamsOf<"turn/start">).threadId === current.runtimeRef && JSON.stringify(entry.params).includes(args.text))).toHaveLength(1);
  expect(store.listItems(current.id).find((item) => item.type === "user" && item.id === `i-relay-${reopen.relayId}`)).toMatchObject({ text: expect.stringContaining(b.id) });
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([b.id]);
  expect(store.listItems(old.id).some((item) => item.type === "user" && item.text.includes(a.id))).toBe(true);
  expect(service.orchestration.results(downstream.id).find((r) => r.id === previous.id)).toMatchObject({ state: "returned", sessionId: old.id, prerequisiteResultIds: [a.id] });
  expect((await call(old, "task_submit_result", { summary: "旧会话冒用 B", verification: "无", prerequisiteResultIds: [b.id] })).error).toMatch(/归档|历史/);
  const staleItemId = `i-relay-${continued.relayId}`;
  const staleItem = store.getItem(staleItemId);
  expect(staleItem).toMatchObject({ sessionId: old.id, delivery: "unsent", text: expect.stringContaining(a.id) });
  const response = await fetch(`${http.url}/api/sessions/${old.id}/items/${staleItemId}/resend`, {
    method: "POST", headers: { authorization: "Bearer fixture-ui", connection: "close" },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("前置换版前的执行历史") } });
  expect(store.getItem(staleItemId)).toEqual(staleItem);
  expect(servers.fakes.get("test")!.calls.filter((entry) => entry.method === "turn/start" && (entry.params as ParamsOf<"turn/start">).threadId === old.runtimeRef && JSON.stringify(entry.params).includes("普通继续"))).toHaveLength(0);

  await ok(current, "context_adopt", basis());
  const result = await submit(current, "使用 B 的交付");
  expect(result).toMatchObject({ sessionId: current.id, state: "submitted", prerequisiteResultIds: [b.id], contextBasis: basis() });
  expect((await review(result)).state).toBe("accepted");
  const workflow = await ok<{ tasks: Array<{ taskId: string }> }>(manager, "task_workflow", { view: "summary" });
  expect(workflow.tasks.find((task) => task.taskId === downstream.id)).toMatchObject({ acceptedCurrent: true, prerequisiteResultIds: [b.id], sessions: [{ id: current.id }] });
});

it("leaves a running A session and its basis alone after B is accepted", async () => {
  const { a, old } = await startOnA();
  await message(manager, downstream.id, "[[slow]] 还在核对 A", "work");
  await vi.waitFor(() => expect(store.getSession(old.id)?.status).toBe("running"));
  await replaceA(a);
  const args = { taskId: downstream.id, text: "不要插入新依据", purpose: "reopen" };
  expect((await call(manager, "task_message", args)).error).toContain("仍在运行");
  expect(store.getSession(old.id)).toMatchObject({ status: "running", archivedAt: null });
  expect(store.listSessions({ taskId: downstream.id })).toHaveLength(1);
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([a.id]);
  await service.sessions.interrupt(old.id);
});

it("preserves A and permits a retry when the replacement session fails to start", async () => {
  const { a, old } = await startOnA();
  const b = await replaceA(a);
  vi.spyOn(service.runtime, "startSession").mockRejectedValueOnce(new Error("隔离模拟启动失败"));
  const failed = await message(manager, downstream.id, "改用 B", "reopen");
  await vi.waitFor(() => expect(store.getRelay(failed.relayId)).toMatchObject({ state: "failed", error: "隔离模拟启动失败" }));
  expect(store.getSession(old.id)?.archivedAt).toBeNull();
  expect(store.listSessions({ taskId: downstream.id })).toHaveLength(1);
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([a.id]);
  const retried = await message(manager, downstream.id, "改用 B", "reopen");
  await vi.waitFor(() => expect(store.getRelay(retried.relayId)?.state).toBe("delivered"));
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([b.id]);
});

it("rechecks the exact accepted input after creating the empty replacement and before changing the basis", async () => {
  const { a, old } = await startOnA();
  await replaceA(a);
  let release!: () => void;
  let provisioned!: (session: Session) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const empty = new Promise<Session>((resolve) => { provisioned = resolve; });
  const start = service.runtime.startSession.bind(service.runtime);
  vi.spyOn(service.runtime, "startSession").mockImplementationOnce(async (input, check) => {
    const session = await start(input, check);
    provisioned(session);
    await gate;
    return session;
  });
  const interrupted = await message(manager, downstream.id, "使用过期 B", "reopen");
  const staged = await empty;
  try {
    await message(manager, source.taskId!, "B 再次重开", "reopen");
    await settled(source, "B 再次重开");
    await review(await submit(source, "前置 C"));
  } finally {
    release();
  }
  await vi.waitFor(() => {
    expect(store.getRelay(interrupted.relayId)).toMatchObject({ state: "failed", error: expect.stringContaining("前置交付或共同需求已变化") });
    expect(store.getSession(staged.id)?.archivedAt).toEqual(expect.any(String));
  });
  expect(service.sharedContext.prerequisites(downstream.id)).toEqual([a.id]);
  expect(store.getSession(old.id)?.archivedAt).toBeNull();
  expect(store.getItem(`i-relay-${interrupted.relayId}`)).toBeUndefined();
});

it.skipIf(!crashConfig)("publishes the persisted reopen checkpoint for a forced Host exit", async () => {
  const fixture = JSON.parse(readFileSync(crashConfig!, "utf8")) as CrashFixture;
  folder = dirname(fixture.dbPath);
  servers = new FakeServers(profiles);
  const client = await CodexRpcClient.connect({ url: fixture.url, token: fixture.token });
  servers.handles.set("test", { profileId: "test", url: fixture.url, token: fixture.token, port: fixture.port, client });
  await openHost(fixture.dbPath);
  if (fixture.phase === "before-inbox") {
    const put = service.sessions.inbox.put.bind(service.sessions.inbox);
    vi.spyOn(service.sessions.inbox, "put").mockImplementation((sessionId, text, ...rest) => {
      if (!text.includes(crashMessage) || rest[0] !== fixture.managerId || !rest[1]?.startsWith("i-relay-")) return put(sessionId, text, ...rest);
      // The Studio session association is committed. Kill before the first input is saved or sent.
      expect(store.getRelay(rest[1].slice("i-relay-".length))).toMatchObject({ state: "pending", sessionId });
      writeFileSync(fixture.checkpointPath, JSON.stringify({ sessionId, itemId: rest[1] }));
      return new Promise(() => {});
    });
  } else {
    let firstThreadId: string | undefined;
    const emitter = client as unknown as { emit(event: string, ...args: unknown[]): boolean };
    const emit = emitter.emit.bind(emitter);
    vi.spyOn(emitter, "emit").mockImplementation((event, ...args) => {
      const notification = args[0] as { params?: { threadId?: string } } | undefined;
      return event === "notification" && firstThreadId && notification?.params?.threadId === firstThreadId ? true : emit(event, ...args);
    });
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation(async (method, params, ...rest) => {
      if (method !== "turn/start" || !JSON.stringify(params).includes(crashMessage)) return request(method, params, ...rest);
      firstThreadId = (params as { threadId: string }).threadId;
      await request(method, params as ParamsOf<"turn/start">, ...rest);
      const relay = store.listRelays().find((entry) => entry.text === crashMessage)!;
      const itemId = `i-relay-${relay.id}`;
      const input = store.getItem(itemId);
      expect(input).toMatchObject({ sessionId: relay.sessionId, type: "user" });
      // Codex clears the row's delivery flag immediately before the RPC. Its receipt is still pending.
      expect(input?.type === "user" && input.delivery).toBeUndefined();
      writeFileSync(fixture.checkpointPath, JSON.stringify({ sessionId: relay.sessionId, itemId }));
      return new Promise(() => {});
    });
  }
  const receipt = await message(store.getSession(fixture.managerId)!, fixture.taskId, crashMessage, "reopen");
  await vi.waitFor(() => {
    const relay = store.getRelay(receipt.relayId);
    if (relay?.state === "failed") return expect(relay.error).toBeUndefined();
    expect(existsSync(fixture.checkpointPath)).toBe(true);
  }, { timeout: 4_000 });
  await new Promise(() => {});
}, 25_000);

it.skipIf(!!crashConfig).each<CrashPhase>(["before-inbox", "after-turn-rpc"])("handles %s after forcibly terminating the isolated Host process", async (phase) => {
  const { a, old } = await startOnA();
  const b = await replaceA(a);
  const dbPath = join(folder, "crash-recovery.db");
  await backup(store.db, dbPath);
  const checkpointPath = join(folder, "checkpoint.json");
  const configPath = join(folder, "crash-fixture.json");
  const mock = await startMockModel();
  const codexHome = join(folder, "codex-home");
  mkdirSync(codexHome);
  const executable = resolveCodexCommand();
  const mcpUrl = `${http.url}/mcp`;
  const native = new CodexServerManager({
    dataDir: join(folder, "codex"), cwd: folder, env: { CODEX_HOME: codexHome }, portRange: [47940, 47949],
    profiles: [{ ...profiles[0]!, provider: "amo-mock", model: "mock-model", credentialId: "mock" }],
    credentials: new StaticCredentialReader({ mock: "mock-key" }), providers: { "amo-mock": mockCodexProvider(mock.baseUrl) },
    codexCommand: { ...executable, prefixArgs: [...executable.prefixArgs, "-c", "features.plugins=false"] },
    mcp: () => ({ url: mcpUrl, token: "fixture-mcp" }),
  });
  try {
    const handle = await native.ensure("test");
    writeFileSync(configPath, JSON.stringify({ phase, dbPath, checkpointPath, managerId: manager.id, taskId: downstream.id, url: handle.url, port: handle.port, token: handle.token } satisfies CrashFixture));
    const studio = fileURLToPath(new URL("../../../../../", import.meta.url));
    // Threads keep the runner and its fixture in the same child process, so a forced exit leaves no worker behind.
    const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "packages/host/src/features/relays/reopen-mcp.test.ts", "--pool=threads", "--maxWorkers=1", "-t", "publishes the persisted reopen checkpoint"], {
      cwd: studio, env: { ...process.env, AMO_TEST_REOPEN_CRASH_FIXTURE: configPath }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostic = "";
    child.stdout.on("data", (chunk) => { diagnostic += String(chunk); });
    child.stderr.on("data", (chunk) => { diagnostic += String(chunk); });
    const exited = once(child, "exit");
    let checkpoint!: { sessionId: string; itemId: string };
    try {
      await vi.waitFor(() => {
        if (child.exitCode !== null) throw new Error(`隔离 Host 提前退出：${diagnostic}`);
        expect(existsSync(checkpointPath), diagnostic).toBe(true);
        checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as typeof checkpoint;
      }, { timeout: 15_000 });
      if (phase === "before-inbox") expect(mock.requests.filter((request) => JSON.stringify(request).includes(crashMessage))).toHaveLength(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    expect(child.signalCode).toBe("SIGKILL");

    await http.close();
    await servers.close();
    store.close();
    servers = new FakeServers(profiles);
    const relayId = checkpoint.itemId.slice("i-relay-".length);
    const persisted = new Store(dbPath);
    let runtimeRef: string | null;
    try {
      expect(persisted.getRelay(relayId)).toMatchObject({ state: "pending", sessionId: checkpoint.sessionId });
      if (phase === "before-inbox") expect(persisted.getItem(checkpoint.itemId)).toBeUndefined();
      else expect(persisted.getItem(checkpoint.itemId)).toMatchObject({ sessionId: checkpoint.sessionId, type: "user" });
      runtimeRef = persisted.getSession(checkpoint.sessionId)!.runtimeRef;
    } finally {
      persisted.close();
    }
    const client = await CodexRpcClient.connect({ url: handle.url, token: handle.token });
    const request = client.request.bind(client);
    const rpc: Array<{ method: string; accepted: boolean; reason?: string }> = [];
    const events: string[] = [];
    let replacementThreadId: string | undefined;
    vi.spyOn(client, "request").mockImplementation(async (method, params, ...rest) => {
      const threadId = (params as { threadId?: string } | undefined)?.threadId;
      const observed = !!threadId && (threadId === runtimeRef || threadId === replacementThreadId) && (method === "thread/resume" || method === "turn/start");
      try {
        const result = await request(method, params, ...rest);
        if (method === "thread/start") replacementThreadId = (result as { thread: { id: string } }).thread.id;
        if (observed) rpc.push({ method, accepted: true });
        return result;
      } catch (error) {
        if (observed) rpc.push({ method, accepted: false, reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });
    client.on("notification", (entry) => {
      const id = (entry.params as { threadId?: string }).threadId;
      if (id && (id === runtimeRef || id === replacementThreadId)) events.push(entry.method);
    });
    const deferred: ServerNotification[] = [];
    const emitter = client as unknown as { emit(event: string, ...args: unknown[]): boolean };
    const emit = emitter.emit.bind(emitter);
    const delayEcho = phase === "before-inbox" ? vi.spyOn(emitter, "emit").mockImplementation((event, ...args) => {
      const entry = args[0] as ServerNotification | undefined;
      if (event === "notification" && replacementThreadId && entry && "threadId" in entry.params && entry.params.threadId === replacementThreadId &&
          (entry.method === "turn/completed" || entry.method === "item/completed" && entry.params.item.type === "userMessage")) {
        deferred.push(entry);
        return true;
      }
      return emit(event, ...args);
    }) : undefined;
    servers.handles.set("test", { ...handle, client });
    await openHost(dbPath, Number(new URL(mcpUrl).port));
    if (phase === "after-turn-rpc") {
      expect(store.getRelay(relayId)).toMatchObject({ state: "failed", sessionId: checkpoint.sessionId, error: expect.stringContaining("无法确认重开首轮是否已发送") });
      expect(store.getItem(checkpoint.itemId)).toMatchObject({ sessionId: checkpoint.sessionId, type: "user" });
      expect(service.collab.readMailFromSession(manager.id).filter((entry) => entry.text.includes("重开首轮待核对"))).toEqual([
        expect.objectContaining({ text: expect.stringContaining(checkpoint.sessionId) }),
      ]);
      expect(await ok(manager, "task_message", { taskId: downstream.id, text: crashMessage, purpose: "reopen" })).toMatchObject({ relayId, state: "failed", sessionId: checkpoint.sessionId });
      const resend = await fetch(`${http.url}/api/sessions/${checkpoint.sessionId}/items/${checkpoint.itemId}/resend`, {
        method: "POST", headers: { authorization: "Bearer fixture-ui", connection: "close" },
      });
      expect(resend.status).toBe(409);
      expect(await resend.json()).toMatchObject({ error: { message: expect.stringContaining("无法确认重开首轮是否已发送") } });
      await vi.waitFor(async () => {
        const nativeThread = await client.request("thread/read", { threadId: runtimeRef!, includeTurns: true });
        expect(nativeThread.thread.turns).toMatchObject([{ status: "completed" }]);
        expect(mock.requests.filter((entry) => JSON.stringify(entry).includes(crashMessage))).toHaveLength(1);
      });
      expect(rpc.filter((entry) => entry.method === "turn/start")).toHaveLength(0);
      expect(replacementThreadId).toBeUndefined();
      expect(store.getSession(checkpoint.sessionId)?.runtimeRef).toBe(runtimeRef);
      expect(store.listSessions({ taskId: downstream.id })).toHaveLength(2);
      return;
    }
    await vi.waitFor(() => expect(store.getRelay(relayId)).toMatchObject({ state: "delivered", sessionId: checkpoint.sessionId }));
    try {
      await vi.waitFor(() => expect(store.getSession(checkpoint.sessionId)?.status).toBe("running"));
      const running = store.getSession(checkpoint.sessionId)!;
      // A status update can schedule context after the dispatch ACK but before the native input echo is processed.
      expect(service.sharedContext.receipts(running.id).some((receipt) => receipt.deliveredAt)).toBe(false);
      service.publish({ type: "session.upserted", session: running });
      expect(store.findItems(running.id, "user", {}).map((item) => item.id)).toEqual([checkpoint.itemId]);
    } finally {
      delayEcho?.mockRestore();
      for (const entry of deferred) emit("notification", entry);
    }
    const replacement = store.getSession(checkpoint.sessionId)!;
    await vi.waitFor(() => {
      const item = store.getItem(checkpoint.itemId);
      expect(item).toMatchObject({ sessionId: replacement.id, text: expect.stringContaining(b.id) });
      const state = {
        status: store.getSession(replacement.id)?.status,
        delivery: item?.type === "user" ? item.delivery : undefined,
        turns: store.findItems(replacement.id, "turn", {}).map((entry) => entry.type === "turn" ? [entry.state, entry.messagePurpose] : []),
        rpc, events, modelCalls: mock.requests.filter((request) => JSON.stringify(request).includes(crashMessage)).length,
      };
      expect(state, JSON.stringify(state)).toHaveProperty("delivery", undefined);
    }, { timeout: 5_000 });
    await settled(replacement, crashMessage);
    expect(replacement.runtimeRef).toBe(replacementThreadId);
    expect(replacement.runtimeRef).not.toBe(runtimeRef);
    expect(rpc.filter((entry) => entry.method === "turn/start")).toEqual([{ method: "turn/start", accepted: true }]);
    expect(events).toEqual(expect.arrayContaining(["turn/started", "turn/completed"]));
    expect(await message(manager, downstream.id, crashMessage, "reopen")).toMatchObject({ relayId });
    expect(store.listSessions({ taskId: downstream.id })).toHaveLength(2);
    expect(store.getSession(old.id)?.archivedAt).toEqual(expect.any(String));
    expect(store.getItem(checkpoint.itemId)).toMatchObject({ sessionId: replacement.id, text: expect.stringContaining(b.id) });
    expect(service.sharedContext.prerequisites(downstream.id)).toEqual([b.id]);
    expect(mock.requests.filter((request) => JSON.stringify(request).includes(crashMessage))).toHaveLength(1);
    await ok(replacement, "context_adopt", basis());
    expect(await review(await submit(replacement, "中断恢复交付"))).toMatchObject({ state: "accepted", sessionId: replacement.id, prerequisiteResultIds: [b.id] });
  } finally {
    await native.stopAll();
    await mock.close();
  }
}, 25_000);
