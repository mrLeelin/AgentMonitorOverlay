import { expect, test } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function setup() {
  studio = await launchStudio({ mockModel: false });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const make = async (title: string, column: Task["column"]) => {
    const { task } = await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id });
    await studio!.api("PATCH", `/api/tasks/${task.id}`, { column });
    return task;
  };
  const a = await make("导入图片", "todo");
  const b = await make("检查尺寸", "todo");
  const c = await make("整理配置", "doing");
  const d = await make("等待验收", "review");
  await studio.page.getByTestId("scope-all").click();
  await expect(studio.page.getByTestId("task-card")).toHaveCount(4);
  return { ...studio, a, b, c, d };
}

test("marquee selects across grouped columns and dragging any selected card moves the whole selection", async () => {
  const { page, app, api, a, b, c, d } = await setup();
  const todo = page.getByTestId("column-todo");
  const doing = page.getByTestId("column-doing");
  const done = page.getByTestId("column-done");
  const left = (await todo.boundingBox())!;
  const right = (await doing.boundingBox())!;
  const cards = await todo.getByTestId("task-card").all();
  const top = (await cards[0]!.boundingBox())!;
  const bottom = (await cards[1]!.boundingBox())!;
  // The column's gap above its first card is a safe starting point, including when grouped.
  await page.mouse.move(left.x - 5, top.y - 4);
  await page.mouse.down();
  await page.mouse.move(right.x + right.width - 2, bottom.y + bottom.height + 4, { steps: 12 });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(3);
  await expect(page.getByTestId("board-selection-box")).toBeVisible();
  await screenshot(app, "studio", "board-marquee", page);
  await page.mouse.up();
  await expect(page.getByTestId("board-selection-box")).toHaveCount(0);
  // Includes a task already in the destination column; it stays there while the other two join it.
  await page.locator(`[data-task-id="${a.id}"]`).dragTo(doing, { targetPosition: { x: 30, y: right.height - 20 } });
  await expect(doing.getByTestId("task-card")).toHaveCount(3);
  await expect(todo.getByTestId("task-card")).toHaveCount(0);
  await expect.poll(async () => (await api<{ tasks: Task[] }>("GET", "/api/state")).tasks.filter((t) => [a.id, b.id, c.id].includes(t.id)).map((t) => t.column)).toEqual(["doing", "doing", "doing"]);
  // Starting a new drag on an unselected task must not carry the previous selection with it.
  await page.locator(`[data-task-id="${d.id}"]`).dragTo(done);
  await expect(done.getByTestId("task-card")).toHaveCount(1);
  await expect(doing.getByTestId("task-card")).toHaveCount(3);
  await page.locator(`[data-task-id="${a.id}"]`).click();
  await expect(page.getByRole("button", { name: "返回看板" })).toBeVisible();
});

test("ungrouped selection supports reverse marquee, modifiers, cancellation and scope changes", async () => {
  const { page, a, b, c } = await setup();
  await page.getByTestId("board-group-topics").uncheck();
  const todo = page.getByTestId("column-todo");
  const first = (await todo.getByTestId("task-card").first().boundingBox())!;
  const last = (await todo.getByTestId("task-card").last().boundingBox())!;
  const start = { x: last.x + last.width + 5, y: last.y + last.height + 4 };
  const end = { x: first.x - 3, y: first.y - 4 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(2);
  // Shrinking the rectangle back to the start clears the earlier hits.
  await page.mouse.move(start.x, start.y, { steps: 10 });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(2);
  await page.locator(`[data-task-id="${c.id}"]`).click({ modifiers: ["Control"] });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(3);
  await page.locator(`[data-task-id="${b.id}"]`).click({ modifiers: ["Shift"] });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
  // Modifier marquee adds its hits to a card selected in another column.
  await page.locator(`[data-task-id="${c.id}"]`).click({ modifiers: ["Control"] });
  await page.keyboard.down("Shift");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.locator(`[data-task-id="${a.id}"]`).click({ modifiers: ["Control"] });
  await page.mouse.click(start.x, start.y);
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
  // Escape during an unfinished gesture must not reselect cards on the next pointer move.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.keyboard.press("Escape");
  await page.mouse.move(start.x, start.y);
  await page.mouse.up();
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
  await page.locator(`[data-task-id="${a.id}"]`).click({ modifiers: ["Control"] });
  await page.getByTestId("scope-ws-alpha").click();
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
  await page.getByTestId("scope-all").click();
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(0);
});

test("scrolling during marquee recalculates selection without another pointer move", async () => {
  const { page, api, a } = await setup();
  await page.getByTestId("board-group-topics").uncheck();
  for (let i = 0; i < 8; i++) await api("POST", "/api/tasks", { title: `额外任务 ${i}`, workspaceId: a.workspaceId });
  const todo = page.getByTestId("column-todo");
  await expect(todo.getByTestId("task-card")).toHaveCount(10);
  const first = (await todo.getByTestId("task-card").first().boundingBox())!;
  await page.mouse.move(first.x - 4, first.y - 4);
  await page.mouse.down();
  await page.mouse.move(first.x + first.width - 2, first.y + first.height + 3, { steps: 10 });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(1);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.locator('.card[aria-pressed="true"]').count()).toBeGreaterThan(1);
  await page.mouse.up();
  await expect(page.getByTestId("board-selection-box")).toHaveCount(0);
});
