import { expect, test } from "@playwright/test";
import type { CanvasDoc, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 任务依赖 (2026-11-17, plans/done/task-dependencies.md): a task whose prerequisite is not finished says so on its card and its
// page, its canvas line says 等待前置, and starting it by hand asks first; once the prerequisite is done, all of that goes.

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("a task waiting for its prerequisite says so, and starts by hand only once confirmed", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("task-deps") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "Free 玩法" });
  const add = async (title: string) => (await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id })).task;
  const prerequisite = await add("Free UI 移植");
  const dependent = await add("核对 Free 配置");
  for (const task of [prerequisite, dependent]) await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const positions = [{ x: 80, y: 80 }, { x: 420, y: 80 }];
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...doc, nodes: doc.nodes.map((n) => ({ ...n, pos: positions[[prerequisite, dependent].findIndex((t) => n.kind === "task" && n.taskId === t.id)] ?? n.pos })), edges: [{ id: "ui-before-config", kind: "depends", from: prerequisite.id, to: dependent.id }] });

  // The board: only the dependent waits.
  const card = (task: Task) => page.locator(`[data-testid="task-card"][data-task-id="${task.id}"]`);
  await expect(card(dependent).getByTestId("card-waiting")).toHaveText("等待前置：Free UI 移植");
  await expect(card(prerequisite).getByTestId("card-waiting")).toHaveCount(0);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-deps-board-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-deps-board-light", page);

  // Its page says so too, and starting it asks first: 取消 starts nothing.
  await card(dependent).click();
  await expect(page.getByTestId("task-waiting")).toHaveText("等待前置：Free UI 移植");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-deps-taskpage-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-deps-taskpage-light", page);
  const rows = page.getByTestId("session-row");
  await page.getByRole("button", { name: "开始新会话" }).click();
  const confirm = page.getByTestId("early-start-confirm");
  await expect(confirm).toContainText("「Free UI 移植」");
  await expect(confirm).toContainText("可能和它改到同一处");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-deps-confirm-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-deps-confirm-light", page);
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(rows).toHaveCount(0);
  await page.getByRole("button", { name: "开始新会话" }).click();
  await page.getByTestId("early-start-confirm").getByTestId("confirm-action").click();
  await expect(rows).toHaveCount(1);

  // The canvas line waits too, until the prerequisite is done; then the hints go.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const dependency = page.getByTestId("canvas-edge").locator("..").getByTestId("canvas-task-flow");
  await expect(dependency).toContainText("等待前置");
  await screenshot(app, "studio", "task-deps-canvas-waiting", page);
  await studio.api("PATCH", `/api/tasks/${prerequisite.id}`, { column: "done" });
  await expect(dependency).toContainText("前置已完成");
  await page.getByRole("button", { name: "全部任务", exact: true }).click();
  await expect(card(dependent).getByTestId("card-waiting")).toHaveCount(0);
});
