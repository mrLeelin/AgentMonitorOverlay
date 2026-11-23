import { expect, test } from "@playwright/test";
import type { CanvasDoc, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function setup() {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("gestures") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "卡片点击与拖动" });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "直接拖动任务", workspaceId: ws.id, topicId: topic.id });
  const { task: external } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "被引用的任务", workspaceId: ws.id });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const empty = await canvas();
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...empty, nodes: [
    { id: "task", kind: "task", taskId: task.id, groupId: null, pos: { x: 80, y: 110 } },
    { id: "note", kind: "note", text: "直接拖动便签", groupId: null, pos: { x: 450, y: 110 } },
    { id: "ref", kind: "ref", taskId: external.id, groupId: null, pos: { x: 80, y: 350 } },
    { id: "item", kind: "item", num: 1, title: "直接拖动审阅卡", body: "区分点击与移动", refs: [], status: "todo", sessionId: null, groupId: null, pos: { x: 450, y: 350 } },
  ] });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  await page.getByTestId("canvas-sidebar-toggle").click();
  await expect(page.locator("[data-node-id]")).toHaveCount(4);
  return { page, canvas };
}

test("unselected cards move on the first drag without opening details, including at changed zoom", async () => {
  const { page, canvas } = await setup();
  for (const id of ["task", "note", "ref", "item"]) {
    const card = page.locator(`[data-node-id="${id}"]`);
    const before = (await canvas()).nodes.find((n) => n.id === id)!.pos;
    const box = (await card.boundingBox())!;
    const from = { x: box.x + 50, y: box.y + 20 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
    await page.mouse.move(from.x + 60, from.y + 35, { steps: 5 });
    await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
    await page.mouse.up();
    await expect.poll(async () => (await canvas()).nodes.find((n) => n.id === id)!.pos).toEqual({ x: before.x + 60, y: before.y + 35 });
    await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
    await expect(page.getByTestId("canvas-viewport")).toBeVisible();
  }
  await page.getByRole("button", { name: "放大" }).click();
  const task = page.locator('[data-node-id="task"]');
  const before = (await canvas()).nodes.find((n) => n.id === "task")!.pos;
  const box = (await task.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 56, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.id === "task")!.pos).toEqual({ x: before.x + 50, y: before.y + 30 });
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await screenshot(studio!.app, "studio", "canvas-gestures-drag", page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await screenshot(studio!.app, "studio", "canvas-gestures-drag-dark", page);
  await page.reload();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(task).toHaveCSS("left", `${before.x + 50}px`);
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
});

test("a click opens details only on release; small jitter is a click and a later drag closes details", async () => {
  const { page, canvas } = await setup();
  const card = page.locator('[data-node-id="task"]');
  const before = await canvas();
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await page.mouse.move(box.x + 51, box.y + 21);
  await page.mouse.up();
  await expect(page.getByTestId("canvas-detail")).toBeVisible();
  expect(await canvas()).toEqual(before);
  await screenshot(studio!.app, "studio", "canvas-gestures-click", page);
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 45, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.id === "task")!.pos).toEqual({ x: 120, y: 135 });
  await card.click();
  await expect(page.getByTestId("canvas-detail")).toBeVisible();
  await card.dblclick();
  await expect(page.getByTestId("task-title")).toHaveText("直接拖动任务");
});

test("fast drags persist and window blur cancels a preview without opening details", async () => {
  const { page, canvas } = await setup();
  const card = page.locator('[data-node-id="task"]');
  let box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 110, box.y + 50);
  await page.mouse.up();
  await expect.poll(async () => (await canvas()).nodes.find((n) => n.id === "task")!.pos).toEqual({ x: 140, y: 140 });
  const saved = await canvas();
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 45);
  await expect(card).toHaveCSS("left", "180px");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(card).toHaveCSS("left", "140px");
  expect(await canvas()).toEqual(saved);
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await card.click();
  await expect(page.getByTestId("canvas-detail")).toBeVisible();
});
