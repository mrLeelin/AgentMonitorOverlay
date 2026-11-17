import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, mockClaudeProvider, removeTempDir, startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { ClaudeRuntime } from "./claude-runtime.js";

const profiles: ModelProfile[] = [{ id: "claude-goal", label: "Claude Goal", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];
let root: string, store: Store, mock: ClaudeMockServer, runtime: ClaudeRuntime, workspace: Workspace;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-goals-"));
  mkdirSync(join(root, "workspace"));
  store = new Store(":memory:");
  mock = await startMockAnthropic();
  runtime = new ClaudeRuntime({ store, profiles, providers: { mock: mockClaudeProvider(mock.baseUrl) }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome: join(root, "claude-home"), idleCloseMs: 120000 });
  workspace = store.addWorkspace({ path: join(root, "workspace"), name: "Goals" });
});
afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});
async function start(): Promise<Session> {
  const task = store.createTask({ title: "Goal", workspaceId: workspace.id });
  return runtime.startSession({ taskId: task.id, topicId: null, workspace, profileId: profiles[0]!.id, options: { permission: "bypassPermissions", effort: "high" } });
}
const until = async (condition: () => boolean) => vi.waitFor(() => expect(condition()).toBe(true), { timeout: 30000, interval: 50 });

describe("Claude native Goal with the real CLI and mock model", () => {
  it("reads without a model request and completes only from the native evaluator attachment", async () => {
    const s = await start(), before = mock.requests.length;
    expect(await runtime.getGoal(s.id)).toMatchObject({ goal: null, capabilities: { tokenBudget: false, pause: true, tokens: false, elapsed: false } });
    expect(mock.requests.length).toBe(before);
    await runtime.setGoal(s.id, { objective: "Verify the native goal and finish it", status: "active" });
    await until(() => store.getSession(s.id)?.goal?.status === "complete");
    const state = await runtime.getGoal(s.id);
    expect(state.goal).toMatchObject({ objective: "Verify the native goal and finish it", status: "complete", iterations: 1 });
    expect(state.goal!.tokensUsed).toBeGreaterThan(0);
    expect(state.capabilities).toMatchObject({ tokens: true, elapsed: true });
    const beforeClear = mock.requests.length;
    expect((await runtime.clearGoal(s.id)).goal).toBeNull();
    expect(mock.requests.length).toBe(beforeClear);
  }, 60000);

  it("clears an active native hook before pausing and resumes only on explicit activation", async () => {
    const s = await start();
    await runtime.setGoal(s.id, { objective: "Do [[goal-slow]] work until checked", status: "active" });
    await until(() => store.getSession(s.id)?.status === "running");
    const before = mock.requests.length;
    expect((await runtime.setGoal(s.id, { status: "paused" })).goal?.status).toBe("paused");
    await until(() => store.getSession(s.id)?.status === "idle");
    expect((await runtime.getGoal(s.id)).goal?.status).toBe("paused");
    expect(mock.requests.length).toBe(before);
    await runtime.setGoal(s.id, { status: "active" });
    await until(() => mock.requests.length > before);
    await runtime.interrupt(s.id);
    expect((await runtime.getGoal(s.id)).goal?.status).toBe("paused");
  }, 60000);

  it("distinguishes a native impossible result from completion", async () => {
    const s = await start();
    await runtime.setGoal(s.id, { objective: "Verify [[goal-blocked]] evidence", status: "active" });
    await until(() => store.getSession(s.id)?.goal?.status === "blocked");
    const state = await runtime.getGoal(s.id);
    expect(state.goal?.status).toBe("blocked");
    expect(state.goal?.lastReason).toBeTruthy();
  }, 60000);

  it("rejects unsupported budgets, reserved clear words and archived writes", async () => {
    const s = await start(), before = mock.requests.length;
    await expect(runtime.setGoal(s.id, { objective: "clear", status: "active" })).rejects.toThrow("清除命令");
    await expect(runtime.setGoal(s.id, { objective: "off", status: "active" })).rejects.toThrow("清除命令");
    await expect(runtime.setGoal(s.id, { objective: "Work", tokenBudget: 100 })).rejects.toThrow("预算");
    await expect(runtime.setGoal(s.id, { objective: "Work", roundBudget: 100 })).rejects.toThrow("预算");
    expect(mock.requests.length).toBe(before);
    await runtime.archive(s.id);
    await expect(runtime.setGoal(s.id, { objective: "Work" })).rejects.toMatchObject({ code: "read_only" });
  }, 60000);

  it("archives with the original hook cleared and retains a paused objective on restore", async () => {
    const s = await start();
    await runtime.setGoal(s.id, { objective: "Archive [[goal-slow]] work", status: "active" });
    await until(() => store.getSession(s.id)?.status === "running");
    await runtime.archive(s.id);
    expect(store.getSession(s.id)?.goal?.status).toBe("paused");
    const before = mock.requests.length;
    await runtime.unarchive(s.id);
    expect((await runtime.getGoal(s.id)).goal?.status).toBe("paused");
    expect(mock.requests.length).toBe(before);
  }, 60000);
});
