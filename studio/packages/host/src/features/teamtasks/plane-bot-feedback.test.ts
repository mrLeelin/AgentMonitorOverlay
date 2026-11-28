import { afterEach, expect, it, vi } from "vitest";
import type { FeatureHost } from "../../core/feature.js";
import { Store } from "../../store/store.js";
import type { TeamBoardHost } from "./board.js";
import { PlaneBotFeedback } from "./plane-bot-feedback.js";

const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const ws = store.addWorkspace({ name: "demo", path: "C:/fixture" });
  const task = store.createTask({ workspaceId: ws.id, title: "D-1", column: "done" });
  store.db.prepare(`INSERT INTO plane_bot_jobs
    (id,request_id,source,viewer_id,item_id,bot_id,workspace_id,prompt,item_data,root_task_id,sent_result_id,manual_intake)
    VALUES ('job','req','server','person','item','bot',?,'','{}',?,'r1',1)`).run(ws.id, task.id);
  store.db.prepare("INSERT INTO plane_bot_writebacks (job_id,result_id,started_at,comment_id) VALUES ('job','r1','start','receipt')").run();
  let stage: "accepted" | "returned" | "submitted" = "accepted";
  const host = {
    store, transaction: <T>(fn: () => T) => store.transaction(fn), requireTeamTasks: () => {}, teamTasksEnabled: () => true,
    publish: vi.fn(), botLeads: { currentTerm: () => ({ termId: "term", generation: 1, botId: "bot" }), appoint: vi.fn() },
    orchestration: { currentUserAcceptance: () => stage === "accepted", results: () => [{ id: "r1", state: stage }],
      reviewByUser: vi.fn() },
    tasks: { updateTask: () => { stage = "returned"; store.updateTask(task.id, { column: "doing" }); } },
  };
  const read = vi.fn<() => Promise<{ status: "waiting" | "confirmed"; commentId?: string }>>().mockResolvedValue({ status: "waiting" });
  const start = vi.fn(async () => ({ number: "D-1", comments: [{ id: "old", author: "李四", text: "旧反馈" },
    { id: "receipt", author: "本人", text: "本轮交付" }, { id: "new", author: "李四", text: "点击按钮没反应" },
    { id: "system", author: "本人", text: "接单回执", isBotWorkflow: true }] }));
  const board = { planeBotTarget: () => ({ source: "server", viewerId: "person" }), readPlaneBotFeedback: read, startPlaneBotItem: start };
  const service = new PlaneBotFeedback(host as unknown as FeatureHost<"orchestration" | "botLeads" | "tasks">, board as unknown as TeamBoardHost);
  return { store, task, host, read, start, service, setStage: (s: typeof stage) => { stage = s; } };
}

it("routes a human's engineering review directly back to the same root", async () => {
  const { service, host, setStage, read, start, task } = fixture();
  setStage("submitted");
  await service.submit("bot", "job", "r1", "重进界面后仍然错位");
  expect(host.orchestration.reviewByUser).toHaveBeenCalledWith(task.id, "r1", false, "重进界面后仍然错位");
  expect(read).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it("reopens once on demand, with current comments and a stable operation on the original lead", async () => {
  const { service, start, host, task } = fixture();
  await Promise.all([service.submit("bot", "job", "r1", "看李四的评论"), service.submit("bot", "job", "r1", "看李四的评论")]);
  await service.submit("bot", "job", "r1", "看李四的评论");
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith("server", "item", "person", "r1");
  expect(host.botLeads.appoint).toHaveBeenCalledOnce();
  expect(host.botLeads.appoint).toHaveBeenCalledWith(expect.objectContaining({
    taskId: task.id, purpose: "reopen", expectedTerm: { termId: "term", generation: 1 }, text: expect.stringContaining("李四：点击按钮没反应"),
  }));
  expect(JSON.stringify(host.botLeads.appoint.mock.calls)).not.toContain("旧反馈");
  expect(JSON.stringify(host.botLeads.appoint.mock.calls)).not.toContain("接单回执");
});

it("never dispatches work just because feedback is polled and records requester confirmation for this result", async () => {
  const { store, read, start, service, host } = fixture();
  read.mockResolvedValue({ status: "confirmed", commentId: "creator-id" });
  service.refresh();
  await vi.waitFor(() => expect(store.db.prepare("SELECT requester_comment_id FROM plane_bot_writebacks").get()).toEqual({ requester_comment_id: "creator-id" }));
  expect(host.publish).toHaveBeenCalledWith(expect.objectContaining({ type: "plane.bot.changed", itemId: "item" }));
  await expect(service.submit("bot", "job", "r1", "看最新评论")).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
  expect(host.botLeads.appoint).not.toHaveBeenCalled();
});

it("restores a previously requested rework after the Plane reply was lost", async () => {
  const { store, start, host, service } = fixture();
  start.mockRejectedValueOnce(new Error("lost response"));
  await expect(service.submit("bot", "job", "r1", "看最新评论")).rejects.toThrow("lost response");
  expect(store.db.prepare("SELECT rework_text FROM plane_bot_writebacks").get()).toEqual({ rework_text: "看最新评论" });
  service.refresh();
  await vi.waitFor(() => expect(host.botLeads.appoint).toHaveBeenCalledOnce());
  expect(start).toHaveBeenCalledTimes(2);
});

it("ignores a delayed creator response after the local root has started a new round", async () => {
  const { store, read, host, service, setStage } = fixture();
  let answer!: () => void;
  read.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ status: "confirmed", commentId: "old" }); }));
  service.refresh();
  setStage("returned");
  answer();
  await new Promise((resolve) => setImmediate(resolve));
  expect(store.db.prepare("SELECT requester_comment_id FROM plane_bot_writebacks").get()).toEqual({ requester_comment_id: null });
  expect(host.publish).not.toHaveBeenCalled();
});
