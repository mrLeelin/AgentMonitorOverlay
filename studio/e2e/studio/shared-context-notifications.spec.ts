import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { ModelProfile, Session, SessionItem, StateSnapshot, Task, TaskResult, TaskWorkflow, Workspace } from "@amo-studio/protocol";
import { HostService, RuntimeRouter, Store, type RuntimeEvents, type SessionRuntimeApi } from "@amo-studio/host";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });
const command = (name: string, args: unknown = {}) => `[[mcp: ${name} ${JSON.stringify(args)}]]`;
const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
const settled = async (sessionId: string) => expect.poll(async () => (await state()).sessions.find((s) => s.id === sessionId)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
const send = async (sessionId: string, text: string) => {
  await settled(sessionId);
  const previous = await studio!.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`);
  const seq = Math.max(0, ...previous.map((i) => i.seq));
  await studio!.api("POST", `/api/sessions/${sessionId}/messages`, { text, now: true });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`)).some((i) => i.seq > seq && i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(sessionId);
};
const openTask = async (task: Task) => {
  const page = studio!.page, back = page.getByRole("button", { name: "返回看板", exact: true });
  if (await back.count()) await back.click();
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  await expect(page.getByTestId("task-title")).toContainText(task.title);
  if (task.lead) {
    const toggle = page.getByTestId("task-management-toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  }
};

/** Generate historical transport states through the production service before any Electron Host opens this database. */
async function notificationFixture() {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-e2e-notifications-"));
  const data = join(root, "data"), workspacePath = join(root, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const store = new Store(join(data, "studio.db"));
  const profiles: ModelProfile[] = [{ id: "codex-mock", label: "Mock", runtime: "codex", provider: null, model: "mock-model" }];
  const native = Object.assign(new EventEmitter<RuntimeEvents>(), {
    resend: async () => { throw new Error("隔离运行时连接已断开"); },
    interrupt: async () => undefined,
  });
  const service = new HostService(store, new RuntimeRouter(store, profiles, { codex: native as unknown as SessionRuntimeApi }), profiles, { commonDir: join(root, "common"), codexHome: join(root, "codex-home"), localClaudeHome: join(root, "claude-home"), claudeConfigFile: join(root, "claude.json") });
  const workspaceId = store.addWorkspace({ name: "通知隔离验证", path: workspacePath }).id;
  const task = (title: string, lead = false, managerTaskId: string | null = null) => store.createTask({ title, lead, managerTaskId, workspaceId });
  const session = (owner: Task) => store.createSession({ taskId: owner.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "codex-mock", workspaceId, title: owner.title, status: "idle", writer: "workbench", runtimeRef: null });
  try {
    const waiting = task("版本升级与通知历史", true), child = task("仍有效的下级交付", false, waiting.id), manager = session(waiting), worker = session(child);
    service.sessions.inbox.pause(manager.id);
    const input = { rootTaskId: waiting.id, title: "通知验证", body: "第一版业务约定", changeNote: "初版", sources: [{ kind: "user_requirement" as const, source: "隔离验证" }] };
    const draft = service.sharedContext.save(manager.id, { ...input, baseRevision: 0 });
    const v1 = service.sharedContext.publishVersion(manager.id, draft.id, draft.revision);
    service.sharedContext.apply(manager.id, { contextId: v1.id, version: 1, taskIds: [waiting.id] });
    const result = service.orchestration.submit(worker.id, "下级交付待主控核对", "隔离正式服务调用链");
    await expect.poll(() => store.getItem(`i-${result.id}-submit`)).toMatchObject({ delivery: "held" });
    const next = service.sharedContext.save(manager.id, { ...input, body: "第二版业务约定", baseRevision: v1.revision });
    const v2 = service.sharedContext.publishVersion(manager.id, next.id, next.revision);
    service.sharedContext.apply(manager.id, { contextId: v2.id, version: 2, taskIds: [waiting.id] });
    await expect.poll(() => service.orchestration.workflow(waiting.id).deliveryNotices?.map((n) => n.state)).toEqual(["expired", "waiting"]);
    expect(service.orchestration.workflow(waiting.id).deliveryIssues).toEqual([]);

    const failed = task("真实发送失败与重试", true), failedChild = task("发送失败的下级交付", false, failed.id), failedManager = session(failed), failedWorker = session(failedChild);
    service.orchestration.submit(failedWorker.id, "保留真实发送错误", "模拟传输在实际 resend 边界抛出连接错误");
    await expect.poll(() => service.orchestration.workflow(failed.id).deliveryIssues).toEqual([expect.objectContaining({ detail: "隔离运行时连接已断开" })]);
    service.sessions.inbox.pause(failedManager.id);
    return { root, waiting, failed };
  } finally { store.close(); }
}

test("notification states remain distinct and inspectable after an isolated Host reconstruction", async () => {
  const fixture = await notificationFixture();
  studio = await launchStudio({ root: fixture.root });
  const { page, app } = studio;
  await openTask(fixture.waiting);
  const history = page.getByTestId("workflow-delivery-history");
  await history.locator("summary").click();
  await expect(history.locator('[data-testid="workflow-notice"][data-state="expired"]')).toContainText("已过期");
  await expect(history.locator('[data-testid="workflow-notice"][data-state="waiting"]')).toContainText("等待发送");
  await expect(page.getByTestId("workflow-delivery-issue")).toHaveCount(0);
  await history.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-notifications-history-light", page);
  await page.evaluate(() => { localStorage.setItem("amo.theme", "dark"); window.dispatchEvent(new StorageEvent("storage", { key: "amo.theme" })); });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // A hidden Electron compositor can still return the previous native frame after the DOM has switched theme.
  await expect.poll(async () => app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes("#"))!;
    const pixel = (await win.webContents.capturePage()).crop({ x: 225, y: 55, width: 1, height: 1 }).toBitmap();
    return pixel[0]! < 100 && pixel[1]! < 100 && pixel[2]! < 100;
  })).toBe(true);
  await screenshot(app, "studio", "shared-context-notifications-history-dark", page);
  await page.getByTestId("task-management-toggle").click();
  const expired = page.locator('[data-testid="msg-delivery"][data-delivery="expired"]').first();
  await expect(expired).toContainText("已过期");
  await expect(expired.getByTestId("resend")).toHaveCount(0);
  await expect(expired.getByTestId("send-now")).toHaveCount(0);
  await expired.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-notifications-expired-chat", page);

  await openTask(fixture.failed);
  const failure = page.getByTestId("workflow-delivery-issue");
  await expect(failure).toContainText("隔离运行时连接已断开");
  await expect(failure.getByRole("button", { name: "重试通知", exact: true })).toBeEnabled();
  await failure.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-notifications-failure-retry", page);
});

async function acceptedWorker() {
  const workspace = await studio!.api<Workspace>("POST", "/api/workspaces", { path: studio!.workspace("inquiry-acceptance") });
  const root = await studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "询问验证主控", workspaceId: workspace.id, lead: true, firstSession: { profileId: "codex-mock", text: "维护验收记录。" } });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${root.session.id}/items`)).some((i) => i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(root.session.id);
  const worker = await studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "已验收询问任务", workspaceId: workspace.id, managerTaskId: root.task.id, firstSession: { profileId: "codex-mock", text: "完成原工作。" } });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${worker.session.id}/items`)).some((i) => i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(worker.session.id);
  const result = await studio!.api<TaskResult>("POST", `/api/tasks/${worker.task.id}/workflow/submit`, { sessionId: worker.session.id, summary: "原工作完成", verification: "隔离模型原回合已结束" });
  await studio!.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: result.id, accept: true, review: "原工作已验收。" });
  return { root, worker, result };
}

test("an actual inquiry reply keeps the accepted result and completed task", async () => {
  test.setTimeout(120_000);
  studio = await launchStudio();
  const { page, app } = studio;
  const { root, worker, result } = await acceptedWorker();
  const before = await studio.api<SessionItem[]>("GET", `/api/sessions/${worker.session.id}/items`), seq = Math.max(0, ...before.map((i) => i.seq));
  await send(root.session.id, command("task_message", { taskId: worker.task.id, purpose: "inquiry", text: "仅询问当前记录，请直接回答。" }));
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${worker.session.id}/items`)).some((i) => i.seq > seq && i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(worker.session.id);
  expect((await state()).tasks.find((t) => t.id === worker.task.id)?.column).toBe("done");
  const workflow = await studio.api<TaskWorkflow>("GET", `/api/tasks/${worker.task.id}/workflow`);
  expect(workflow.results.at(-1)).toMatchObject({ id: result.id, state: "accepted" });
  await openTask(root.task);
  await expect(page.getByTestId("workflow-result").filter({ hasText: worker.task.title })).toHaveAttribute("data-state", "accepted");
  await screenshot(app, "studio", "shared-context-notifications-inquiry-accepted", page);
  await openTask(worker.task);
  await page.getByTestId("msg-agent").last().scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-notifications-inquiry-worker-done", page);
});

test("HTTP inquiry keeps acceptance and rejects invalid public purposes before starting a turn", async () => {
  test.setTimeout(120_000);
  studio = await launchStudio();
  const { page, app } = studio;
  const { worker, result } = await acceptedWorker();
  const items = () => studio!.api<SessionItem[]>("GET", `/api/sessions/${worker.session.id}/items`);
  const before = await items(), seq = Math.max(0, ...before.map((i) => i.seq));
  await studio.api("POST", `/api/sessions/${worker.session.id}/messages`, { text: "HTTP 只读询问：请复述当前记录。", purpose: "inquiry" });
  await expect.poll(async () => (await items()).some((i) => i.seq > seq && i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(worker.session.id);
  expect((await state()).tasks.find((t) => t.id === worker.task.id)?.column).toBe("done");
  expect((await studio.api<TaskWorkflow>("GET", `/api/tasks/${worker.task.id}/workflow`)).results.at(-1)).toMatchObject({ id: result.id, state: "accepted" });
  const stableIds = (await items()).filter((i) => i.type === "user" || i.type === "turn").map((i) => i.id);
  const sessionIds = (await state()).sessions.filter((s) => s.taskId === worker.task.id).map((s) => s.id);
  for (const purpose of ["notification", "invalid"]) {
    await expect(studio.api("POST", `/api/sessions/${worker.session.id}/messages`, { text: "非法用途不得启动回合", purpose })).rejects.toThrow(/400/);
    await expect(studio.api("POST", `/api/tasks/${worker.task.id}/sessions`, { profileId: "codex-mock", text: "非法用途不得创建会话", purpose })).rejects.toThrow(/400/);
  }
  expect((await items()).filter((i) => i.type === "user" || i.type === "turn").map((i) => i.id)).toEqual(stableIds);
  expect((await state()).sessions.filter((s) => s.taskId === worker.task.id).map((s) => s.id)).toEqual(sessionIds);
  expect((await state()).tasks.find((t) => t.id === worker.task.id)?.column).toBe("done");
  await openTask(worker.task);
  await page.getByTestId("msg-agent").last().scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-notifications-http-inquiry-done", page);

  const newSession = await studio.api<Session>("POST", `/api/tasks/${worker.task.id}/sessions`, { profileId: "codex-mock", text: "新会话只读询问：请回答记录。", purpose: "inquiry" });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${newSession.id}/items`)).some((i) => i.type === "agent" && !i.streaming), { timeout: 60_000 }).toBe(true);
  await settled(newSession.id);
  expect((await state()).tasks.find((t) => t.id === worker.task.id)?.column).toBe("done");
  expect((await studio.api<TaskWorkflow>("GET", `/api/tasks/${worker.task.id}/workflow`)).results.at(-1)).toMatchObject({ id: result.id, state: "accepted" });
});
