import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, root: Task, session: Session, http: HostServer | undefined;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-user-review-"));
  store = new Store(join(folder, "studio.db")); servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  const ws = store.addWorkspace({ name: "最终验收隔离测试", path: folder });
  root = store.createTask({ title: "总主控", workspaceId: ws.id, lead: true });
  session = await service.tasks.addSession(root.id, { profileId: "test" });
  service.sessions.inbox.pause(session.id);
});
afterEach(async () => { await http?.close(); http = undefined; vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });
const submit = () => service.orchestration.submit(session.id, "最终交付", "实际验证记录");
const tool = (name: string) => amoToolsFor(service, { sessionId: session.id }).find((t) => t.name === name)!;

it("keeps root submission pending, deduplicates retries and rejects changed pending submissions", () => {
  const result = submit();
  expect(result).toMatchObject({ state: "submitted", managerTaskId: null });
  expect(store.getTask(root.id)?.column).toBe("review");
  expect(submit().id).toBe(result.id);
  expect(service.orchestration.results(root.id)).toHaveLength(1);
  expect(() => service.orchestration.submit(session.id, "改摘要", "改证据")).toThrow(/等待用户/);
});

it.each([true, false])("rejects root MCP self review (accept=%s) and ordinary AI completion", async (accept) => {
  const result = submit();
  expect((await tool("task_review_result").run({ resultId: result.id, accept, review: "AI 自评", contextExplanation: "不影响" })).isError).toBe(true);
  expect((await tool("task_update").run({ column: "done" })).isError).toBe(true);
  expect(service.orchestration.results(root.id).at(-1)?.state).toBe("submitted");
  expect(store.getTask(root.id)?.column).toBe("review");
});

it("records user return, delivers real correction work once, then accepts only the new result", async () => {
  const first = submit();
  expect(() => service.orchestration.reviewByUser(root.id, first.id, false, " ")).toThrow(/不能为空/);
  const returned = service.orchestration.reviewByUser(root.id, first.id, false, "补充截图");
  expect(returned).toMatchObject({ state: "returned", reviewedBy: "user", review: "补充截图" });
  expect(store.getTask(root.id)?.column).toBe("doing");
  await vi.waitFor(() => expect(service.sessions.inbox.held(session.id)).toHaveLength(1));
  expect(store.getItem(`i-${first.id}-return`)).toMatchObject({ messagePurpose: "work", delivery: "held", text: expect.stringContaining("补充截图") });
  expect(service.orchestration.reviewByUser(root.id, first.id, false, "补充截图")).toEqual(returned);
  expect(service.sessions.inbox.held(session.id)).toHaveLength(1);
  const next = service.orchestration.submit(session.id, "最终交付已修改", "附实际截图");
  expect(next.id).not.toBe(first.id);
  expect(() => service.orchestration.reviewByUser(root.id, first.id, true, "旧交付")).toThrow(/最新/);
  const accepted = service.orchestration.reviewByUser(root.id, next.id, true, "用户验收通过");
  expect(accepted).toMatchObject({ state: "accepted", reviewedBy: "user" });
  expect(store.getTask(root.id)?.column).toBe("done");
  expect(service.orchestration.reviewByUser(root.id, next.id, true, "用户验收通过")).toEqual(accepted);
  expect(service.orchestration.submit(session.id, "最终交付已修改", "附实际截图").id).toBe(next.id);
  expect(store.getTask(root.id)?.column).toBe("done");
});

it("recovers a paused user-return notice without duplicate delivery or rewriting its work purpose", async () => {
  const result = submit();
  service.orchestration.reviewByUser(root.id, result.id, false, "补充真实验证");
  await vi.waitFor(() => expect(service.sessions.inbox.held(session.id)).toHaveLength(1));
  const rebuilt = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  expect(rebuilt.sessions.inbox.held(session.id)).toHaveLength(1);
  expect(store.getItem(`i-${result.id}-return`)).toMatchObject({ delivery: "held", messagePurpose: "work" });
  const next = rebuilt.orchestration.submit(session.id, "补充后交付", "真实验证证据");
  expect(store.getItem(`i-${result.id}-return`)).toMatchObject({ delivery: "expired" });
  expect(rebuilt.orchestration.results(root.id).at(-1)).toMatchObject({ id: next.id, state: "submitted" });
});

it("blocks dragging pending/returned final delivery to done while preserving human management and reopen", () => {
  const result = submit();
  expect(() => service.tasks.patchTask(root.id, { column: "done" })).toThrow(/交付与验收/);
  service.tasks.patchTask(root.id, { title: "重命名总主控" });
  expect(service.orchestration.results(root.id).at(-1)?.state).toBe("submitted");
  service.tasks.patchTask(root.id, { column: "doing" });
  expect(service.orchestration.results(root.id).at(-1)).toMatchObject({ id: result.id, state: "returned" });
  expect(() => service.tasks.patchTask(root.id, { column: "done" })).toThrow(/交付与验收/);
  expect(submit().id).not.toBe(result.id);
});

it("invalidates pending final delivery on transfer and keeps a managed lead under direct-manager review", async () => {
  const previous = submit();
  const parent = store.createTask({ title: "新总主控", workspaceId: root.workspaceId, lead: true });
  const manager = await service.tasks.addSession(parent.id, { profileId: "test" });
  service.sessions.inbox.pause(manager.id);
  service.tasks.setManager(root.id, parent.id);
  expect(service.orchestration.results(root.id).at(-1)).toMatchObject({ id: previous.id, state: "returned" });
  const next = submit();
  expect(next.managerTaskId).toBe(parent.id);
  expect(() => service.orchestration.reviewByUser(root.id, next.id, true, "人工不能替代直属验收")).toThrow(/直属主控/);
  expect(service.orchestration.review(manager.id, next.id, true, "直属主控通过")).toMatchObject({ state: "accepted", reviewedBy: "manager" });
  const final = service.orchestration.submit(manager.id, "新根汇总", "下辖已验收");
  expect(final.state).toBe("submitted");
  expect(store.getTask(parent.id)?.column).toBe("review");
});

it.each(["submitted", "accepted"])("preserves %s final delivery through a real notification turn, then invalidates for work", async (state) => {
  const result = submit();
  if (state === "accepted") service.orchestration.reviewByUser(root.id, result.id, true, "用户通过");
  const column = state === "accepted" ? "done" : "review";
  await service.sessions.inbox.put(session.id, "[[slow]] 普通通知回复", undefined, "i-root-notification", { purpose: "notification" });
  await service.sessions.inbox.sendNow(session.id, "i-root-notification");
  await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("running"));
  expect(store.getTask(root.id)?.column).toBe(column);
  expect(service.orchestration.results(root.id).at(-1)).toMatchObject({ id: result.id, state });
  await service.sessions.interrupt(session.id);
  expect(service.orchestration.results(root.id).at(-1)?.state).toBe(state);
  await service.sessions.sendMessage(session.id, "[[slow]] 明确继续工作", [], [], { now: true });
  await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("running"));
  expect(store.getTask(root.id)?.column).toBe("doing");
  expect(service.orchestration.results(root.id).at(-1)?.state).toBe("returned");
  await service.sessions.interrupt(session.id);
});

it("guards the real human API with the REST credential and validates requests without changing pending state", async () => {
  const result = submit();
  http = await startHostServer({ service, token: "test-person-token", mcpToken: "test-ai-token", port: 0 });
  const url = `${http.url}/api/tasks/${root.id}/workflow/user-review`;
  const request = (token: string, body: unknown) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const body = { resultId: result.id, accept: true, review: "用户通过" };
  expect((await request("test-ai-token", body)).status).toBe(401);
  expect((await request("test-person-token", { ...body, accept: "true" })).status).toBe(400);
  const oldSelfReview = await fetch(`${http.url}/api/tasks/${root.id}/workflow/review`, { method: "POST", headers: { authorization: "Bearer test-person-token", "content-type": "application/json" }, body: JSON.stringify({ ...body, sessionId: session.id }) });
  expect(oldSelfReview.status).toBe(400);
  expect(service.orchestration.results(root.id).at(-1)?.state).toBe("submitted");
  const response = await request("test-person-token", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ state: "accepted", reviewedBy: "user" });
  expect(store.getTask(root.id)?.column).toBe("done");
});
