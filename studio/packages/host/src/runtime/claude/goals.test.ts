import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { removeTempDir } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import type { ClaudeCore } from "./core.js";
import type { Live } from "./live.js";
import { ClaudeGoals, GoalJournal } from "./goals.js";

const roots: string[] = [], cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); for (const root of roots.splice(0)) removeTempDir(root); vi.restoreAllMocks(); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "amo-studio-test-goal-journal-")); roots.push(path); return path; };

function harness(ready = Promise.resolve()) {
  const home = root(), store = new Store(":memory:");
  const workspace = store.addWorkspace({ path: home, name: "Goal" }), task = store.createTask({ workspaceId: workspace.id, title: "Goal" });
  const session = store.createSession({ taskId: task.id, topicId: null, profileId: "claude", workspaceId: workspace.id, runtime: "claude", runtimeRef: "native-goal", kind: "main", parentId: null, title: "Goal", status: "idle", writer: "workbench" });
  const sent: Array<{ content: unknown; uuid: string }> = [];
  const live = { running: false, ready, capabilities: new Set(["interrupt_send_now_v1"]), q: { supportedCommands: async () => [{ name: "goal" }] }, push: (input: { content: unknown; uuid: string }) => sent.push(input) } as unknown as Live;
  const core = { store, live: new Map([[session.id, live]]), closing: new Map(), now: () => new Date(), requireSession: (id: string) => store.getSession(id)!, updateSession: store.updateSession.bind(store), homeOf: () => ({ dir: home }), ensureLive: () => live, clearIdle: () => undefined, emitTransient: () => undefined, appendItem: () => undefined, log: () => undefined } as unknown as ClaudeCore;
  const settled = vi.fn();
  const goals = new ClaudeGoals(core, core.requireSession, settled);
  cleanups.push(() => { goals.dispose(); store.close(); });
  const ack = (index: number, args: string, output: string, timestamp?: string) => {
    goals.observe(session.id, live, { type: "command_lifecycle", state: "started", command_uuid: sent[index]!.uuid } as unknown as SDKMessage);
    goals.observe(session.id, live, { type: "assistant", ...(timestamp ? { timestamp } : {}), local_command_run: { command: "goal", args }, local_command_source: `<local-command-stdout>${output}</local-command-stdout>` } as unknown as SDKMessage);
  };
  return { goals, id: session.id, sent, ack, home, core, live, settled };
}

describe("Claude Goal native journal and action ordering", () => {
  it("reads only complete structured attachments and preserves UTF-8 split across writes", () => {
    const home = root(), path = join(home, "projects", "workspace");
    mkdirSync(path, { recursive: true });
    const file = join(path, "native-goal.jsonl"), journal = new GoalJournal(home, "native-goal");
    const row = Buffer.from(JSON.stringify({ type: "attachment", attachment: { type: "goal_status", condition: "完成中文目标", met: true, iterations: 2 } }) + "\n");
    const cut = row.indexOf(Buffer.from("中")) + 1;
    writeFileSync(file, row.subarray(0, cut));
    expect(journal.read()).toEqual([]);
    appendFileSync(file, row.subarray(cut));
    expect(journal.read()).toEqual([{ type: "goal_status", condition: "完成中文目标", met: true, iterations: 2 }]);
    expect(journal.read()).toEqual([]);
    appendFileSync(file, JSON.stringify({ type: "user", message: { content: "goal_status met:true" } }) + "\n");
    expect(journal.read()).toEqual([]);
  });

  it("cancels activation before dispatch when Stop occurs during process initialization", async () => {
    let initialize!: () => void;
    const { goals, id, sent } = harness(new Promise<void>((resolve) => { initialize = resolve; }));
    const activation = goals.set(id, { objective: "Do the work", status: "active" });
    const rejected = expect(activation).rejects.toThrow("已取消");
    await Promise.resolve();
    goals.invalidate(id);
    initialize();
    await rejected;
    expect(sent).toEqual([]);
  });

  it("waits for an already-dispatched setter before clearing so Stop cannot leave a queued reactivation", async () => {
    const { goals, id, sent, ack } = harness();
    const activating = goals.set(id, { objective: "Do the work", status: "active" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const pausing = goals.pause(id);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    ack(0, "Do the work", "Goal set: Do the work");
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.content).toBe("/goal clear");
    ack(1, "clear", "Goal cleared: Do the work");
    await activating;
    expect((await pausing).goal?.status).toBe("paused");
  });

  it("checks frozen dispatch authorization again after asynchronous initialization", async () => {
    const { goals, id, sent } = harness();
    let checks = 0;
    await expect(goals.set(id, { objective: "Do work" }, () => { if (++checks >= 3) throw new Error("requirements changed"); })).rejects.toThrow("requirements changed");
    expect(sent).toEqual([]);
  });

  it("coalesces concurrent cold reads instead of returning a command conflict", async () => {
    const { goals, id, sent, ack } = harness();
    const first = goals.get(id), second = goals.get(id);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    ack(0, "", "No goal set. Usage: `/goal <condition>`");
    expect((await first).goal).toBeNull();
    expect((await second).goal).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it.each(["Do the work", "A different objective"])("ignores delayed clear/evaluation rows from the prior Goal after resuming %s", async (objective) => {
    const { goals, id, sent, ack, home, settled } = harness();
    const activate = goals.set(id, { objective: "Do the work", status: "active" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    ack(0, "Do the work", "Goal set: Do the work", "2026-11-16T12:00:00.000Z");
    await activate;
    const pause = goals.pause(id);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    ack(1, "clear", "Goal cleared: Do the work", "2026-11-16T12:00:01.000Z");
    await pause;
    const resume = goals.set(id, { objective, status: "active" });
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    ack(2, objective, `Goal set: ${objective}`, "2026-11-16T12:00:02.000Z");
    await resume;
    const path = join(home, "projects", "workspace"); mkdirSync(path, { recursive: true });
    const file = join(path, "native-goal.jsonl");
    writeFileSync(file, [
      { timestamp: "2026-11-16T12:00:00.800Z", attachment: { type: "goal_status", met: true, condition: "Do the work", iterations: 1, tokens: 40, durationMs: 50 } },
      { timestamp: "2026-11-16T12:00:01.000Z", attachment: { type: "goal_status", met: true, sentinel: true, condition: "Do the work" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    goals.refresh(id);
    expect(goals.state(id).goal).toMatchObject({ objective, status: "active" });
    settled.mockClear();
    appendFileSync(file, JSON.stringify({ timestamp: "2026-11-16T12:00:03.000Z", attachment: { type: "goal_status", met: true, condition: objective, tokens: 80, durationMs: 200 } }) + "\n");
    goals.refresh(id);
    expect(goals.state(id).goal).toMatchObject({ objective, status: "complete", tokensUsed: 80 });
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("marks an exited process as blocked without claiming its persisted hook was cleared", async () => {
    const { goals, id, sent, ack } = harness();
    const activate = goals.set(id, { objective: "Do the work", status: "active" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    ack(0, "Do the work", "Goal set: Do the work"); await activate;
    goals.closed(id);
    expect(goals.state(id).goal).toMatchObject({ status: "blocked", lastReason: expect.stringContaining("原生目标仍保留") });
    const read = goals.get(id);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    ack(1, "", "Goal active: Do the work (not yet evaluated)");
    expect((await read).goal?.status).toBe("blocked");
  });

  it("cancels shutdown-time activation that has not reached the native input queue", async () => {
    let initialize!: () => void;
    const { goals, id, sent } = harness(new Promise<void>((resolve) => { initialize = resolve; }));
    const activate = goals.set(id, { objective: "Do the work", status: "active" });
    const rejected = expect(activate).rejects.toThrow("已关闭");
    await Promise.resolve();
    goals.dispose(); initialize();
    await rejected;
    expect(sent).toEqual([]);
  });
});
