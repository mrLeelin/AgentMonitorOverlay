import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotLeadTerm, ModelProfile, Task } from "@amo-studio/protocol";
import { managementRoot } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { bindLeadFixture } from "../botleads/lead.test-support.js";
import { roleCard } from "../guide/role.js";
import { guideText, WORKFLOW_READING_GUIDE } from "../guide/guide.js";
import { queueMessagePurpose } from "../../runtime/message-purpose.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, workspaceId: string, topicId: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-workflow-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  workspaceId = store.addWorkspace({ name: "游戏", path: folder }).id;
  topicId = service.topics.createTopic({ title: "一天做游戏" }).id;
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });
const task = (title: string, lead = false, managerTaskId: string | null = null) => store.createTask({ title, lead, managerTaskId, workspaceId, topicId });
const session = (owner: Task) => bindLeadFixture(service, store.createSession({ taskId: owner.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId, title: owner.title, status: "idle", writer: "workbench", runtimeRef: null }));
const delivery = () => vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });

const termFor = (owner: Task, sessionId: string, botId: string, generation = 1, runState: BotLeadTerm["runState"] = "idle"): BotLeadTerm => ({
  termId: `test-term-${owner.id}-${generation}`, taskId: owner.id, botId, name: botId, sessionId, generation, state: "active", runState, source: { kind: "manual" }, handoff: "", startedAt: new Date().toISOString(), endedAt: null,
  snapshot: { name: botId, avatar: null, purpose: "管理交付", profileId: "test", skills: [], runtime: "codex", options: { permission: "read-only" } },
});

function setTerms(terms: Map<string, BotLeadTerm>): void {
  service.orchestration.currentTerm = (id) => terms.get(id) ?? null;
  service.orchestration.assertManagementSession = (sessionId, expected) => {
    const owner = store.getSession(sessionId)?.taskId;
    const term = owner ? terms.get(owner) : undefined;
    if (!term || term.sessionId !== sessionId || expected?.termId !== term.termId || expected.generation !== term.generation || term.runState === "paused") throw new Error("任期已经变更");
    return term;
  };
}

const summaryInputs = { waitingFor: () => [], waitingForWorktree: () => [] };

function requireNextRootVersion(sessionId: string, taskId: string): void {
  const draft = service.sharedContext.save(sessionId, { rootTaskId: taskId, title: "共同需求", baseRevision: 0, body: "三枚投币", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户目标" }] });
  const first = service.sharedContext.publishVersion(sessionId, draft.id, draft.revision);
  service.sharedContext.apply(sessionId, { contextId: first.id, version: 1, taskIds: [taskId] });
  service.sharedContext.getForSession(sessionId);
  service.sharedContext.adopt(sessionId, { contextId: first.id, version: 1 });
  const changed = service.sharedContext.save(sessionId, { rootTaskId: taskId, title: "共同需求", baseRevision: first.revision, body: "五枚投币", changeNote: "调整数量", sources: [{ kind: "user_requirement", source: "用户调整" }] });
  service.sharedContext.publishVersion(sessionId, changed.id, changed.revision);
  service.sharedContext.apply(sessionId, { contextId: first.id, version: 2, taskIds: [taskId] });
}

describe("managed delivery workflow", () => {
  it("binds cursors to one root, branch and revision; pages evidence without sending the whole tree", () => {
    delivery();
    const top = task("总主控", true), manager = session(top), branch = task("中控", true, top.id);
    const worker = task("执行", false, top.id), nested = task("下辖执行", false, branch.id), other = task("同专题另一棵树", true);
    store.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", branch.id);
    const workSession = session(worker), evidence = { taskId: worker.id, sessionId: workSession.id, cwd: folder, baseCommit: "mock-base" };
    service.orchestration.verifyWorktrees = (_task, _session, input) => input ? [evidence] : undefined;
    const result = service.orchestration.submit(workSession.id, "摘要正文", "有完整记录", { worktrees: [evidence] });
    service.orchestration.review(manager.id, result.id, true, "已核对");
    const page = service.orchestration.workflowSummaryPage(top.id, { limit: 1 }, summaryInputs);
    expect(page).toMatchObject({ rootTaskId: top.id, parentTaskId: null, counts: { directTasks: 2, executionTasks: 2, acceptedExecutionTasks: 1 }, pendingUserReviewResultId: null });
    expect(page.tasks.map((row) => row.taskId)).toEqual([top.id, branch.id]);
    expect(page.tasks[1]?.directTaskCount).toBe(1);
    const last = service.orchestration.workflowSummaryPage(top.id, { limit: 1, cursor: page.nextCursor! }, summaryInputs);
    expect(last.tasks).toEqual([expect.objectContaining({ taskId: worker.id, acceptedCurrent: true, latestResult: expect.objectContaining({ id: result.id }) })]);
    expect(last.tasks[0]!.latestResult).not.toHaveProperty("worktrees");
    expect(last.tasks[0]!.latestResult).not.toHaveProperty("summary");
    expect(JSON.parse(service.orchestration.readResult(top.id, result.id).text)).toHaveProperty("worktrees", [evidence]);
    expect(service.orchestration.workflowSummaryPage(top.id, { parentTaskId: branch.id }, summaryInputs).tasks.map((row) => row.taskId)).toEqual([nested.id]);
    expect(() => service.orchestration.workflowSummaryPage(top.id, { parentTaskId: branch.id, cursor: page.nextCursor! }, summaryInputs)).toThrow(/分页已过期/);
    expect(() => service.orchestration.workflowSummaryPage(other.id, { cursor: page.nextCursor! }, summaryInputs)).toThrow(/分页已过期/);
    expect(() => service.orchestration.workflowSummaryPage(top.id, { parentTaskId: other.id }, summaryInputs)).toThrow(/移出/);
    store.updateTask(other.id, { title: "旁支改名" });
    service.publish({ type: "session.upserted", session: session(other) });
    expect(service.orchestration.workflowSummaryPage(top.id, { cursor: page.nextCursor! }, summaryInputs).tasks[0]?.taskId).toBe(worker.id);
    service.publish({ type: "session.upserted", session: store.updateSession(workSession.id, { status: "completed" }) });
    expect(() => service.orchestration.workflowSummaryPage(top.id, { cursor: page.nextCursor! }, summaryInputs)).toThrow(/分页已过期/);
    const nextPage = service.orchestration.workflowSummaryPage(top.id, { limit: 1 }, summaryInputs);
    store.updateTask(worker.id, { title: "树内改名" });
    expect(() => service.orchestration.workflowSummaryPage(top.id, { cursor: nextPage.nextCursor! }, summaryInputs)).toThrow(/分页已过期/);
  });

  it("rejects stale appointed sessions and a successor that authored the same result under another term", () => {
    delivery();
    const top = task("总主控", true), branch = task("中控", true, top.id);
    const oldManager = session(top), currentManager = session(top), worker = session(branch);
    const terms = new Map([[top.id, termFor(top, currentManager.id, "接任的机器人", 2)], [branch.id, termFor(branch, worker.id, "提交的机器人")]]);
    setTerms(terms);
    const result = service.orchestration.submit(worker.id, "中控汇总", "隔离验证");
    expect(result.submittedByLead).toEqual({ termId: terms.get(branch.id)!.termId, generation: 1, botId: "提交的机器人", name: "提交的机器人" });
    expect(() => service.orchestration.review(oldManager.id, result.id, true, "旧会话")).toThrow(/任期/);
    terms.set(branch.id, termFor(branch, session(branch).id, "另一位机器人", 2));
    terms.set(top.id, termFor(top, currentManager.id, "提交的机器人", 3));
    expect(() => service.orchestration.review(currentManager.id, result.id, true, "同一机器人")).toThrow(/需要另一位主控验收/);
    expect(() => service.orchestration.submit(worker.id, "中控汇总", "隔离验证")).toThrow(/任期/);
    terms.set(top.id, termFor(top, currentManager.id, "接任的机器人", 4));
    const accepted = service.orchestration.review(currentManager.id, result.id, true, "现任通过");
    expect(accepted).toMatchObject({ id: result.id, state: "accepted", submittedByLead: result.submittedByLead });
    const final = service.orchestration.submit(currentManager.id, "根交付", "全部下辖已核对");
    expect(service.orchestration.workflowSummaryPage(top.id, {}, summaryInputs).pendingUserReviewResultId).toBe(final.id);
  });

  it("rolls back result and outbox when transactional task-state update fails", () => {
    delivery();
    const top = task("总主控", true), worker = task("执行", false, top.id), executing = session(worker);
    const fault = vi.spyOn(service.tasks, "updateTask").mockImplementationOnce(() => { throw new Error("模拟状态写入失败"); });
    expect(() => service.orchestration.submit(executing.id, "摘要", "证据")).toThrow(/状态写入失败/);
    expect(service.orchestration.results(worker.id)).toEqual([]);
    expect(service.orchestration.workflow(top.id).deliveryNotices).toEqual([]);
    fault.mockRestore();
    const result = service.orchestration.submit(executing.id, "摘要", "证据");
    expect(service.orchestration.results(worker.id)).toEqual([result]);
  });

  it("does not project a root pending review when a nested accepted prerequisite is now stale", () => {
    delivery();
    const top = task("总主控", true), branch = task("中控", true, top.id), child = task("下辖执行", false, branch.id);
    const manager = session(top), coordinator = session(branch), worker = session(child);
    const result = service.orchestration.submit(worker.id, "执行交付", "证据");
    service.orchestration.review(coordinator.id, result.id, true, "逐层通过");
    const middle = service.orchestration.submit(coordinator.id, "中控汇总", "证据");
    service.orchestration.review(manager.id, middle.id, true, "直属通过");
    const final = service.orchestration.submit(manager.id, "最终交付", "证据");
    expect(service.orchestration.workflowSummaryPage(top.id, {}, summaryInputs).pendingUserReviewResultId).toBe(final.id);
    service.sharedContext.setPrerequisites(child.id, ["新的前置交付"]);
    const stale = service.orchestration.workflowSummaryPage(top.id, {}, summaryInputs);
    expect(stale.pendingUserReviewResultId).toBeNull();
    expect(stale.tasks.find((row) => row.taskId === branch.id)?.acceptedCurrent).toBe(false);
    expect(() => service.orchestration.reviewByUser(top.id, final.id, true, "忽略失效的下辖")).toThrow(/下辖未就绪/);
  });

  it("reopens both final deliveries when a previously accepted child transfers between roots", () => {
    delivery();
    const top = task("总主控", true), other = task("另一棵树", true), child = task("下辖执行", false, top.id);
    const manager = session(top), receiving = session(other), worker = session(child);
    const deliveryResult = service.orchestration.submit(worker.id, "执行交付", "隔离证据");
    service.orchestration.review(manager.id, deliveryResult.id, true, "直属通过");
    const first = service.orchestration.submit(manager.id, "原根汇总", "包含执行证据");
    const second = service.orchestration.submit(receiving.id, "接收根汇总", "原有目标完成");
    for (const rootResult of [first, second]) service.orchestration.reviewByUser(rootResult.taskId, rootResult.id, true, "人工通过");
    service.tasks.setManager(child.id, other.id);
    for (const rootResult of [first, second]) {
      expect(service.orchestration.results(rootResult.taskId).at(-1)).toMatchObject({ id: rootResult.id, state: "returned", userReview: { state: "accepted", review: "人工通过" } });
      expect(store.getTask(rootResult.taskId)?.column).toBe("doing");
    }
  });

  it("rechecks appointed notice target when a held result batch survives a term change", async () => {
    const top = task("总主控", true), original = session(top), replacement = session(top);
    const other = session(top);
    service.sessions.inbox.pause(original.id);
    service.sessions.inbox.pause(replacement.id);
    const terms = new Map([[top.id, termFor(top, original.id, "第一位机器人")]]);
    setTerms(terms);
    const results = [task("任务一", false, top.id), task("任务二", false, top.id)].map((child) => service.orchestration.submit(session(child).id, "摘要", "证据"));
    await vi.waitFor(() => expect(service.sessions.inbox.held(original.id)).toHaveLength(1));
    const old = service.sessions.inbox.held(original.id)[0]!;
    expect(old).toMatchObject({ text: expect.stringContaining("2 个任务") });
    expect(service.sessions.inbox.held(other.id)).toEqual([]);
    terms.set(top.id, termFor(top, replacement.id, "第二位机器人", 2, "paused"));
    service.publish({ type: "bot-lead.changed", taskId: top.id, topicId, state: null });
    expect(store.getItem(old.id)).toMatchObject({ delivery: "expired" });
    expect(service.sessions.inbox.held(replacement.id)).toEqual([]);
    expect(() => service.orchestration.validateMessage({ id: old.id, sessionId: original.id })).toThrow(/任期/);
    terms.set(top.id, termFor(top, replacement.id, "第二位机器人", 2));
    service.publish({ type: "bot-lead.changed", taskId: top.id, topicId, state: null });
    await vi.waitFor(() => expect(service.sessions.inbox.held(replacement.id)).toHaveLength(1));
    const next = service.sessions.inbox.held(replacement.id)[0]!;
    for (const result of results) expect(next).toMatchObject({ text: expect.stringContaining(result.id) });
    expect(next).toMatchObject({ replacesItemId: old.id });
    expect(service.sessions.inbox.held(original.id)).toEqual([]);
    expect(service.sessions.inbox.held(other.id)).toEqual([]);
  });

  it("reroutes an open decision on initial assignment and transfer back without reusing a revoked receipt", async () => {
    const first = task("第一位主控", true), second = task("第二位主控", true), child = task("独立任务");
    const initial = session(first), moved = session(second), worker = session(child);
    vi.spyOn(service.sessions.inbox, "canAutoDispatch").mockReturnValue(false);
    const decision = service.collab.requestDecisionFromSession(worker.id, "当前交付方式？", []);
    service.tasks.setManager(child.id, first.id);
    expect(store.getDecision(decision.id)?.routedToTaskId).toBe(first.id);
    await vi.waitFor(() => expect(service.sessions.inbox.held(initial.id)).toHaveLength(1));
    const initialRow = service.sessions.inbox.held(initial.id)[0]!;
    service.tasks.setManager(child.id, second.id);
    expect(store.getItem(initialRow.id)).toMatchObject({ delivery: "expired" });
    await vi.waitFor(() => expect(service.sessions.inbox.held(moved.id)).toHaveLength(1));
    service.tasks.setManager(child.id, first.id);
    await vi.waitFor(() => expect(service.sessions.inbox.held(initial.id)).toHaveLength(1));
    const newRow = service.sessions.inbox.held(initial.id)[0]!;
    expect(newRow).toMatchObject({ replacesItemId: initialRow.id, text: expect.stringContaining(decision.id) });
    expect(newRow.id).not.toBe(initialRow.id);
    expect(service.sessions.inbox.held(moved.id)).toEqual([]);
    expect(service.orchestration.answerDecision(initial.id, decision.id, "首次有效回答")).toMatchObject({ state: "answered", answer: "首次有效回答" });
    expect(store.getItem(newRow.id)).toMatchObject({ delivery: "expired" });
  });
  it.each([false, true])("does not duplicate a same-turn routed decision with a completed status report (answered=%s)", async (answered) => {
    const send = delivery(), top = task("主控", true), child = task("规则确认", false, top.id);
    const manager = session(top), worker = session(child), at = new Date(Date.now() - 1000).toISOString();
    store.appendItem({ id: "question-turn", sessionId: worker.id, type: "turn", turnId: "rt", state: "completed", startedAt: at, endedAt: new Date().toISOString(), createdAt: at });
    const question = service.collab.requestDecisionFromSession(worker.id, "按折后金额判断？", ["是", "否"]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    if (answered) service.orchestration.answerDecision(manager.id, question.id, "是");
    send.mockClear();
    service.publish({ type: "session.upserted", session: store.getSession(worker.id)! });
    await Promise.resolve();
    expect(send.mock.calls.filter((c) => c[0] === manager.id)).toHaveLength(0);
    const notices = JSON.parse(store.getKv("orchestration.outbox")!.value);
    store.setKv("orchestration.outbox", JSON.stringify([...notices, { id: "old-question-status", sourceTaskId: child.id, targetTaskId: top.id, targetSessionId: manager.id, direction: "up", turnId: "question-turn", text: "旧版普通状态" }]));
    expect(() => service.orchestration.validateMessage({ id: "old-question-status", sessionId: manager.id })).toThrow(/管理通知/);
  });

  it.each(["failed", "interrupted"] as const)("still reports a %s worker turn after its business question", async (state) => {
    const send = delivery(), top = task("主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child), at = new Date(Date.now() - 1000).toISOString();
    store.appendItem({ id: "failed-question-turn", sessionId: worker.id, type: "turn", turnId: "rt", state, startedAt: at, endedAt: new Date().toISOString(), createdAt: at });
    service.collab.requestDecisionFromSession(worker.id, "当前问题", []);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    send.mockClear();
    service.publish({ type: "session.upserted", session: store.updateSession(worker.id, { status: state === "failed" ? "error" : "interrupted" }) });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(manager.id, expect.stringContaining(state), undefined, "i-failed-question-turn-manager", expect.objectContaining({ purpose: "notification" })));
  });

  it("still reports a later ordinary worker turn after an older business question", async () => {
    const send = delivery(), top = task("主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child);
    const question = service.collab.requestDecisionFromSession(worker.id, "旧问题", []);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    service.orchestration.answerDecision(manager.id, question.id, "已决定");
    send.mockClear();
    const at = new Date(Date.now() + 1000).toISOString();
    store.appendItem({ id: "later-turn", sessionId: worker.id, type: "turn", turnId: "rt-later", state: "completed", startedAt: at, endedAt: at, createdAt: at });
    service.publish({ type: "session.upserted", session: store.getSession(worker.id)! });
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(manager.id, expect.stringContaining("本轮状态"), undefined, "i-later-turn-manager", expect.objectContaining({ purpose: "notification" })));
  });

  it("does not wake an upstream lead for ordinary coordinator progress across multiple turns", async () => {
    const send = delivery(), top = task("总主控", true), middle = task("开发主控", true, top.id);
    session(top); const coordinator = session(middle);
    for (let index = 0; index < 3; index++) {
      const at = new Date(Date.now() + index * 1000).toISOString();
      store.appendItem({ id: `progress-turn-${index}`, sessionId: coordinator.id, type: "turn", turnId: `rt-${index}`, state: "completed", startedAt: at, endedAt: at, createdAt: at });
      store.appendItem({ id: `progress-reply-${index}`, sessionId: coordinator.id, type: "agent", streaming: false, markdown: "已派工，等待下级正式交付。", createdAt: at });
      service.publish({ type: "session.upserted", session: store.getSession(coordinator.id)! });
      await Promise.resolve();
    }
    expect(send).not.toHaveBeenCalled();
    expect(store.findItems(coordinator.id, "agent", {})).toHaveLength(3);
    const result = service.orchestration.submit(coordinator.id, "开发汇总", "验证通过");
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(result.id), undefined, expect.any(String), expect.objectContaining({ purpose: "notification" }));
  });

  it.each(["failed", "interrupted", "completed"] as const)("still reports %s worker turns and coordinator failures", async (state) => {
    const send = delivery(), top = task("总主控", true), child = task("下级", state !== "completed", top.id);
    const manager = session(top), worker = session(child), at = new Date().toISOString();
    store.appendItem({ id: "report-turn", sessionId: worker.id, type: "turn", turnId: "rt", state, startedAt: at, endedAt: at, createdAt: at, ...(state === "failed" ? { error: "执行失败" } : {}) });
    service.publish({ type: "session.upserted", session: store.updateSession(worker.id, { status: state === "failed" ? "error" : state === "interrupted" ? "interrupted" : "idle" }) });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith(manager.id, expect.stringContaining(state), undefined, "i-report-turn-manager", expect.objectContaining({ purpose: "notification" }));
  });

  it("revokes old held coordinator progress on Host reconstruction without discarding deliveries", async () => {
    const top = task("总主控", true), middle = task("开发主控", true, top.id);
    const manager = session(top), coordinator = session(middle), at = new Date().toISOString();
    store.updateSession(manager.id, { status: "running" });
    const turn = store.appendItem({ id: "old-progress", sessionId: coordinator.id, type: "turn", turnId: "rt", state: "completed", startedAt: at, endedAt: at, createdAt: at });
    store.setKv("orchestration.outbox", JSON.stringify([{ id: "old-notice", sourceTaskId: middle.id, targetTaskId: top.id, direction: "up", turnId: turn.id, text: "等待下级", sent: true, targetSessionId: manager.id }]));
    await service.sessions.inbox.put(manager.id, "等待下级", undefined, "old-notice");
    const restarted = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
    await Promise.resolve();
    expect(restarted.sessions.inbox.held(manager.id)).toHaveLength(0);
    expect(() => restarted.sessions.inbox.checkSource(store.getItem("old-notice")!)).toThrow(/管理通知/);
    const result = restarted.orchestration.submit(coordinator.id, "汇总", "验证通过");
    await vi.waitFor(() => expect(restarted.sessions.inbox.held(manager.id)).toHaveLength(1));
    expect(restarted.sessions.inbox.held(manager.id)[0]).toMatchObject({ text: expect.stringContaining(result.id) });
  });

  it("reads only the latest pending deliveries while preserving full history and stale accepted evidence", () => {
    delivery();
    const top = task("总主控", true), manager = session(top), child = task("执行", false, top.id), worker = session(child);
    const first = service.orchestration.submit(worker.id, "初稿", "待修订");
    service.orchestration.review(manager.id, first.id, false, "补充验证");
    expect(service.orchestration.workflow(top.id, "pending").results.map((r) => r.id)).toEqual([first.id]);
    const second = service.orchestration.submit(worker.id, "修订", "验证通过");
    expect(service.orchestration.workflow(top.id, "pending").results.map((r) => r.id)).toEqual([second.id]);
    service.orchestration.review(manager.id, second.id, true, "通过");
    expect(service.orchestration.workflow(top.id, "pending").results).toEqual([]);
    expect(service.orchestration.workflow(top.id).results.map((r) => r.id)).toEqual([first.id, second.id]);
    service.sharedContext.setPrerequisites(child.id, ["changed-prerequisite"]);
    expect(service.orchestration.workflow(top.id, "pending").results.map((r) => r.id)).toEqual([second.id]);
    store.updateTask(child.id, { archivedAt: new Date().toISOString() });
    expect(service.orchestration.workflow(top.id, "pending").results).toEqual([]);
  });

  it("checks the whole tree without delivery prose, including unfinished tasks, stale inputs and exact session creation", async () => {
    delivery();
    const top = task("总主控", true), manager = session(top), child = task("执行", false, top.id), worker = session(child);
    const waiting = task("下游未开工", false, top.id), unrelated = task("同专题非下辖");
    service.canvases.canvasAddDependency(child.id, waiting.id);
    const first = service.orchestration.submit(worker.id, "初稿", "补测");
    service.orchestration.review(manager.id, first.id, false, "退回");
    const submitted = service.orchestration.submit(worker.id, "摘要正文".repeat(2000), "验证正文".repeat(2000));
    const accepted = service.orchestration.review(manager.id, submitted.id, true, "通过");
    const tools = amoToolsFor(service, { sessionId: manager.id });
    const workflow = tools.find((t) => t.name === "task_workflow")!;
    const compact = JSON.parse((await workflow.run({ view: "summary" })).content[0]!.text);
    expect(compact.tasks.map((t: { taskId: string }) => t.taskId)).toEqual([top.id, child.id, waiting.id]);
    expect(compact.tasks.find((t: { taskId: string }) => t.taskId === child.id)).toMatchObject({ acceptedCurrent: true, latestResult: { id: accepted.id, state: "accepted" }, sessions: [{ id: worker.id, createdAt: worker.createdAt }] });
    expect(compact.tasks.find((t: { taskId: string }) => t.taskId === waiting.id)).toMatchObject({ acceptedCurrent: false, latestResult: null, sessions: [] });
    expect(JSON.stringify(compact)).not.toContain("摘要正文");
    expect(JSON.stringify(compact)).not.toContain("验证正文");
    expect(JSON.stringify(compact)).not.toContain(unrelated.id);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(service.orchestration.workflow(top.id)).length / 4);
    // The default and full callers still receive every byte of every historical result.
    const full = JSON.parse((await workflow.run({})).content[0]!.text);
    expect(full.results).toEqual([service.orchestration.results(child.id)[0], accepted]);
    service.sharedContext.setPrerequisites(child.id, ["new-input"]);
    const stale = service.orchestration.workflowSummary(top.id, service.taskPlans.waitingMap());
    expect(stale.tasks.find((t) => t.taskId === child.id)).toMatchObject({ acceptedCurrent: false, prerequisiteResultIds: ["new-input"] });
    expect(stale.tasks.find((t) => t.taskId === waiting.id)?.waitingForTaskIds).toEqual([child.id]);
    expect(roleCard(service, manager.id)).toContain(WORKFLOW_READING_GUIDE);
    expect(guideText("lead")).toContain(WORKFLOW_READING_GUIDE);
  });

  it("pages complete result JSON, preserves tails and history, and follows the current readable subtree", async () => {
    delivery();
    const top = task("总主控", true), manager = session(top), child = task("执行", false, top.id), worker = session(child);
    const first = service.orchestration.submit(worker.id, "摘要😀".repeat(1800) + "摘要尾部", "验证".repeat(4500) + "证据尾部");
    const returned = service.orchestration.review(manager.id, first.id, false, "退回尾部");
    const latest = service.orchestration.submit(worker.id, "新版", "新版证据");
    const read = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_read_result")!;
    let offset: number | null = 0, text = "";
    while (offset !== null) {
      const page = JSON.parse((await read.run({ resultId: first.id, offset })).content[0]!.text);
      expect(page.text.length).toBeLessThanOrEqual(6000);
      expect(page).toMatchObject({ latest: false, acceptedCurrent: false, result: { id: first.id } });
      text += page.text; offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toEqual(returned);
    expect(service.orchestration.readResult(top.id, first.id, text.length)).toMatchObject({ text: "", nextOffset: null });
    for (const invalid of [-1, 1.5, NaN, text.length + 1]) expect(() => service.orchestration.readResult(top.id, first.id, invalid)).toThrow(/位置无效/);
    expect(service.orchestration.readResult(top.id, latest.id)).toMatchObject({ latest: true });
    const other = task("另一个主控", true), stranger = session(other);
    expect(() => service.orchestration.readResult(other.id, first.id)).toThrow(/可读交付/);
    expect(() => service.orchestration.review(stranger.id, latest.id, true, "不可越权")).toThrow(/直属任务/);
    service.tasks.setManager(child.id, other.id);
    expect((await read.run({ resultId: first.id })).isError).toBe(true);
    // Explicit taskId has the same read access as the existing workflow tool; it never grants review rights.
    expect((await read.run({ taskId: child.id, resultId: first.id })).isError).not.toBe(true);
    store.updateTask(child.id, { archivedAt: new Date().toISOString() });
    expect(() => service.orchestration.readResult(other.id, first.id)).toThrow(/可读交付/);
  });

  it("adds later deliveries to a held batch and retains it across a Host reconstruction", async () => {
    const top = task("总主控", true), manager = session(top);
    store.updateSession(manager.id, { status: "running" });
    const first = service.orchestration.submit(session(task("第一项", false, top.id)).id, "完成一", "证据一");
    await vi.waitFor(() => expect(service.sessions.inbox.held(manager.id)).toHaveLength(1));
    const original = service.sessions.inbox.held(manager.id)[0]!;
    const second = service.orchestration.submit(session(task("第二项", false, top.id)).id, "完成二", "证据二");
    await vi.waitFor(() => expect(service.sessions.inbox.held(manager.id)[0]).toMatchObject({ text: expect.stringContaining(second.id) }));
    expect(service.sessions.inbox.held(manager.id)).toHaveLength(1);
    expect(service.sessions.inbox.held(manager.id)[0]).toMatchObject({ text: expect.stringContaining(first.id) });
    expect(service.sessions.inbox.held(manager.id)[0]).toMatchObject({ replacesItemId: original.id });
    expect(store.getItem(original.id)).toMatchObject({ delivery: "expired", text: original.type === "user" ? original.text : "" });
    const restored = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
    await Promise.resolve();
    expect(restored.sessions.inbox.held(manager.id)).toHaveLength(1);
  });

  it("coalesces simultaneous deliveries and rejects the notification once every result is handled", async () => {
    const top = task("总主控", true), manager = session(top);
    store.updateSession(manager.id, { status: "running" });
    const workers = Array.from({ length: 10 }, (_, index) => session(task(`执行${index}`, false, top.id)));
    const results = workers.map((worker) => service.orchestration.submit(worker.id, "完成", "验证通过"));
    await vi.waitFor(() => expect(service.sessions.inbox.held(manager.id)).toHaveLength(1));
    const [message] = service.sessions.inbox.held(manager.id);
    expect(message).toMatchObject({ text: expect.stringContaining("10 个任务") });
    for (const result of results.slice(0, 9)) service.orchestration.review(manager.id, result.id, true, "通过");
    expect(() => service.sessions.inbox.checkSource(store.getItem(message!.id)!)).not.toThrow();
    service.orchestration.review(manager.id, results[9]!.id, true, "通过");
    expect(() => service.sessions.inbox.checkSource(store.getItem(message!.id)!)).toThrow(/管理通知/);
    service.orchestration.submit(manager.id, "最终汇总", "全部检查通过");
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "idle" }) });
    await service.sessions.inbox.flush(manager.id);
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("submitted");
    expect(store.getTask(top.id)?.column).toBe("review");
  });

  it("pages a long reply for its current direct manager only", () => {
    const top = task("总主控", true), other = task("其他主控", true), child = task("执行", false, top.id);
    const manager = session(top), stranger = session(other), worker = session(child);
    store.appendItem({ id: "long-reply", sessionId: worker.id, type: "agent", streaming: false, markdown: "甲".repeat(6000) + "重要尾部", createdAt: new Date().toISOString() });
    const first = service.orchestration.readReply(manager.id, "long-reply");
    expect(first.text).toHaveLength(6000);
    expect(first.nextOffset).toBe(6000);
    expect(service.orchestration.readReply(manager.id, "long-reply", first.nextOffset!).text).toBe("重要尾部");
    expect(() => service.orchestration.readReply(stranger.id, "long-reply")).toThrow(/直属任务/);
    service.tasks.updateTask(child.id, { managerTaskId: other.id });
    expect(() => service.orchestration.readReply(manager.id, "long-reply")).toThrow(/直属任务/);
  });

  it("returns work for correction, accepts it at each level and only then completes the root", async () => {
    const send = delivery();
    const top = task("游戏总主控", true), audio = task("音效负责人", true, top.id), coin = task("投币音效", false, audio.id);
    const topSession = session(top), audioSession = session(audio), coinSession = session(coin);
    expect(() => service.orchestration.submit(topSession.id, "全部完成", "检查过")).toThrow(/先验收/);
    const first = service.orchestration.submit(coinSession.id, "生成投币音效", "试听：爆音");
    expect(store.getTask(coin.id)?.column).toBe("review");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(audioSession.id, expect.stringContaining(first.id), undefined, `i-${first.id}-submit`, { purpose: "notification" }));
    const returned = service.orchestration.review(audioSession.id, first.id, false, "去掉爆音");
    expect(returned.state).toBe("returned");
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(coinSession.id, expect.stringContaining("去掉爆音"), undefined, `i-${first.id}-return`, { purpose: "work" }));
    const second = service.orchestration.submit(coinSession.id, "修复投币音效", "试听无爆音，时长0.3秒");
    expect(() => service.orchestration.review(audioSession.id, first.id, true, "通过")).toThrow(/最新/);
    service.orchestration.review(audioSession.id, second.id, true, "试听通过");
    const audioResult = service.orchestration.submit(audioSession.id, "音效工作完成", "资源存在并试听通过");
    service.orchestration.review(topSession.id, audioResult.id, true, "集成后试听通过");
    const final = service.orchestration.submit(topSession.id, "游戏交付完成", "运行验证通过，附截图");
    expect(final.state).toBe("submitted");
    expect(store.getTask(top.id)?.column).toBe("review");
    expect(service.orchestration.reviewByUser(top.id, final.id, true, "用户集成验收通过").state).toBe("accepted");
    expect(store.getTask(top.id)?.column).toBe("done");
    expect(service.orchestration.workflow(top.id).results).toHaveLength(4);
  });

  it("deduplicates submissions and notifications and prevents bypassing acceptance with task_update", async () => {
    const send = delivery(), top = task("总主控", true), child = task("逻辑", false, top.id);
    session(top); const worker = session(child);
    const first = service.orchestration.submit(worker.id, "完成", "验证通过");
    expect(service.orchestration.submit(worker.id, "完成", "验证通过").id).toBe(first.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const update = amoToolsFor(service, { sessionId: worker.id }).find((t) => t.name === "task_update")!;
    expect(await update.run({ column: "done" })).toHaveProperty("isError", true);
    expect(store.getTask(child.id)?.column).toBe("review");
  });

  it("waits for the worker turn before notifying or accepting, and invalidates ancestors when accepted work restarts", async () => {
    const send = delivery(), top = task("总主控", true), child = task("逻辑", false, top.id);
    const manager = session(top), worker = session(child);
    store.updateSession(worker.id, { status: "running" });
    const result = service.orchestration.submit(worker.id, "完成", "验证通过");
    expect(() => service.orchestration.review(manager.id, result.id, true, "通过")).toThrow(/仍在工作/);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    store.updateSession(worker.id, { status: "idle" });
    service.publish({ type: "session.upserted", session: store.getSession(worker.id)! });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    service.orchestration.review(manager.id, result.id, true, "通过");
    service.orchestration.submit(manager.id, "总交付", "集成通过");
    service.tasks.updateTask(child.id, { column: "doing" });
    expect(store.getTask(top.id)?.column).toBe("doing");
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("returned");
    expect(() => service.orchestration.submit(manager.id, "总交付", "集成通过")).toThrow(/先验收/);
  });

  it("rejects sibling and stale managers, requiring a fresh submission after a transfer", () => {
    delivery();
    const top = task("总主控", true), a = task("资源", true, top.id), b = task("音效", true, top.id), child = task("执行", false, a.id);
    const sa = session(a), sb = session(b), sc = session(child); session(top);
    const result = service.orchestration.submit(sc.id, "完成", "验证通过");
    expect(() => service.orchestration.review(sb.id, result.id, true, "通过")).toThrow(/不属于/);
    service.tasks.updateTask(child.id, { managerTaskId: b.id });
    expect(() => service.orchestration.review(sa.id, result.id, true, "通过")).toThrow(/不属于/);
    const resubmitted = service.orchestration.submit(sc.id, "完成", "验证通过");
    expect(resubmitted.managerTaskId).toBe(b.id);
    expect(resubmitted.id).not.toBe(result.id);
    expect(service.orchestration.review(sb.id, resubmitted.id, true, "确认通过").state).toBe("accepted");
  });

  it("routes business questions to the direct manager, then allows upward escalation and a returned answer", async () => {
    const send = delivery(), top = task("总主控", true), middle = task("音效负责人", true, top.id), child = task("投币音效", false, middle.id);
    const st = session(top), sm = session(middle), sc = session(child);
    const question = service.collab.requestDecisionFromSession(sc.id, "需要什么音色？", ["卡通", "写实"], "参考：Audio/coin_old.wav");
    expect(question.routedToTaskId).toBe(middle.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(sm.id, expect.stringContaining(question.id), undefined, expect.any(String), { purpose: "notification" }));
    expect(send).toHaveBeenCalledWith(sm.id, expect.stringContaining('"detail":"参考：Audio/coin_old.wav'), undefined, expect.any(String), { purpose: "notification" });
    expect(service.orchestration.workflow(middle.id).decisions).toHaveLength(1);
    const escalate = service.collab.requestDecisionFromSession(sm.id, "投币音色需要总主控决定", ["卡通", "写实"]);
    expect(escalate.routedToTaskId).toBe(top.id);
    const humanQuestion = service.collab.requestDecisionFromSession(st.id, "游戏美术风格", ["卡通", "写实"]);
    expect(humanQuestion.routedToTaskId).toBeUndefined();
    expect(() => service.orchestration.submit(sc.id, "完成", "验证通过")).toThrow(/业务问题/);
    service.collab.answerDecision(humanQuestion.id, "卡通");
    service.orchestration.answerDecision(st.id, escalate.id, "卡通");
    expect(service.orchestration.answerDecision(sm.id, question.id, "卡通").answer).toBe("卡通");
    expect(service.orchestration.workflow(middle.id).decisions).toHaveLength(0);
  });

  it("keeps a durable inbox notification across Host reconstruction without sending twice", async () => {
    const top = task("总主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child);
    store.updateSession(manager.id, { status: "running" });
    const result = service.orchestration.submit(worker.id, "完成", "验证通过");
    await vi.waitFor(() => expect(service.sessions.inbox.held(manager.id)).toHaveLength(1));
    const runtime = new CodexRuntime({ store, servers, profiles });
    const restarted = new HostService(store, runtime, profiles, { commonDir: join(folder, "common") });
    await Promise.resolve();
    expect(restarted.sessions.inbox.held(manager.id)).toHaveLength(1);
    expect(store.getItem(`i-${result.id}-submit`)).toHaveProperty("delivery", "held");
  });

  it("revokes queued result notices on transfer and exposes questions when no valid manager remains", async () => {
    const top = task("总主控", true), other = task("另一个主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child);
    store.updateSession(manager.id, { status: "running" });
    const result = service.orchestration.submit(worker.id, "完成", "验证通过");
    await vi.waitFor(() => expect(service.sessions.inbox.held(manager.id)).toHaveLength(1));
    service.tasks.updateTask(child.id, { managerTaskId: other.id });
    expect(store.getItem(`i-${result.id}-submit`)).toHaveProperty("delivery", "expired");
    const q = service.collab.requestDecisionFromSession(worker.id, "哪里保存？", []);
    expect(q.routedToTaskId).toBe(other.id);
    service.tasks.updateTask(child.id, { managerTaskId: null });
    expect(store.getDecision(q.id)?.routedToTaskId).toBeNull();
    expect(managementRoot(store.listTasks(), child.id)).toBeNull();
  });

  it("moves a held notification from an archived conversation to its replacement without replaying consumed work", async () => {
    const top = task("总主控", true), child = task("执行", false, top.id);
    const old = session(top), worker = session(child);
    store.updateSession(old.id, { status: "running" });
    const result = service.orchestration.submit(worker.id, "完成", "验证通过");
    await vi.waitFor(() => expect(service.sessions.inbox.held(old.id)).toHaveLength(1));
    store.updateSession(old.id, { writer: "archived" });
    const next = session(top);
    store.updateSession(next.id, { status: "running" });
    service.publish({ type: "session.upserted", session: store.getSession(next.id)! });
    await vi.waitFor(() => expect(service.sessions.inbox.held(next.id)).toHaveLength(1));
    expect(store.getItem(`i-${result.id}-submit`)).toHaveProperty("delivery", "expired");
    expect(store.getItem(`i-${result.id}-submit-${next.id}`)).toHaveProperty("delivery", "held");
  });

  it("surfaces failed notifications without endlessly resending them", async () => {
    const top = task("总主控", true), child = task("执行", false, top.id);
    session(top); const worker = session(child);
    const put = vi.spyOn(service.sessions.inbox, "put").mockRejectedValue(new Error("runtime unavailable"));
    service.orchestration.submit(worker.id, "完成", "验证通过");
    await vi.waitFor(() => expect(service.orchestration.workflow(top.id).deliveryIssues).toEqual([expect.objectContaining({ detail: "Error: runtime unavailable" })]));
    service.tasks.updateTask(child.id, { title: "执行改名" });
    await Promise.resolve();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("saves actual adopted version and requires an explicit difference decision before acceptance", () => {
    delivery();
    const top = task("总主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child);
    const draft = service.sharedContext.save(manager.id, { rootTaskId: top.id, title: "共同需求", baseRevision: 0, body: "三枚投币", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户明确要求" }] });
    const first = service.sharedContext.publishVersion(manager.id, draft.id, draft.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 1, taskIds: [child.id] });
    service.sharedContext.getForSession(worker.id);
    service.sharedContext.adopt(worker.id, { contextId: first.id, version: 1 });
    const changed = service.sharedContext.save(manager.id, { rootTaskId: top.id, title: "共同需求", baseRevision: first.revision, body: "五枚投币", changeNote: "调整数量", sources: [{ kind: "user_requirement", source: "用户明确调整" }] });
    service.sharedContext.publishVersion(manager.id, changed.id, changed.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 2, taskIds: [child.id] });
    const result = service.orchestration.submit(worker.id, "资源完成", "素材检查通过");
    expect(result).toMatchObject({ state: "submitted", contextBasis: { contextId: first.id, version: 1 }, contextMismatch: expect.any(String) });
    expect(() => service.orchestration.review(manager.id, result.id, true, "通过")).toThrow(/contextExplanation/);
    expect(service.orchestration.results(child.id).at(-1)?.state).toBe("submitted");
    const accepted = service.orchestration.review(manager.id, result.id, true, "通过", "本任务只交付通用投币图标，数量变化不影响素材");
    expect(accepted.contextBasis?.version).toBe(1);
    expect(accepted.contextResolution).toEqual({ explanation: "本任务只交付通用投币图标，数量变化不影响素材", requiredBasis: { contextId: first.id, version: 2 } });
    expect(service.sharedContext.isResultCurrent(child.id, accepted)).toBe(true);
  });

  it("requires settled human review of the root's final delivery and reopens only for new work", async () => {
    delivery();
    const top = task("总主控", true), manager = session(top);
    requireNextRootVersion(manager.id, top.id);
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "running" }) });
    const result = service.orchestration.submit(manager.id, "最终汇总", "隔离检查通过");
    expect(result.state).toBe("submitted");
    expect(store.getTask(top.id)?.column).toBe("review");
    expect(() => service.orchestration.review(manager.id, result.id, true, "通过")).toThrow(/不能自行验收/);
    expect(() => service.orchestration.reviewByUser(top.id, result.id, true, "通过")).toThrow(/仍在工作/);
    // Submitting during a turn and subsequent status updates keep review pending.
    service.publish({ type: "session.upserted", session: store.getSession(manager.id)! });
    service.tasks.reviewSettleMs = 0;
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "idle" }) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("submitted");
    expect(() => service.orchestration.reviewByUser(top.id, result.id, true, "通过")).toThrow(/contextExplanation/);
    const accepted = service.orchestration.reviewByUser(top.id, result.id, true, "最终通过", "实际采用一版；已逐条核对二版数量变化不影响此份汇总中的通用资源结论");
    expect(accepted).toMatchObject({ state: "accepted", reviewedBy: "user" });
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("accepted");
    expect(store.getTask(top.id)?.column).toBe("done");
    // A root's conversation alone is not new work. Explicit reopening still invalidates acceptance, even mid-turn.
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "running" }) });
    expect(store.getTask(top.id)?.column).toBe("done");
    queueMessagePurpose(store, manager.id, "reopen", false);
    service.publish({ type: "session.upserted", session: store.getSession(manager.id)! });
    expect(store.getTask(top.id)?.column).toBe("doing");
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("returned");
  });

  it("blocks human acceptance while any session of the root is running", () => {
    delivery();
    const top = task("总主控", true), manager = session(top), other = session(top);
    requireNextRootVersion(manager.id, top.id);
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "running" }) });
    service.publish({ type: "session.upserted", session: store.updateSession(other.id, { status: "running" }) });
    const result = service.orchestration.submit(manager.id, "最终汇总", "隔离检查通过");
    expect(() => service.orchestration.reviewByUser(top.id, result.id, true, "通过", "逐条核对通过")).toThrow(/仍在工作/);
    expect(service.orchestration.results(top.id).at(-1)?.state).toBe("submitted");
  });

  it.each(["root", "child"])("rechecks active %s sessions inside the acceptance transaction", (mode) => {
    delivery();
    const top = task("总主控", true), manager = session(top);
    const owner = mode === "root" ? top : task("执行", false, top.id), worker = mode === "root" ? manager : session(owner);
    if (mode === "root") requireNextRootVersion(manager.id, top.id);
    const blocking = mode === "root" ? session(top) : worker;
    const result = service.orchestration.submit(worker.id, "交付", "隔离验证");
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce((fn) => {
      // A worker or another root session begins after the initial activity check.
      store.updateSession(blocking.id, { status: "running" });
      return transaction(fn);
    });
    expect(() => mode === "root" ? service.orchestration.reviewByUser(top.id, result.id, true, "通过", "逐条核对通过") : service.orchestration.review(manager.id, result.id, true, "通过", "逐条核对通过")).toThrow(/仍在工作/);
    expect(service.orchestration.results(owner.id).at(-1)?.state).toBe("submitted");
  });

  it("rechecks the required version inside the acceptance transaction", () => {
    delivery();
    const top = task("总主控", true), child = task("执行", false, top.id);
    const manager = session(top), worker = session(child);
    const draft = service.sharedContext.save(manager.id, { rootTaskId: top.id, title: "共同需求", baseRevision: 0, body: "三枚投币", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户目标" }] });
    const first = service.sharedContext.publishVersion(manager.id, draft.id, draft.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 1, taskIds: [child.id] });
    service.sharedContext.getForSession(worker.id);
    service.sharedContext.adopt(worker.id, { contextId: first.id, version: 1 });
    const result = service.orchestration.submit(worker.id, "完成", "按一版验证通过");
    const changed = service.sharedContext.save(manager.id, { rootTaskId: top.id, title: "共同需求", baseRevision: first.revision, body: "五枚投币", changeNote: "调整数量", sources: [{ kind: "user_requirement", source: "用户调整" }] });
    service.sharedContext.publishVersion(manager.id, changed.id, changed.revision);
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce((fn) => {
      // Simulate another operation committing an explicit requirement change after review's initial read.
      service.sharedContext.apply(manager.id, { contextId: first.id, version: 2, taskIds: [child.id] });
      return transaction(fn);
    });
    expect(() => service.orchestration.review(manager.id, result.id, true, "通过")).toThrow(/contextExplanation/);
    expect(service.orchestration.results(child.id).at(-1)?.state).toBe("submitted");
    expect(store.getTask(child.id)?.column).toBe("review");
  });
});
