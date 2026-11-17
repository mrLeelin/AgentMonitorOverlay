import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionGoal } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { sessionMoving } from "../../core/shared.js";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { RuntimeRouter } from "../runtime.js";
import { ClaudeRuntime } from "./claude-runtime.js";

const profiles: ModelProfile[] = [{ id: "claude-recovery", label: "Claude recovery", runtime: "claude", provider: null, model: null }];
let root: string, store: Store, runtime: ClaudeRuntime | undefined, workspaceId: string, taskId: string;
const savedGoal: SessionGoal = { threadId: "native-recovery", objective: "Finish the saved objective", status: "active", tokenBudget: null, tokensUsed: 12, timeUsedSeconds: 3, createdAt: 100, updatedAt: 200, iterations: 2 };

beforeEach(() => {
  const sandbox = join(tmpdir(), "amo-studio-sandbox"); mkdirSync(sandbox, { recursive: true });
  root = mkdtempSync(join(sandbox, "claude-goal-recovery-"));
  store = new Store(":memory:");
  workspaceId = store.addWorkspace({ path: root, name: "Goal recovery" }).id;
  taskId = store.createTask({ title: "Goal recovery", workspaceId }).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Fixtures may deliberately retain an externally owned native hook; cleanup must never start its CLI to clear it.
  for (const session of store.listSessions()) if (session.goal) store.updateSession(session.id, { goal: null });
  await runtime?.closeAll(); runtime = undefined; store.close(); removeTempDir(root);
});

function seed(status: Session["status"], goal: SessionGoal | null = savedGoal, patch: Partial<Session> = {}): Session {
  const session = store.createSession({ taskId, topicId: null, workspaceId, profileId: profiles[0]!.id, runtime: patch.runtime ?? "claude", runtimeRef: patch.runtimeRef ?? "native-recovery", kind: "main", parentId: null, title: "Recovery", status, writer: "workbench" });
  store.updateSession(session.id, { goal, ...patch });
  if (patch.archivedAt) store.archiveSubtree(session.id);
  return store.getSession(session.id)!;
}

function recover(): ClaudeRuntime {
  runtime = new ClaudeRuntime({ store, profiles, providers: {}, credentials: new StaticCredentialReader({}), claudeHome: join(root, "claude") });
  return runtime;
}

describe("Claude Goal recovery without opening its conversation", () => {
  it.each(["running", "awaiting-answer", "awaiting-approval", "idle", "interrupted", "error", "completed"] as const)("clears false autonomous work after recovering a %s session", (status) => {
    const session = seed(status);
    const ensure = vi.spyOn(ClaudeRuntime.prototype as unknown as { ensureLive: () => unknown }, "ensureLive");
    recover();
    const recovered = store.getSession(session.id)!;
    expect(recovered.goal).toMatchObject({ ...savedGoal, status: "blocked", updatedAt: expect.any(Number), lastReason: expect.stringContaining("进程已退出") });
    expect(sessionMoving(recovered)).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("normalizes archived leftovers and preserves unrelated runtime and terminal ownership", async () => {
    const archived = seed("idle", savedGoal, { archivedAt: "2026-11-17T00:00:00.000Z" });
    const other = seed("idle", savedGoal, { runtime: "codex" });
    const terminal = seed("idle", savedGoal, { runtimeRef: "native-terminal", writer: "terminal-handoff" });
    recover();
    expect(store.getSession(archived.id)?.goal?.status).toBe("blocked");
    expect(store.getSession(other.id)?.goal).toEqual(savedGoal);
    expect(store.getSession(terminal.id)?.goal).toEqual(savedGoal);
    expect((await runtime!.getGoal(terminal.id)).goal).toEqual(savedGoal);
  });

  it("normalizes an archived terminal leftover but keeps an open shared terminal Goal", () => {
    const archived = seed("idle", savedGoal, { writer: "terminal-handoff", archivedAt: "2026-11-17T00:00:00.000Z" });
    const shared = seed("idle", savedGoal, { runtimeRef: "native-shared", writer: "terminal-shared" });
    recover();
    expect(store.getSession(archived.id)?.goal?.status).toBe("blocked");
    expect(store.getSession(shared.id)?.goal).toEqual(savedGoal);
  });

  it("does not invent a Goal for a session that never had one", () => {
    const session = seed("idle", null);
    recover();
    expect(store.getSession(session.id)?.goal).toBeNull();
    expect(sessionMoving(store.getSession(session.id)!)).toBe(false);
  });

  it.each(["paused", "complete", "blocked", "usageLimited", "budgetLimited"] as const)("keeps a saved %s result intact", (status) => {
    const goal = { ...savedGoal, status, lastReason: "Saved native result" }, session = seed("idle", goal);
    recover();
    expect(store.getSession(session.id)?.goal).toEqual(goal);
    expect(sessionMoving(store.getSession(session.id)!)).toBe(false);
  });

  it.each(["inquiry", "notification"] as const)("allows a %s to reach dispatch after recovery without a Goal GET", async (purpose) => {
    const session = seed("running");
    const recovered = recover();
    const send = vi.spyOn(recovered, "sendMessage").mockResolvedValue({ mode: "start" });
    const router = RuntimeRouter.around(store, recovered);
    await expect(router.sendMessage(session.id, "Read the recovered result", [], { purpose })).resolves.toEqual({ mode: "start" });
    expect(send).toHaveBeenCalledWith(session.id, "Read the recovered result", [], expect.objectContaining({ purpose }));
    expect(store.getSession(session.id)?.goal?.status).toBe("blocked");
  });
});
