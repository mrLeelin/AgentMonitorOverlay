import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, ModelProfile, Session, SessionGoal, Workspace } from "@amo-studio/protocol";
import { Store } from "../../store/store.js";
import { CodexRuntime } from "./codex-runtime.js";
import { FakeServers } from "./fake-servers.test-support.js";
import { RpcError } from "./rpc-client.js";
import { RuntimeRouter } from "../runtime.js";
import { currentMessagePurpose, pendingMessagePurpose } from "../message-purpose.js";

const PROFILES: ModelProfile[] = [{ id: "goal-test", label: "Goal test", runtime: "codex", provider: null, model: null }];
let store: Store;
let servers: FakeServers;
let runtime: CodexRuntime;
let events: HostEvent[];
let workspace: Workspace;
let taskId: string;

beforeEach(() => {
  store = new Store(":memory:");
  servers = new FakeServers(PROFILES);
  runtime = new CodexRuntime({ store, servers, profiles: PROFILES });
  events = [];
  runtime.on("event", (event) => events.push(event));
  workspace = store.addWorkspace({ path: "C:/sandbox/goal", name: "goal" });
  taskId = store.createTask({ title: "goal", workspaceId: workspace.id }).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  store.close();
});

async function start(): Promise<Session> {
  const session = await runtime.startSession({ taskId, topicId: null, workspace, profileId: PROFILES[0]!.id, text: "prepare goal" });
  await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
  return store.getSession(session.id)!;
}

describe("Codex native Goals", () => {
  it("creates only on explicit request and omits an unspecified token budget", async () => {
    const session = await start();
    const fake = servers.fakes.get(session.profileId)!;
    const turnsBefore = fake.calls.filter((call) => call.method === "turn/start").length;
    expect(fake.calls.find((call) => call.method === "initialize")?.params).toMatchObject({ capabilities: { experimentalApi: true } });
    expect(await runtime.getGoal(session.id)).toEqual({ goal: null });
    expect(fake.calls.some((call) => call.method === "thread/goal/set")).toBe(false);

    const result = await runtime.setGoal(session.id, { objective: "Finish the implementation", status: "active" });
    expect(result.goal).toMatchObject({ threadId: session.runtimeRef, objective: "Finish the implementation", status: "active", tokenBudget: null });
    const call = fake.calls.find((row) => row.method === "thread/goal/set")!;
    expect(call.params).toEqual({ threadId: session.runtimeRef, origin: "user", objective: "Finish the implementation", status: "active" });
    // Native Goal activation owns the next turn; an extra turn/start races its continuation.
    expect(fake.calls.filter((row) => row.method === "turn/start")).toHaveLength(turnsBefore);
    expect(store.getSession(session.id)?.goal).toEqual(result.goal);
    expect(events).toContainEqual(expect.objectContaining({ type: "session.goal", sessionId: session.id, goal: result.goal }));
  });

  it("preserves the native goal and budget while pausing, resuming and clearing", async () => {
    const session = await start();
    const fake = servers.fakes.get(session.profileId)!;
    const result = await runtime.setGoal(session.id, { objective: "Check the feature", tokenBudget: 12000, status: "active" });
    expect(result.goal?.tokenBudget).toBe(12000);
    expect((await runtime.setGoal(session.id, { status: "paused" })).goal).toMatchObject({ objective: "Check the feature", tokenBudget: 12000, status: "paused" });
    expect((await runtime.setGoal(session.id, { status: "active" })).goal).toMatchObject({ objective: "Check the feature", tokenBudget: 12000, status: "active" });
    expect(fake.calls.filter((call) => call.method === "thread/goal/set").every((call) => (call.params as { origin?: string }).origin === "user")).toBe(true);
    expect(fake.calls.filter((call) => call.method === "turn/interrupt")).toHaveLength(0);
    expect(await runtime.clearGoal(session.id)).toEqual({ goal: null });
    expect(fake.calls.find((call) => call.method === "thread/goal/clear")?.params).toEqual({ threadId: session.runtimeRef, origin: "user" });
    expect(fake.goals.has(session.runtimeRef!)).toBe(false);
    expect(store.getSession(session.id)?.goal ?? null).toBeNull();
  });

  it("tracks native lifecycle notifications and clears snapshots without a UI request", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Complete the native goal", status: "active" });
    const { client } = await servers.ensure(session.profileId);
    for (const status of ["blocked", "budgetLimited", "usageLimited", "complete"] as const) {
      await client.request("thread/goal/set", { threadId: session.runtimeRef!, origin: "automatic", status });
      await vi.waitFor(() => expect(store.getSession(session.id)?.goal?.status).toBe(status));
      expect(events).toContainEqual(expect.objectContaining({ type: "session.goal", sessionId: session.id, goal: expect.objectContaining({ status }) }));
    }
    await client.request("thread/goal/clear", { threadId: session.runtimeRef!, origin: "user" });
    await vi.waitFor(() => expect(store.getSession(session.id)?.goal ?? null).toBeNull());
    expect(events).toContainEqual(expect.objectContaining({ type: "session.goal", sessionId: session.id, goal: null }));
  });

  it("refreshes the cached snapshot from the native get response", async () => {
    const session = await start();
    const now = Math.floor(Date.now() / 1000);
    const goal: SessionGoal = { threadId: session.runtimeRef!, objective: "Loaded outside Studio", status: "paused", tokenBudget: 2000, tokensUsed: 750, timeUsedSeconds: 30, createdAt: now, updatedAt: now };
    servers.fakes.get(session.profileId)!.goals.set(session.runtimeRef!, goal);
    expect((await runtime.getGoal(session.id)).goal).toEqual(goal);
    expect(store.getSession(session.id)?.goal).toEqual(goal);
  });

  it("does not overwrite a newer native notification with a delayed get response", async () => {
    const session = await start();
    const old = (await runtime.setGoal(session.id, { objective: "Finish while the panel loads", status: "active" })).goal!;
    const { client } = await servers.ensure(session.profileId);
    const request = client.request.bind(client);
    let resolveRead!: (value: { goal: SessionGoal }) => void;
    const delayed = new Promise<{ goal: SessionGoal }>((resolve) => { resolveRead = resolve; });
    vi.spyOn(client, "request").mockImplementation(((method: string, params: never) => method === "thread/goal/get" ? delayed : request(method as never, params)) as typeof client.request);
    const reading = runtime.getGoal(session.id);
    await client.request("thread/goal/set", { threadId: session.runtimeRef!, origin: "automatic", status: "complete" });
    await vi.waitFor(() => expect(store.getSession(session.id)?.goal?.status).toBe("complete"));
    resolveRead({ goal: old });
    expect((await reading).goal?.status).toBe("complete");
    expect(store.getSession(session.id)?.goal?.status).toBe("complete");
  });

  it.each(["terminal-handoff", "archived"] as const)("refuses mutations for a %s session", async (writer) => {
    const session = await start();
    store.updateSession(session.id, { writer });
    const fake = servers.fakes.get(session.profileId)!;
    const before = fake.calls.length;
    await expect(runtime.setGoal(session.id, { objective: "Do not dispatch", status: "active" })).rejects.toMatchObject({ code: "read_only" });
    await expect(runtime.clearGoal(session.id)).rejects.toMatchObject({ code: "read_only" });
    expect(fake.calls.slice(before).some((call) => call.method === "thread/goal/set" || call.method === "thread/goal/clear")).toBe(false);
  });

  it("rechecks dispatch eligibility immediately before activation", async () => {
    const session = await start();
    const guard = vi.fn(() => { throw new Error("Prerequisite was returned"); });
    await expect(runtime.setGoal(session.id, { objective: "Pending work", status: "active" }, guard)).rejects.toThrow("Prerequisite was returned");
    expect(guard).toHaveBeenCalled();
    expect(servers.fakes.get(session.profileId)!.calls.some((call) => call.method === "thread/goal/set")).toBe(false);
  });

  it("reports unsupported native APIs without confusing transport failures with no goal", async () => {
    const session = await start();
    const { client } = await servers.ensure(session.profileId);
    const request = client.request.bind(client);
    const spy = vi.spyOn(client, "request").mockImplementation(((method: string, params: never) => method === "thread/goal/get"
      ? Promise.reject(new RpcError(method, -32601, "Method not found"))
      : request(method as never, params)) as typeof client.request);
    expect(await runtime.getGoal(session.id)).toMatchObject({ goal: null, unavailable: expect.any(String) });
    spy.mockImplementation(((method: string, params: never) => method === "thread/goal/get"
      ? Promise.reject(new Error("connection lost"))
      : request(method as never, params)) as typeof client.request);
    await expect(runtime.getGoal(session.id)).rejects.toThrow("connection lost");
  });

  it("does not report a successful mutation when the native server rejects it", async () => {
    const session = await start();
    const { client } = await servers.ensure(session.profileId);
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation(((method: string, params: never) => method === "thread/goal/set"
      ? Promise.reject(new RpcError(method, -32602, "Goal cannot be resumed"))
      : request(method as never, params)) as typeof client.request);
    await expect(runtime.setGoal(session.id, { objective: "Rejected", status: "active" })).rejects.toThrow("Goal cannot be resumed");
    expect(store.getSession(session.id)?.goal ?? null).toBeNull();
  });

  it("synchronizes current options before native activation without starting a second turn", async () => {
    const session = await start();
    await runtime.setOptions(session.id, { model: "goal-model", effort: "high", permission: "full-auto", fast: false });
    const fake = servers.fakes.get(session.profileId)!;
    const offset = fake.calls.length;
    await runtime.setGoal(session.id, { objective: "Use the selected options", status: "active" });
    const calls = fake.calls.slice(offset);
    const settingsIndex = calls.findIndex((call) => call.method === "thread/settings/update");
    const goalIndex = calls.findIndex((call) => call.method === "thread/goal/set");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(settingsIndex).toBeLessThan(goalIndex);
    expect(calls[settingsIndex]?.params).toMatchObject({ threadId: session.runtimeRef, model: "goal-model", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("pauses active Goals even when Stop is pressed between autonomous turns", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Continue until stopped", status: "active" });
    await runtime.interrupt(session.id);
    expect((await runtime.getGoal(session.id)).goal?.status).toBe("paused");
    expect(store.getSession(session.id)?.goal?.status).toBe("paused");
  });

  it("pauses Goal continuation before interrupting the running turn", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Continue until stopped", status: "active" });
    await runtime.sendMessage(session.id, "[[busy: 500]]");
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("running"));
    const fake = servers.fakes.get(session.profileId)!;
    const offset = fake.calls.length;
    await runtime.interrupt(session.id);
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
    const calls = fake.calls.slice(offset);
    const pause = calls.findIndex((call) => call.method === "thread/goal/set" && (call.params as { status?: string }).status === "paused");
    const interrupt = calls.findIndex((call) => call.method === "turn/interrupt");
    expect(pause).toBeGreaterThanOrEqual(0);
    expect(interrupt).toBeGreaterThan(pause);
    expect(fake.goals.get(session.runtimeRef!)?.status).toBe("paused");
  });

  it("archives with Goal paused and never reactivates it just by restoring the session", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Keep the work for later", status: "active" });
    await runtime.archive(session.id);
    const fake = servers.fakes.get(session.profileId)!;
    expect(fake.goals.get(session.runtimeRef!)?.status).toBe("paused");
    await runtime.unarchive(session.id);
    expect((await runtime.getGoal(session.id)).goal?.status).toBe("paused");
    expect(store.getSession(session.id)?.archivedAt).toBeNull();
  });

  it("archives native subagents with their parent without querying an independently addressable Goal", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Archive the whole tree", status: "active" });
    // Codex can announce a subagent through activity alone; Studio neither resumes nor owns that native thread.
    const child = store.createSession({ taskId, topicId: null, parentId: session.id, kind: "sub", runtime: "codex", profileId: session.profileId, workspaceId: workspace.id, title: "Native child", status: "completed", writer: "workbench", runtimeRef: "native-child-not-loaded" });
    const fake = servers.fakes.get(session.profileId)!;
    const before = fake.calls.length;
    await runtime.archive(session.id);
    expect(store.getSession(session.id)?.archivedAt).toEqual(expect.any(String));
    expect(store.getSession(child.id)?.archivedAt).toEqual(expect.any(String));
    expect(fake.goals.get(session.runtimeRef!)?.status).toBe("paused");
    expect(fake.calls.slice(before).some((call) => (call.params as { threadId?: string }).threadId === child.runtimeRef)).toBe(false);
  });

  it("reports native subagent Goals as unavailable and refuses independent mutations without transport", async () => {
    const session = await start();
    const child = store.createSession({ taskId, topicId: null, parentId: session.id, kind: "sub", runtime: "codex", profileId: session.profileId, workspaceId: workspace.id, title: "Native child", status: "completed", writer: "workbench", runtimeRef: "native-child-not-loaded" });
    const fake = servers.fakes.get(session.profileId)!;
    const before = fake.calls.length;
    expect(await runtime.getGoal(child.id)).toMatchObject({ goal: null, unavailable: expect.stringContaining("子 agent") });
    await expect(runtime.setGoal(child.id, { objective: "Do not independently activate", status: "active" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(runtime.clearGoal(child.id)).rejects.toMatchObject({ code: "bad_request" });
    expect(fake.calls).toHaveLength(before);
  });

  it("serializes a permission change with the first Goal activation so native and UI settings agree", async () => {
    const session = await start();
    const { client } = await servers.ensure(session.profileId);
    const update = client.updateThreadSettings.bind(client);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const settings = vi.spyOn(client, "updateThreadSettings").mockImplementationOnce(async (params) => { await pending; await update(params); });
    const activating = runtime.setGoal(session.id, { objective: "Start with the current permissions", status: "active" });
    await vi.waitFor(() => expect(settings).toHaveBeenCalledTimes(1));
    const editing = runtime.setOptions(session.id, { permission: "read-only", model: "fake-model", effort: "low" });
    release();
    await Promise.all([activating, editing]);
    expect(store.getSession(session.id)?.options).toEqual({ permission: "read-only", model: "fake-model", effort: "low" });
    const nativeSettings = servers.fakes.get(session.profileId)!.calls.filter((call) => call.method === "thread/settings/update").at(-1);
    expect(nativeSettings?.params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false }, model: "fake-model", effort: "low" });
  });

  it("lets Stop bypass pending settings and cancels all previously queued Goal activations", async () => {
    const session = await start();
    const { client } = await servers.ensure(session.profileId);
    const update = client.updateThreadSettings.bind(client);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const settings = vi.spyOn(client, "updateThreadSettings").mockImplementationOnce(async (params) => { await pending; await update(params); });
    const activating = runtime.setGoal(session.id, { objective: "A pending activation", status: "active" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(settings).toHaveBeenCalledTimes(1));
    const queued = runtime.setGoal(session.id, { objective: "Another pending activation", status: "active" }).catch((error: unknown) => error);
    let stopped = false;
    const stopping = runtime.interrupt(session.id).then(() => { stopped = true; });
    try {
      await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 500 });
      expect(servers.fakes.get(session.profileId)!.calls.some((call) => call.method === "thread/goal/set")).toBe(false);
    } finally {
      release();
    }
    await stopping;
    expect(await activating).toMatchObject({ message: expect.stringContaining("已取消") });
    expect(await queued).toMatchObject({ message: expect.stringContaining("已取消") });
    expect(servers.fakes.get(session.profileId)!.goals.has(session.runtimeRef!)).toBe(false);
  });

  it("still interrupts the current turn when reading Goal state fails and reports the unconfirmed pause", async () => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Continue until stopped", status: "active" });
    await runtime.sendMessage(session.id, "[[busy: 500]]");
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("running"));
    const { client } = await servers.ensure(session.profileId);
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation(((method: string, params: never) => method === "thread/goal/get" ? Promise.reject(new Error("Goal read unavailable")) : request(method as never, params)) as typeof client.request);
    await expect(runtime.interrupt(session.id)).rejects.toThrow(/Goal.*未能确认.*Goal read unavailable/);
    expect(servers.fakes.get(session.profileId)!.calls.some((call) => call.method === "turn/interrupt")).toBe(true);
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
    // A failed pause is never displayed as success, even though the current turn was interrupted.
    expect(store.getSession(session.id)?.goal?.status).toBe("active");
  });

  it.each(["inquiry", "notification"] as const)("rejects router %s before changing the active Goal's work purpose", async (purpose) => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Keep working on the goal", status: "active" });
    const router = RuntimeRouter.around(store, runtime);
    const send = vi.spyOn(runtime, "sendMessage");
    await expect(Promise.resolve().then(() => router.sendMessage(session.id, "Read-only follow-up", [], { purpose }))).rejects.toMatchObject({ code: "bad_request" });
    expect(send).not.toHaveBeenCalled();
    expect(currentMessagePurpose(store, session.id)).toBe("work");
    expect(pendingMessagePurpose(store, session.id)).toBe("work");
    expect(store.getSession(session.id)?.goal?.status).toBe("active");
  });

  it.each(["inquiry", "notification"] as const)("also rejects native %s dispatch while a Goal is active", async (purpose) => {
    const session = await start();
    await runtime.setGoal(session.id, { objective: "Keep native work unchanged", status: "active" });
    const fake = servers.fakes.get(session.profileId)!;
    const before = fake.calls.length;
    await expect(runtime.sendMessage(session.id, "Do not interrupt the purpose", [], { purpose })).rejects.toMatchObject({ code: "bad_request" });
    expect(fake.calls.slice(before).some((call) => call.method === "turn/start" || call.method === "turn/steer")).toBe(false);
    expect(currentMessagePurpose(store, session.id)).toBe("work");
    expect(pendingMessagePurpose(store, session.id)).toBe("work");
  });
});
