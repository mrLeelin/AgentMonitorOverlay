import { expect, test } from "@playwright/test";
import type { CanvasDoc, ContextBasis, Session, SessionItem, SharedContext, SharedContextView, StateSnapshot, Task, TaskPlan, TaskResult, TaskWorkflow, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const command = (name: string, args: unknown = {}) => `[[mcp: ${name} ${JSON.stringify(args)}]]`;
const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
const context = (taskId: string) => studio!.api<SharedContextView>("GET", `/api/tasks/${taskId}/context`);
const settled = async (sessionId: string) => {
  await expect.poll(async () => (await state()).sessions.find((s) => s.id === sessionId)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
};
const send = async (sessionId: string, text: string) => {
  await settled(sessionId);
  const previous = await studio!.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`);
  const after = Math.max(0, ...previous.map((item) => item.seq));
  await studio!.api("POST", `/api/sessions/${sessionId}/messages`, { text, now: true });
  await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`)).some((item) => item.seq > after && item.type === "agent" && !item.streaming), { timeout: 60_000 }).toBe(true);
  await settled(sessionId);
};
const openTask = async (task: Task) => {
  const page = studio!.page;
  const back = page.getByRole("button", { name: "返回看板", exact: true });
  if (await back.count()) await back.click();
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  await expect(page.getByTestId("task-title")).toContainText(task.title);
};
const adopt = async (taskId: string, sessionId: string, basis: ContextBasis) => {
  // HTTP inspection is deliberately not a model receipt: use the same MCP tool the executor calls.
  await send(sessionId, command("context_get"));
  await expect.poll(async () => (await context(taskId)).receipts.some((r) => r.sessionId === sessionId && r.version === basis.version && r.deliveredAt), { timeout: 60_000 }).toBeTruthy();
  await settled(sessionId);
  await send(sessionId, command("context_adopt", basis));
  await expect.poll(async () => (await context(taskId)).receipts.some((r) => r.sessionId === sessionId && r.version === basis.version && r.adoptedAt), { timeout: 60_000 }).toBeTruthy();
  await settled(sessionId);
};

test("shared requirements stay explicit through dispatch, upgrade, mismatched delivery and acceptance", async () => {
  test.setTimeout(180_000);
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("shared-context") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "共同需求集成验证" });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "投币按钮总主控", workspaceId: ws.id, topicId: topic.id, lead: true, firstSession: { profileId: "codex-mock", text: "维护共同需求并核验执行任务。" } });
  await settled(root.session.id);
  const draft = await studio.api<SharedContext>("POST", "/api/shared-context/save", { sessionId: root.session.id, rootTaskId: root.task.id, baseRevision: 0, title: "投币按钮共同需求", body: "初始3枚，每次成功扣1枚；余额0禁用，最后一次成功仍有反馈。", changeNote: "记录用户初始目标", sources: [{ kind: "user_requirement", source: "用户明确要求初始3枚" }] });
  const v1 = await studio.api<SharedContext>("POST", "/api/shared-context/publish", { sessionId: root.session.id, contextId: draft.id, baseRevision: draft.revision });
  const basis1 = { contextId: v1.id, version: 1 };

  // The real lead tool creates both tasks, freezes v1 before starting, and waits for accepted prerequisites.
  await send(root.session.id, command("task_plan_propose", { summary: "资源验收后再实现按钮", tasks: [
    { key: "assets", title: "投币资源依据", contextBasis: basis1, firstMessage: "检查资源名称和按钮状态。" },
    { key: "button", title: "投币按钮执行", contextBasis: basis1, dependsOn: ["assets"], firstMessage: "按前置资源结果实现投币按钮。" },
  ] }));
  await expect.poll(async () => (await studio!.api<TaskPlan[]>("GET", "/api/task-plans")).find((p) => p.fromTaskId === root.task.id)?.state, { timeout: 60_000 }).toBe("accepted");
  const planned = await state();
  const assets = planned.tasks.find((t) => t.title === "投币资源依据")!;
  const worker = planned.tasks.find((t) => t.title === "投币按钮执行")!;
  await expect.poll(async () => (await state()).sessions.find((s) => s.taskId === assets.id)?.id, { timeout: 60_000 }).toBeTruthy();
  const assetSession = (await state()).sessions.find((s) => s.taskId === assets.id)!;
  await expect.poll(async () => (await context(assets.id)).receipts.some((r) => r.sessionId === assetSession.id && r.deliveredAt), { timeout: 60_000 }).toBeTruthy();
  expect((await context(assets.id)).receipts.some((r) => r.adoptedAt)).toBe(false);
  expect((await context(worker.id)).binding?.version).toBe(1);
  expect((await state()).sessions.some((s) => s.taskId === worker.id)).toBe(false);

  const changed = await studio.api<SharedContext>("POST", "/api/shared-context/save", { sessionId: root.session.id, rootTaskId: root.task.id, baseRevision: v1.revision, title: v1.title, body: "初始5枚，新增重置按钮；重置设为5枚并清除成功提示，已5枚重复重置静默。", changeNote: "用户追加5枚与重置", sources: [{ kind: "user_requirement", source: "用户明确追加重置和5枚" }, { kind: "lead_agreement", source: "主控约定保持成功反馈规则" }, { kind: "suggestion", source: "重置音效可选" }] });
  const v2 = await studio.api<SharedContext>("POST", "/api/shared-context/publish", { sessionId: root.session.id, contextId: v1.id, baseRevision: changed.revision });
  expect(v2.currentVersion).toBe(2);
  expect(v2.versions[0]?.body).toBe(v1.versions[0]?.body);
  expect((await context(worker.id)).binding?.version).toBe(1);
  await settled(assetSession.id);
  await adopt(assets.id, assetSession.id, basis1);
  const assetResult = await studio.api<TaskResult>("POST", `/api/tasks/${assets.id}/workflow/submit`, { sessionId: assetSession.id, summary: "资源名称和状态通过", verification: "核对正常、禁用、余额和成功反馈。" });
  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: assetResult.id, accept: true, review: "资源依据通过，继续按钮实现。" });
  await expect.poll(async () => (await state()).sessions.find((s) => s.taskId === worker.id)?.id, { timeout: 60_000 }).toBeTruthy();
  const workerSession = (await state()).sessions.find((s) => s.taskId === worker.id)!;
  await expect.poll(async () => (await context(worker.id)).receipts.some((r) => r.sessionId === workerSession.id && r.version === 1 && r.deliveredAt), { timeout: 60_000 }).toBeTruthy();
  expect((await context(worker.id)).binding?.version).toBe(1);
  expect((await context(worker.id)).prerequisiteResultIds).toEqual([assetResult.id]);
  await settled(workerSession.id);
  await adopt(worker.id, workerSession.id, basis1);

  // Publishing did not upgrade either task; the lead now selects only the active implementation.
  const basis2 = { contextId: v1.id, version: 2 };
  await studio.api("POST", "/api/shared-context/apply", { sessionId: root.session.id, ...basis2, taskIds: [worker.id] });
  expect((await context(assets.id)).binding?.version).toBe(1);
  expect((await studio.api<TaskWorkflow>("GET", `/api/tasks/${assets.id}/workflow`)).results.at(-1)?.state).toBe("accepted");
  await studio.api("PUT", `/api/tasks/${root.task.id}/canvas`, { onCanvas: true });
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const positions: Record<string, { x: number; y: number }> = { [root.task.id]: { x: 310, y: 30 }, [assets.id]: { x: 70, y: 300 }, [worker.id]: { x: 560, y: 300 } };
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...canvas, nodes: canvas.nodes.map((n) => n.kind === "task" && positions[n.taskId] ? { ...n, pos: positions[n.taskId] } : n) });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const workerCard = page.getByTestId("canvas-card").filter({ hasText: worker.title });
  await expect(workerCard).toContainText("需求待更新");
  await screenshot(app, "studio", "shared-context-canvas-pending", page);
  await openTask(worker);
  await page.getByTestId("task-context-toggle").click();
  await expect(page.getByTestId("task-context")).toBeVisible();
  await expect(page.getByTestId("context-status")).toContainText("2");
  await expect(page.getByTestId("context-status")).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("task-context")).toContainText("初始5枚");
  await screenshot(app, "studio", "shared-context-update-pending", page);
  await page.evaluate(() => { localStorage.setItem("amo.theme", "dark"); window.dispatchEvent(new StorageEvent("storage", { key: "amo.theme" })); });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot(app, "studio", "shared-context-update-pending-dark", page);
  await page.evaluate(() => { localStorage.setItem("amo.theme", "light"); window.dispatchEvent(new StorageEvent("storage", { key: "amo.theme" })); });
  await page.getByTestId("task-context").getByRole("button", { name: /关闭/ }).click();
  // A v1 prerequisite must block v2 continuation even though it is still done/accepted.
  await expect(studio.api("POST", `/api/sessions/${workerSession.id}/messages`, { text: command("context_get") })).rejects.toThrow(/前置任务/);
  // Explicitly reopen and update the prerequisite, then begin a new worker session with the new result snapshot.
  await studio.api("PATCH", `/api/tasks/${assets.id}`, { column: "doing" });
  await studio.api("POST", "/api/shared-context/apply", { sessionId: root.session.id, ...basis2, taskIds: [assets.id] });
  await adopt(assets.id, assetSession.id, basis2);
  const updatedAssetResult = await studio.api<TaskResult>("POST", `/api/tasks/${assets.id}/workflow/submit`, { sessionId: assetSession.id, summary: "5枚与重置资源依据通过", verification: "新增重置按钮，覆盖五枚余额及成功提示清除。" });
  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: updatedAssetResult.id, accept: true, review: "明确验收新版资源，重新开始依赖工作。" });
  const currentWorkerSession = await studio.api<Session>("POST", `/api/tasks/${worker.id}/sessions`, { profileId: "codex-mock", text: "依据已验收的新版资源继续5枚与重置工作。" });
  await settled(currentWorkerSession.id);
  await adopt(worker.id, currentWorkerSession.id, basis2);
  expect((await context(worker.id)).prerequisiteResultIds).toEqual([updatedAssetResult.id]);

  const old = await studio.api<TaskResult>("POST", `/api/tasks/${worker.id}/workflow/submit`, { sessionId: workerSession.id, summary: "旧版3枚按钮成果保留待处理", verification: "只验证了3→2→1→0，尚未覆盖重置。", contextBasis: basis1, prerequisiteResultIds: [assetResult.id] });
  expect(old.state).toBe("submitted");
  expect(old.contextMismatch).toBeTruthy();
  await expect(studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: old.id, accept: true, review: "尝试直接接受" })).rejects.toThrow(/409|400/);
  expect((await studio.api<TaskWorkflow>("GET", `/api/tasks/${worker.id}/workflow`)).results.at(-1)?.state).toBe("submitted");
  await openTask(root.task);
  await page.getByTestId("task-management-toggle").click();
  const mismatch = page.getByTestId("workflow-result").filter({ hasText: old.summary });
  await mismatch.locator("summary").first().click();
  await expect(mismatch.getByTestId("workflow-context-basis")).toContainText("1");
  await expect(mismatch.getByTestId("workflow-context-mismatch")).toBeVisible();
  await mismatch.getByTestId("workflow-prerequisites").locator("summary").click();
  await expect(mismatch.getByTestId("workflow-prerequisites")).toContainText("投币资源依据");
  await mismatch.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-mismatched-delivery", page);

  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: old.id, accept: false, review: "退回补齐5枚和重置，按当前要求重新交付。" });
  await send(currentWorkerSession.id, "已按退回意见补齐5枚与重置验证，准备重新交付。");
  const corrected = await studio.api<TaskResult>("POST", `/api/tasks/${worker.id}/workflow/submit`, { sessionId: currentWorkerSession.id, summary: "5枚与重置按钮已完成", verification: "核对5→4→3→2→1→0、0~5重置均设5、重复重置静默及前置资源结果。", prerequisiteResultIds: [updatedAssetResult.id] });
  expect(corrected.contextBasis).toEqual(basis2);
  expect(corrected.contextMismatch).toBeUndefined();
  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: corrected.id, accept: true, review: "对照当前5枚与重置要求及具体资源结果，验收通过。" });
  const finalWorkflow = await studio.api<TaskWorkflow>("GET", `/api/tasks/${worker.id}/workflow`);
  expect(finalWorkflow.results.find((r) => r.id === old.id)?.state).toBe("returned");
  expect(finalWorkflow.results.find((r) => r.id === old.id)?.contextBasis).toEqual(basis1);
  expect(finalWorkflow.results.at(-1)?.state).toBe("accepted");
  const accepted = page.getByTestId("workflow-result").filter({ hasText: corrected.summary });
  await expect(accepted).toHaveAttribute("data-state", "accepted");
  await accepted.locator("summary").first().click();
  await accepted.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "shared-context-accepted", page);
  await page.getByTestId("task-context-toggle").click();
  await page.getByTestId("context-adoption").locator("summary").click();
  await expect(page.getByTestId("context-adoption")).toContainText("投币按钮执行");
  await page.getByTestId("context-history").locator("summary").first().click();
  await page.getByTestId("context-history").locator(".context-version").first().locator("summary").click();
  await expect(page.getByTestId("context-history")).toContainText("用户明确要求");
  await screenshot(app, "studio", "shared-context-lead-history", page);
});

test("unbound legacy tasks remain readable without inventing requirements or adoption", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("legacy-context") });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "未绑定的旧主控", lead: true, workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "旧任务不推测需求版本。" } });
  const legacy = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "旧的未绑定任务", managerTaskId: root.task.id, workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "保持现有任务行为。" } });
  await send(legacy.session.id, "旧任务验证已结束，准备按原方式交付。");
  const result = await studio.api<TaskResult>("POST", `/api/tasks/${legacy.task.id}/workflow/submit`, { sessionId: legacy.session.id, summary: "旧任务照常交付", verification: "无共同需求绑定。" });
  expect(result.state).toBe("submitted");
  await settled(legacy.session.id);
  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: result.id, accept: true, review: "旧未绑定任务照常验收。" });
  expect(result.contextBasis).toBeUndefined();
  expect((await context(legacy.task.id)).binding).toBeNull();
  await openTask(legacy.task);
  await page.getByTestId("task-context-toggle").click();
  await expect(page.getByTestId("task-context")).toContainText("未绑定");
  await expect(page.getByTestId("context-editor")).toHaveCount(0);
  await screenshot(app, "studio", "shared-context-unbound", page);
});

test("optional draft editing publishes explicitly and preserves unsaved text on an external change", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("context-editor") });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "共同需求编辑主控", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: "维护共同需求草稿。" } });
  await settled(root.session.id);
  await openTask(root.task);
  await page.getByTestId("task-context-toggle").click();
  await page.getByTestId("context-editor").locator("summary").click();
  await page.getByLabel("共同需求标题", { exact: true }).fill("按钮需求");
  await page.getByLabel("共同需求正文", { exact: true }).fill("初始3枚，归0禁用。");
  await page.getByLabel("共同需求变更说明", { exact: true }).fill("记录首版需求");
  await page.getByLabel("需求来源 1", { exact: true }).fill("用户本轮明确目标");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByTestId("task-context")).toContainText("草稿已保存，尚未发布");
  expect((await context(root.task.id)).context?.currentVersion).toBeNull();
  await page.getByRole("button", { name: "发布已保存草稿", exact: true }).click();
  await expect.poll(async () => (await context(root.task.id)).context?.currentVersion).toBe(1);
  await expect(page.getByTestId("task-context")).toContainText("已发布。任务要求保持原样");
  await page.getByTestId("context-editor").getByRole("checkbox", { name: root.task.title, exact: true }).check();
  await page.getByRole("button", { name: "更新所选任务要求", exact: true }).click();
  await expect.poll(async () => (await context(root.task.id)).binding?.version).toBe(1);
  expect((await context(root.task.id)).receipts.some((r) => r.adoptedAt)).toBe(false);
  const published = (await context(root.task.id)).context!;
  await page.getByLabel("共同需求正文", { exact: true }).fill("我的未保存编辑：补充重置按钮。");
  await studio.api("POST", "/api/shared-context/save", { sessionId: root.session.id, rootTaskId: root.task.id, baseRevision: published.revision, title: published.title, body: "另一会话的草稿：初始5枚。", changeNote: "另一会话更新", sources: published.draft.sources });
  await expect(page.getByTestId("task-context")).toContainText("共同需求已有新的修改");
  await expect(page.getByLabel("共同需求正文", { exact: true })).toHaveValue("我的未保存编辑：补充重置按钮。");
  await expect(page.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "发布已保存草稿", exact: true })).toBeDisabled();
  await screenshot(app, "studio", "shared-context-editor-conflict", page);
  await page.getByRole("button", { name: "放弃当前编辑并重新读取草稿", exact: true }).click();
  await expect(page.getByLabel("共同需求正文", { exact: true })).toHaveValue("另一会话的草稿：初始5枚。");
  const current = (await context(root.task.id)).context!;
  expect(current.versions).toHaveLength(1);
  expect(current.versions[0]?.body).toBe("初始3枚，归0禁用。");
});
