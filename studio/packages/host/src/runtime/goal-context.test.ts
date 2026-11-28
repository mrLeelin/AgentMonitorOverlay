import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionGoal, SessionRuntime } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { bindLeadFixture } from "../features/botleads/lead.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { RuntimeRouter, type RuntimeEvents, type SessionRuntimeApi } from "./runtime.js";
import { currentMessagePurpose, queueMessagePurpose } from "./message-purpose.js";
import { CodexRuntime } from "./codex/codex-runtime.js";
import { FakeServers } from "./codex/fake-servers.test-support.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(name: Exclude<SessionRuntime, "remote" | "pi"> = "codex") {
  const folder = mkdtempSync(join(tmpdir(), "amo-studio-test-goal-context-"));
  const store = new Store(":memory:");
  cleanup.push(() => removeTempDir(folder), () => store.close());
  const workspace = store.addWorkspace({ name: "Goal context", path: folder });
  const profiles: ModelProfile[] = [{ id: "mock", label: "mock", runtime: name, provider: null, model: "mock" }];
  const create = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: name, profileId: "mock", workspaceId: workspace.id, title: "Goal", status: "idle", writer: "workbench", runtimeRef: `native-${taskId}` });
  const native = Object.assign(new EventEmitter<RuntimeEvents>(), {
    choices: vi.fn(async () => ({ profileId: "mock", models: [], permissions: [], defaultPermission: "", source: "builtin" as const })),
    startSession: vi.fn(async (input: Parameters<SessionRuntimeApi["startSession"]>[0]) => create(input.taskId!)),
    resend: vi.fn(async (id: string, itemId: string, _images: unknown, options: { beforeDispatch?: () => void }) => {
      options.beforeDispatch?.();
      upsert(id, { status: "running" });
      return { mode: "start" as const };
    }),
    setGoal: vi.fn(async (id: string, input: Parameters<NonNullable<SessionRuntimeApi["setGoal"]>>[1], before?: () => void) => {
      before?.();
      queueMessagePurpose(store, id, "work", false);
      const goal: SessionGoal = { threadId: store.getSession(id)!.runtimeRef!, objective: input.objective ?? "Continue", status: input.status ?? "active", tokenBudget: input.tokenBudget ?? null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
      upsert(id, { goal });
      return { goal };
    }),
    clearGoal: vi.fn(async () => ({ goal: null })),
    interrupt: vi.fn(async (id: string) => { upsert(id, { status: "idle" }); }),
    archive: vi.fn(async (id: string) => store.archiveSubtree(id)),
  });
  function upsert(id: string, patch: Parameters<Store["updateSession"]>[1]) { native.emit("event", store.appendEvent({ type: "session.upserted", session: store.updateSession(id, patch) })); }
  const router = new RuntimeRouter(store, profiles, { [name]: native as unknown as SessionRuntimeApi });
  const service = new HostService(store, router, profiles, { commonDir: join(folder, "common") });
  const lead = store.createTask({ title: "lead", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "child", workspaceId: workspace.id, managerTaskId: lead.id });
  const manager = bindLeadFixture(service, create(lead.id));
  const publish = (body: string) => {
    const previous = service.sharedContext.get(lead.id).context;
    const draft = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: previous?.revision ?? 0, title: "Requirements", body, changeNote: "Explicit requirements", sources: [{ kind: "user_requirement", source: "The person" }] });
    const published = service.sharedContext.publishVersion(manager.id, draft.id, draft.revision);
    service.sharedContext.apply(manager.id, { contextId: published.id, version: published.currentVersion!, taskIds: [child.id] });
  };
  const body = "Required business data. ".repeat(300);
  publish(body);
  const worker = await service.tasks.addSession(child.id, { profileId: "mock" });
  const row = () => store.listItems(worker.id).find((item) => item.type === "user" && item.text.includes(body));
  const delivered = () => {
    const item = row();
    if (!item || item.type !== "user") throw new Error("No preparation input");
    store.replaceItem({ ...item, delivery: undefined });
    native.emit("message-delivered", worker.id, item.text);
  };
  return { store, native, router, service, child, worker, body, publish, row, delivered, upsert };
}

describe("Goal shared requirement preparation", () => {
  it("refuses subagent activation before preparing any requirement input", async () => {
    const f = await fixture();
    const sub = f.store.createSession({ taskId: f.child.id, topicId: null, parentId: f.worker.id, kind: "sub", runtime: "codex", profileId: "mock", workspaceId: f.child.workspaceId, title: "Native child", status: "completed", writer: "workbench", runtimeRef: "child" });
    await expect(f.service.sessions.setGoal(sub.id, { objective: "Do not independently start", status: "active" })).rejects.toThrow(/子 agent/);
    expect(f.native.resend).not.toHaveBeenCalled();
    expect(f.native.setGoal).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "dsh"] as const)("provides full frozen requirements through an acknowledged inquiry before %s Goal", async (name) => {
    const f = await fixture(name);
    const objective = "Implement the assigned task";
    const starting = f.service.sessions.setGoal(f.worker.id, { objective, status: "active", ...(name === "codex" ? { tokenBudget: 1000 } : {}) });
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledOnce());
    expect(f.row()).toMatchObject({ type: "user", raw: { method: "user/inbox" }, messagePurpose: "inquiry", text: expect.stringContaining(objective) });
    const input = f.row();
    expect(input?.type === "user" && input.text.length).toBeGreaterThan(4000);
    expect(currentMessagePurpose(f.store, f.worker.id)).toBe("inquiry");
    expect(f.service.sharedContext.receipts(f.worker.id)).toEqual([]);
    expect(f.native.setGoal).not.toHaveBeenCalled();
    f.delivered();
    expect(f.service.sharedContext.receipts(f.worker.id)[0]?.deliveredAt).toEqual(expect.any(String));
    expect(f.service.sharedContext.receipts(f.worker.id)[0]?.adoptedAt).toBeUndefined();
    expect(f.native.setGoal).not.toHaveBeenCalled();
    f.upsert(f.worker.id, { status: "idle" });
    await starting;
    expect(f.native.setGoal).toHaveBeenCalledWith(f.worker.id, expect.objectContaining({ objective, status: "active" }), expect.any(Function));
    expect(currentMessagePurpose(f.store, f.worker.id)).toBe("work");
  });

  it.each(["stop", "archive", "clear", "version"] as const)("cancels pending activation after %s while preparing", async (action) => {
    const f = await fixture();
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Pending goal", status: "active" });
    const rejected = expect(starting).rejects.toThrow();
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledOnce());
    if (action === "stop") await f.router.interrupt(f.worker.id, { person: true });
    if (action === "archive") await f.router.archive(f.worker.id);
    if (action === "clear") await f.router.clearGoal(f.worker.id);
    if (action === "version") f.publish("Changed requirements");
    if (action !== "archive") f.upsert(f.worker.id, { status: "idle" });
    await rejected;
    expect(f.native.setGoal).not.toHaveBeenCalled();
  });

  it("does not activate without a transport receipt and cleans up waiting listeners", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const listeners = f.router.listenerCount("message-delivered");
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Unacknowledged preparation", status: "active" });
    const rejected = expect(starting).rejects.toThrow(/需求.*未完成|需求.*未确认/);
    await vi.advanceTimersByTimeAsync(0);
    f.upsert(f.worker.id, { status: "idle" });
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    expect(f.native.setGoal).not.toHaveBeenCalled();
    expect(f.router.listenerCount("message-delivered")).toBe(listeners);
  });

  it("refuses preparation during a running Goal instead of adding a competing turn", async () => {
    const f = await fixture();
    const goal: SessionGoal = { threadId: f.worker.runtimeRef!, objective: "Existing goal", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    f.upsert(f.worker.id, { goal });
    await expect(f.service.sessions.setGoal(f.worker.id, { status: "active" })).rejects.toThrow(/暂停/);
    expect(f.native.resend).not.toHaveBeenCalled();
    expect(f.native.setGoal).not.toHaveBeenCalled();
  });

  it("revokes a delayed preparation transport after its bounded wait times out", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transport = vi.fn();
    let failed!: unknown;
    f.native.resend.mockImplementationOnce(async (_id, _item, _images, options) => {
      await gate;
      try { options.beforeDispatch?.(); transport(); }
      catch (error) { failed = error; throw error; }
      return { mode: "start" };
    });
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Delayed transport", status: "active" });
    const rejected = expect(starting).rejects.toThrow(/需求.*未完成/);
    await vi.advanceTimersByTimeAsync(30_001);
    await rejected;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toMatchObject({ code: "conflict", message: expect.stringContaining("已取消") });
    expect(transport).not.toHaveBeenCalled();
    expect(f.native.setGoal).not.toHaveBeenCalled();
    expect(f.service.sharedContext.receipts(f.worker.id)).toEqual([]);
  });

  it("explains how to provide requirements when DSH cannot guarantee a read-only preparation", async () => {
    const f = await fixture("dsh");
    f.native.resend.mockRejectedValueOnce(Object.assign(new Error("Cannot safely narrow this DSH session"), { code: "read_only" }));
    await expect(f.service.sessions.setGoal(f.worker.id, { objective: "DSH Goal", status: "active" })).rejects.toThrow(/Goal 未开启.*普通工作消息/);
    expect(f.native.setGoal).not.toHaveBeenCalled();
    expect(f.service.sharedContext.receipts(f.worker.id)).toEqual([]);
  });

  it("reuses a confirmed version on retry without resending its full body", async () => {
    const f = await fixture();
    f.service.sharedContext.markDelivered(f.worker.id, f.service.sharedContext.sessionContext(f.worker.id));
    await f.service.sessions.setGoal(f.worker.id, { objective: "Already provided", status: "active" });
    expect(f.native.resend).not.toHaveBeenCalled();
    expect(f.native.setGoal).toHaveBeenCalledOnce();
  });

  it("keeps the accepted task closed during read-only preparation and reopens only for native Goal work", async () => {
    const f = await fixture();
    f.store.updateTask(f.child.id, { column: "done" });
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "New work", status: "active" });
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledOnce());
    expect(f.store.getTask(f.child.id)?.column).toBe("done");
    f.delivered();
    f.upsert(f.worker.id, { status: "idle" });
    await starting;
    expect(f.store.getTask(f.child.id)?.column).toBe("doing");
  });

  it("rechecks the frozen version before a delayed native preparation transport", async () => {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.native.resend.mockImplementationOnce(async (_id, _item, _images, options) => { await gate; options.beforeDispatch?.(); return { mode: "start" }; });
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Old version", status: "active" }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledOnce());
    f.publish("New frozen body");
    release();
    expect(await starting).toMatchObject({ message: expect.stringContaining("已失效") });
    expect(f.native.setGoal).not.toHaveBeenCalled();
    expect(f.row()).toMatchObject({ delivery: "expired" });
  });

  it.each(["interrupted", "error"] as const)("does not confuse historical %s with a new preparation failure during recovery", async (status) => {
    const f = await fixture();
    f.upsert(f.worker.id, { status });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.native.resend.mockImplementationOnce(async (id, _item, _images, options) => {
      await gate; options.beforeDispatch?.(); f.upsert(id, { status: "running" }); return { mode: "start" };
    });
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Recover and work", status: "active" });
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledOnce());
    const unrelated = f.store.createTask({ title: "Unrelated", workspaceId: f.child.workspaceId });
    f.native.emit("event", f.store.appendEvent({ type: "task.upserted", task: unrelated }));
    release();
    await vi.waitFor(() => expect(f.store.getSession(f.worker.id)?.status).toBe("running"));
    f.delivered();
    f.upsert(f.worker.id, { status: "idle" });
    expect((await starting).goal?.status).toBe("active");
  });

  it("rejects a failed preparation without inventing delivery and allows a clean retry", async () => {
    const f = await fixture();
    f.native.resend.mockRejectedValueOnce(new Error("Transport rejected"));
    await expect(f.service.sessions.setGoal(f.worker.id, { objective: "Retry safely", status: "active" })).rejects.toThrow("Transport rejected");
    expect(f.service.sharedContext.receipts(f.worker.id)).toEqual([]);
    expect(f.native.setGoal).not.toHaveBeenCalled();
    const starting = f.service.sessions.setGoal(f.worker.id, { objective: "Retry safely", status: "active" });
    await vi.waitFor(() => expect(f.native.resend).toHaveBeenCalledTimes(2));
    const row = f.store.listItems(f.worker.id).findLast((item) => item.type === "user" && item.text.includes(f.body));
    if (row?.type !== "user") throw new Error("No retry input");
    f.native.emit("message-delivered", f.worker.id, row.text);
    f.upsert(f.worker.id, { status: "idle" });
    await starting;
    expect(f.native.setGoal).toHaveBeenCalledOnce();
  });

  it("runs Codex preparation with native read-only settings and a real fake-server receipt before Goal", async () => {
    const folder = mkdtempSync(join(tmpdir(), "amo-studio-test-goal-native-context-"));
    const store = new Store(":memory:");
    const profiles: ModelProfile[] = [{ id: "native", label: "native", runtime: "codex", provider: null, model: null }];
    const servers = new FakeServers(profiles);
    const native = new CodexRuntime({ store, servers, profiles });
    cleanup.push(() => removeTempDir(folder), () => store.close(), () => servers.close());
    const service = new HostService(store, native, profiles, { commonDir: join(folder, "common") });
    const workspace = store.addWorkspace({ name: "native", path: folder });
    const lead = store.createTask({ title: "lead", workspaceId: workspace.id, lead: true });
    const child = store.createTask({ title: "child", workspaceId: workspace.id, managerTaskId: lead.id });
    const manager = bindLeadFixture(service, store.createSession({ taskId: lead.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "native", workspaceId: workspace.id, title: "manager", status: "idle", writer: "workbench", runtimeRef: "manager" }));
    const body = "Large frozen business body. ".repeat(300);
    const saved = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: 0, title: "Requirements", body, changeNote: "Initial", sources: [{ kind: "user_requirement", source: "The person" }] });
    const published = service.sharedContext.publishVersion(manager.id, saved.id, saved.revision);
    service.sharedContext.apply(manager.id, { contextId: published.id, version: 1, taskIds: [child.id] });
    const worker = await service.tasks.addSession(child.id, { profileId: "native", options: { permission: "full-auto" } });
    const result = await service.sessions.setGoal(worker.id, { objective: "Implement the goal", tokenBudget: 1500, status: "active" });
    expect(result.goal?.status).toBe("active");
    const calls = servers.fakes.get("native")!.calls;
    const preparation = calls.findIndex((call) => call.method === "turn/start" && JSON.stringify(call.params).includes(body));
    const activation = calls.findIndex((call) => call.method === "thread/goal/set");
    expect(preparation).toBeGreaterThanOrEqual(0);
    expect(activation).toBeGreaterThan(preparation);
    expect(calls[preparation]?.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    expect(calls[activation]?.params).toMatchObject({ objective: "Implement the goal", tokenBudget: 1500 });
    expect(service.sharedContext.receipts(worker.id)[0]?.deliveredAt).toEqual(expect.any(String));
    expect(service.sharedContext.receipts(worker.id)[0]?.adoptedAt).toBeUndefined();
  });
});
