import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, manager: Session, worker: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-notification-mcp-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "通知权限隔离验证", path: folder });
  const root = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "执行", workspaceId: workspace.id, managerTaskId: root.id });
  manager = await service.tasks.addSession(root.id, { profileId: "test" });
  worker = await service.tasks.addSession(child.id, { profileId: "test" });
  service.sessions.inbox.pause(manager.id);
  service.sessions.inbox.pause(worker.id);
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });

const tool = (sessionId: string, name: string) => amoToolsFor(service, { sessionId }).find((entry) => entry.name === name)!;
async function notification(sessionId: string): Promise<void> {
  const id = `i-notification-capabilities-${sessionId}`;
  await service.sessions.inbox.put(sessionId, "[[slow]] 自动状态通知，按当前角色处理合法事项。", undefined, id, { purpose: "notification" });
  await service.sessions.inbox.sendNow(sessionId, id);
  await vi.waitFor(() => {
    expect(store.getSession(sessionId)?.status).toBe("running");
    expect(store.listItems(sessionId).find((item) => item.type === "turn" && item.state === "running")).toHaveProperty("messagePurpose", "notification");
  });
}

it("permits actual MCP context adoption in a notification turn without bypassing the bound version", async () => {
  const draft = service.sharedContext.save(manager.id, { rootTaskId: manager.taskId!, baseRevision: 0, title: "通知采用", body: "第一版正文", changeNote: "初版", sources: [{ kind: "user_requirement", source: "隔离回归" }] });
  const first = service.sharedContext.publishVersion(manager.id, draft.id, draft.revision);
  service.sharedContext.apply(manager.id, { contextId: first.id, version: 1, taskIds: [worker.taskId!] });
  expect((await tool(worker.id, "context_get").run({})).isError).not.toBe(true);
  expect(service.sharedContext.receipts(worker.id).find((receipt) => receipt.version === 1)?.adoptedAt).toBeUndefined();
  const next = service.sharedContext.save(manager.id, { rootTaskId: manager.taskId!, baseRevision: first.revision, title: "通知采用", body: "第二版正文", changeNote: "仅发布，不升级", sources: [{ kind: "user_requirement", source: "隔离回归" }] });
  service.sharedContext.publishVersion(manager.id, first.id, next.revision);
  await notification(worker.id);
  expect((await tool(worker.id, "context_adopt").run({ contextId: first.id, version: 2 })).isError).toBe(true);
  expect(service.sharedContext.get(worker.taskId!).binding?.version).toBe(1);
  expect((await tool(worker.id, "context_adopt").run({ contextId: first.id, version: 1 })).isError).not.toBe(true);
  expect(service.sharedContext.receipts(worker.id).find((receipt) => receipt.version === 1)?.adoptedAt).toEqual(expect.any(String));
  expect(service.sharedContext.receipts(worker.id).find((receipt) => receipt.version === 2)?.adoptedAt).toBeUndefined();
  await service.sessions.interrupt(worker.id);
});

it("permits the direct manager's actual MCP review in a notification turn and keeps ownership checks", async () => {
  const submitted = service.orchestration.submit(worker.id, "可验收交付", "正式隔离验证证据");
  await notification(manager.id);
  const strangerTask = store.createTask({ title: "其他管理根", lead: true, workspaceId: manager.workspaceId });
  const stranger = await service.tasks.addSession(strangerTask.id, { profileId: "test" });
  expect((await tool(stranger.id, "task_review_result").run({ resultId: submitted.id, accept: true, review: "不能跨树验收" })).isError).toBe(true);
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("submitted");
  expect((await tool(manager.id, "task_review_result").run({ resultId: submitted.id, accept: true, review: "通知回合中的直属主控验收" })).isError).not.toBe(true);
  expect(service.orchestration.results(worker.taskId!).at(-1)).toMatchObject({ id: submitted.id, state: "accepted", managerTaskId: manager.taskId });
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  await service.sessions.interrupt(manager.id);
});

it("permits an actual MCP decision answer from a notification while preserving the manager's accepted result", async () => {
  const completed = service.orchestration.submit(worker.id, "下级完成", "下级验证通过");
  service.orchestration.review(manager.id, completed.id, true, "下级通过");
  const final = service.orchestration.submit(manager.id, "主控完成", "直属任务已验收");
  expect(final.state).toBe("accepted");
  expect((await tool(worker.id, "decision_request").run({ question: "保留哪种现有记录？", options: ["完整记录", "摘要记录"] })).isError).not.toBe(true);
  const decision = store.listDecisions({ state: "open" }).find((entry) => entry.taskId === worker.taskId)!;
  expect(decision.routedToTaskId).toBe(manager.taskId);
  await notification(manager.id);
  expect(store.getTask(manager.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(manager.taskId!).at(-1)).toMatchObject({ id: final.id, state: "accepted" });
  expect((await tool(manager.id, "task_decision_answer").run({ decisionId: decision.id, answer: "完整记录" })).isError).not.toBe(true);
  expect(store.getDecision(decision.id)).toMatchObject({ state: "answered", answer: "完整记录" });
  expect(service.orchestration.results(manager.taskId!).at(-1)).toMatchObject({ id: final.id, state: "accepted" });
  expect(store.getTask(manager.taskId!)?.column).toBe("done");
  await service.sessions.interrupt(manager.id);
});
