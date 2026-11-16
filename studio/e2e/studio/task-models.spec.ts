import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("task cards and canvas share current model names, live changes and parallel main sessions", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("task-models") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "当前模型" });
  const create = (title: string, profileId: string, outside = false) => studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title, workspaceId: ws.id, topicId: outside ? undefined : topic.id, firstSession: { profileId },
  });
  const codex = await create("整理导入流程", "codex-mock");
  await studio.api("PATCH", `/api/tasks/${codex.task.id}`, { description: "检查模型标签与任务说明的布局，保留两行说明文字。\n切换型号后仍保持卡片内容和连线边界一致。" });
  const claude = await create("校验掉落表", "claude-mock");
  const external = await create("引用另一专题的任务", "claude-mock", true);
  const todo = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "尚未开始的任务", workspaceId: ws.id, topicId: topic.id });
  const boardCard = (id: string) => page.locator(`[data-testid="task-card"][data-task-id="${id}"]`);
  await page.getByTestId("scope-all").click();
  await expect(boardCard(codex.task.id).locator(".task-model-name")).toHaveText("Mock Model", { timeout: 30_000 });
  await expect(boardCard(claude.task.id).locator(".task-model-name")).toHaveText("mock-claude");
  await expect(boardCard(todo.task.id).getByTestId("task-models")).toHaveCount(0);
  await expect(boardCard(claude.task.id).locator(".task-model-badge")).toHaveAttribute("data-runtime", "claude");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-models-board-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-models-board-light", page);

  await studio.api("PATCH", `/api/sessions/${claude.session.id}/options`, { model: "mock-claude-b" });
  await expect(boardCard(claude.task.id).locator(".task-model-name")).toHaveText("mock-claude-b");
  const extra = await studio.api<Session>("POST", `/api/tasks/${claude.task.id}/sessions`, { profileId: "codex-mock" });
  await expect(boardCard(claude.task.id).locator(".task-model-more")).toHaveText("+1");
  await expect(boardCard(claude.task.id).locator(".task-model-more")).toHaveAttribute("title", /mock-claude-b/);

  for (const item of [codex, claude]) await studio.api("PUT", `/api/tasks/${item.task.id}/canvas`, { onCanvas: true });
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...doc,
    nodes: [...doc.nodes.map((n, i) => ({ ...n, pos: { x: 50 + i * 280, y: 50 } })),
      { id: "task-model-ref", kind: "ref", taskId: external.task.id, pos: { x: 50, y: 220 }, size: { w: 140, h: 66 }, groupId: null }],
  });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const canvasCard = (title: string) => page.getByTestId("canvas-card").filter({ hasText: title });
  await expect(canvasCard(codex.task.title).locator(".task-model-name")).toHaveText("Mock Model");
  await expect(canvasCard(claude.task.title).locator(".task-model-more")).toHaveText("+1");
  const ref = page.getByTestId("canvas-ref");
  await expect(ref.locator(".task-model-name")).toHaveText("mock-claude");
  // Old manually resized cards grow enough to contain the new line; their saved position stays intact.
  expect(await ref.evaluate((el) => (el as HTMLElement).offsetHeight)).toBeGreaterThanOrEqual(92);
  for (const card of [canvasCard(codex.task.title), canvasCard(claude.task.title), ref]) {
    expect(await card.evaluate((el) => {
      const pill = el.querySelector(".task-models")!.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      const desc = el.querySelector(".canvas-card-desc")?.getBoundingClientRect();
      return pill.top >= bounds.top && pill.bottom <= bounds.bottom && pill.right <= bounds.right && (!desc || desc.bottom <= bounds.bottom);
    })).toBe(true);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-models-canvas-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-models-canvas-light", page);

  await studio.api("PATCH", `/api/sessions/${external.session.id}/options`, { model: "mock-claude-b" });
  await expect(ref.locator(".task-model-name")).toHaveText("mock-claude-b");
  await studio.api("POST", `/api/sessions/${extra.id}/archive`, {});
  await expect(canvasCard(claude.task.title).locator(".task-model-more")).toHaveCount(0);
  await expect(canvasCard(claude.task.title).locator(".task-model-name")).toHaveText("mock-claude-b");
  await studio.api("POST", `/api/sessions/${claude.session.id}/archive`, {});
  await expect(canvasCard(claude.task.title).locator(".task-model-name")).toBeVisible();
});
