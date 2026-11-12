import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Task } from "@amo-studio/protocol";
import { managementRoot } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

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
const session = (owner: Task) => store.createSession({ taskId: owner.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId, title: owner.title, status: "idle", writer: "workbench", runtimeRef: null });
const delivery = () => vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });

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
    const question = service.collab.requestDecisionFromSession(sc.id, "需要什么音色？", ["卡通", "写实"]);
    expect(question.routedToTaskId).toBe(middle.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(sm.id, expect.stringContaining(question.id), undefined, expect.any(String), { purpose: "notification" }));
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
    // A genuinely new turn still reopens completed work and invalidates the old acceptance.
    service.publish({ type: "session.upserted", session: store.updateSession(manager.id, { status: "running" }) });
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
