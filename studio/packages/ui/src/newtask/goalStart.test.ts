import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session, Task } from "@amo-studio/protocol";
import { emptyDraft, submitDraft } from "./draft.js";
import { activateDraftGoal, draftGoalInput, existingGoalStart, GoalStartError, readPendingGoalStart, savePendingGoalStart } from "./goalStart.js";

const link = { url: "http://localhost:47999", token: "test" };
const profile = { id: "codex-test", label: "Codex", runtime: "codex" as const, provider: null, model: null };
const task = { id: "task-test", topicId: null, archivedAt: null } as Task;
const session = { id: "session-test", taskId: task.id, archivedAt: null } as Session;
const fetcher = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const budgets = { tokenBudget: "12000", roundBudget: "8" };

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); fetcher.mockReset(); });

describe("new-task native Goal startup", () => {
  it.each([
    ["codex", { tokenBudget: 12000 }], ["dsh", { roundBudget: 8 }], ["claude", {}],
  ] as const)("sends only the budget supported by %s", (runtime, budget) => {
    expect(draftGoalInput("  完成验证  ", budgets, runtime)).toEqual({ objective: "完成验证", status: "active", ...budget });
  });

  it.each(["0", "-1", "1.5", "no", "9007199254740992"])("rejects invalid budget %s before any task is made", async (tokenBudget) => {
    await expect(submitDraft(link, { ...emptyDraft([profile]), text: "目标", goal: { ...budgets, tokenBudget } }, false, false, [], undefined, undefined, "codex")).rejects.toThrow("大于 0 的整数");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates objectives and the runtime", () => {
    expect(draftGoalInput("🎯".repeat(4000), { tokenBudget: "", roundBudget: "" }, "codex").objective).toHaveLength(8000);
    expect(() => draftGoalInput("目".repeat(4001), budgets, "codex")).toThrow("4000");
    expect(() => draftGoalInput("off", budgets, "claude")).toThrow("清除命令");
    expect(() => draftGoalInput("目标", budgets, "pi")).toThrow("尚未接入");
  });

  it("starts an empty session then activates Goal without sending the objective twice", async () => {
    fetcher.mockResolvedValueOnce(reply({ task, session })).mockResolvedValueOnce(reply({ goal: { objective: "目标" } }));
    await submitDraft(link, { ...emptyDraft([profile]), text: "目标", goal: budgets }, false, false, [], undefined, undefined, "codex");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ title: "目标", description: "目标", firstSession: { profileId: profile.id } });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).firstSession.text).toBeUndefined();
    expect(fetcher.mock.calls[1]![0]).toBe(`${link.url}/api/sessions/${session.id}/goal`);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ objective: "目标", status: "active", tokenBudget: 12000 });
    expect(readPendingGoalStart()).toBeNull();
  });

  it("preserves a failed creation for recovery, and refuses duplicate creation", async () => {
    fetcher.mockResolvedValueOnce(reply({ task, session })).mockResolvedValueOnce(reply({ error: { code: "not_found", message: "no route" } }, 404));
    const draft = { ...emptyDraft([profile]), text: "目标", goal: budgets };
    await expect(submitDraft(link, draft, false, false, [], undefined, undefined, "codex")).rejects.toBeInstanceOf(GoalStartError);
    const pending = readPendingGoalStart()!;
    expect(pending).toMatchObject({ taskId: task.id, sessionId: session.id, goal: { objective: "目标" } });
    await expect(submitDraft(link, draft, false)).rejects.toThrow("尚未完成");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(reply({ tasks: [task], sessions: [session] })).mockResolvedValueOnce(reply({ goal: { objective: "目标" } }));
    expect(await existingGoalStart(link, pending)).toEqual({ task, session });
    await activateDraftGoal(link, pending);
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(readPendingGoalStart()).toBeNull();
  });

  it("rejects filing, resumed sessions and pictures before creating a task", async () => {
    const draft = { ...emptyDraft([profile]), text: "目标", goal: budgets };
    await expect(submitDraft(link, draft, true)).rejects.toThrow("不能放进待办");
    await expect(submitDraft(link, draft, false, false, ["image"])).rejects.toThrow("暂不带图片");
    await expect(submitDraft(link, draft, false, false, [], "resume")).rejects.toThrow("会话内开启");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("recovers a canvas failure without creating or activating another session", async () => {
    const pending = { taskId: task.id, sessionId: session.id, goal: { objective: "目标", status: "active" as const }, onCanvas: true };
    savePendingGoalStart(pending);
    fetcher.mockResolvedValueOnce(reply({ error: { code: "runtime_error", message: "画布失败" } }, 500));
    await expect(activateDraftGoal(link, pending)).rejects.toThrow("画布失败");
    expect(readPendingGoalStart()).toEqual(pending);
    expect(fetcher.mock.calls[0]![0]).toBe(`${link.url}/api/tasks/${task.id}/canvas`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ goal: null })).mockResolvedValueOnce(reply({ goal: { objective: "目标" } }));
    await activateDraftGoal(link, pending, true);
    expect(fetcher.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "PUT", "GET", "PUT"]);
    expect(readPendingGoalStart()).toBeNull();
  });

  it.each(["paused", "complete"])("does not reactivate a %s Goal after its response was lost", async (status) => {
    const pending = { taskId: task.id, sessionId: session.id, goal: { objective: "目标", status: "active" as const } };
    savePendingGoalStart(pending);
    fetcher.mockResolvedValueOnce(reply({ goal: { objective: "目标", status } }));
    await activateDraftGoal(link, pending, true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.method).toBe("GET");
    expect(readPendingGoalStart()).toBeNull();
  });

  it("keeps ordinary starts unchanged", async () => {
    savePendingGoalStart(null);
    fetcher.mockResolvedValueOnce(reply({ task, session }));
    await submitDraft(link, { ...emptyDraft([profile]), text: "普通消息" }, false);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).firstSession.text).toBe("普通消息");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
