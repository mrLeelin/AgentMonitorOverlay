import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, HostEvent } from "@amo-studio/protocol";
import { fakeAcpAgent, removeTempDir } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { DshRuntime } from "./dsh-runtime.js";
import { DshGoalBridge, dshGoalState, type DshNativeGoal } from "./goal-bridge.js";
import type { AcpConnection } from "./acp.js";

const profile: ModelProfile = { id: "goal-dsh", label: "DSH", runtime: "dsh", provider: "deepseek-official", model: null, credentialId: "test-key" };
let root: string, store: Store, runtime: DshRuntime, session: Session;
let events: HostEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-dsh-goals-"));
  mkdirSync(join(root, "workspace"));
  store = new Store(":memory:");
  runtime = new DshRuntime({ store, profiles: [profile], credentials: new StaticCredentialReader({ "test-key": "offline" }), dir: join(root, "dsh"), agent: fakeAcpAgent(), env: { ...process.env, DSH_HOME: join(root, "dsh", "home") }, folderAccess: null });
  events = []; runtime.on("event", (event) => events.push(event));
  const workspace = store.addWorkspace({ path: join(root, "workspace"), name: "test" });
  const task = store.createTask({ title: "DSH Goal", workspaceId: workspace.id });
  session = await runtime.startSession({ taskId: task.id, topicId: null, profileId: profile.id, workspace });
});

afterEach(async () => { vi.restoreAllMocks(); await runtime?.closeAll(); store?.close(); if (root) removeTempDir(root); });

describe("DSH native Goal bridge", () => {
  it("uses round budgets and native states through the private bridge, never slash prompt commands", async () => {
    expect(await runtime.getGoal(session.id)).toMatchObject({ goal: null, capabilities: { tokenBudget: false, roundBudget: true, tokens: false, elapsed: false } });
    expect((await runtime.setGoal(session.id, { objective: "核对中文目标😀", roundBudget: 3, status: "active" })).goal).toMatchObject({ objective: "核对中文目标😀", status: "active", roundBudget: 3, iterations: 0 });
    expect(store.listItems(session.id).filter((item) => item.type === "user")).toHaveLength(0);
    expect((await runtime.setGoal(session.id, { status: "paused" })).goal?.status).toBe("paused");
    expect((await runtime.setGoal(session.id, { status: "active", roundBudget: 5 })).goal).toMatchObject({ status: "active", roundBudget: 5 });
    expect((await runtime.clearGoal(session.id)).goal).toBeNull();
    expect(events.some((event) => event.type === "session.goal" && event.goal?.status === "active")).toBe(true);
  });

  it("stops continuation even in the gap between native rounds and preserves pause across archive", async () => {
    await runtime.setGoal(session.id, { objective: "Keep going", status: "active" });
    await runtime.interrupt(session.id);
    expect((await runtime.getGoal(session.id)).goal?.status).toBe("paused");
    await runtime.setGoal(session.id, { status: "active" });
    await runtime.archive(session.id);
    expect(store.getSession(session.id)?.goal?.status).toBe("paused");
    await runtime.unarchive(session.id);
    expect((await runtime.getGoal(session.id)).goal?.status).toBe("paused");
  });

  it("rejects unsupported token budgets, archived writes and dispatch invalidated before native activation", async () => {
    await expect(runtime.setGoal(session.id, { objective: "Budget", tokenBudget: 10 })).rejects.toThrow("不支持 Token");
    await expect(runtime.setGoal(session.id, { objective: "Guard", status: "active" }, () => { throw new Error("Context changed"); })).rejects.toThrow("Context changed");
    expect((await runtime.getGoal(session.id)).goal).toBeNull();
    await runtime.archive(session.id);
    await expect(runtime.setGoal(session.id, { objective: "Archived", status: "active" })).rejects.toMatchObject({ code: "read_only" });
    await expect(runtime.clearGoal(session.id)).rejects.toMatchObject({ code: "read_only" });
  });

  it.each(["inquiry", "notification"] as const)("refuses direct %s while a Goal is active", async (purpose) => {
    await runtime.setGoal(session.id, { objective: "Work", status: "active" });
    await expect(runtime.sendMessage(session.id, "Should stay held", [], { purpose })).rejects.toThrow("Goal 正在持续执行");
    expect(store.listItems(session.id).filter((item) => item.type === "user")).toHaveLength(0);
  });

  it("normalizes disarmed recovery and native round exhaustion without invented token metrics", () => {
    const native: DshNativeGoal = { id: "g", revision: 2, objective: "Test", phase: "active", activation: "disarmed", roundsStarted: 4, maxGoalRounds: 4, createdAt: 1000, updatedAt: 2000 };
    expect(dshGoalState("thread", native).goal).toMatchObject({ status: "paused", iterations: 4, roundBudget: 4, createdAt: 1 });
    expect(dshGoalState("thread", { ...native, phase: "blocked", blockedReason: { code: "round-limit", message: "Need more rounds" } }).goal).toMatchObject({ status: "budgetLimited", lastReason: "Need more rounds" });
  });

  it("pauses the cached Goal when its native process unexpectedly exits", async () => {
    await runtime.setGoal(session.id, { objective: "Survive a crash", status: "active" });
    const live = (runtime as unknown as { live: Map<string, { conn: AcpConnection }> }).live.get(session.id)!;
    live.conn.kill();
    // Windows taskkill runs asynchronously; assert the exit handler's result after the actual process edge.
    await live.conn.exited;
    expect(store.getSession(session.id)?.goal?.status).toBe("paused");
    expect(events.some((event) => event.type === "session.goal" && event.goal?.status === "paused")).toBe(true);
  });

  it("applies model and effort while the native Goal's own round is running", async () => {
    await runtime.setGoal(session.id, { objective: "Keep current settings", status: "active" });
    await runtime.sendMessage(session.id, "[[goal: 1 slow]]");
    await vi.waitFor(() => expect((runtime as unknown as { live: Map<string, { auto: unknown }> }).live.get(session.id)?.auto).toBeTruthy());
    await runtime.setOptions(session.id, { model: "deepseek-official/deepseek-v4-pro", effort: "low" });
    const saved = JSON.parse(readFileSync(join(root, "dsh", "home", "fake-sessions.json"), "utf8"));
    expect(saved[session.runtimeRef!]).toMatchObject({ model: '["deepseek-official","deepseek-v4-pro"]', effort: "low" });
    await runtime.interrupt(session.id);
  });

  it("compensates a late successful create even when its response is lost after Stop", async () => {
    const call = DshGoalBridge.prototype.call;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(DshGoalBridge.prototype, "call").mockImplementation(async function (this: DshGoalBridge, action, input = {}) {
      if (action === "set" && input.objective) { entered(); await waiting; await call.call(this, action, input); throw new Error("response lost"); }
      return call.call(this, action, input);
    });
    const activating = runtime.setGoal(session.id, { objective: "Late create", status: "active" }).catch((error: unknown) => error);
    await started;
    await runtime.interrupt(session.id);
    release();
    expect(await activating).toBeInstanceOf(Error);
    expect((await runtime.getGoal(session.id)).goal?.status).toBe("paused");
  });
});
