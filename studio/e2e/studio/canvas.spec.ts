import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, Session, Task, Workspace, Topic } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + Math.min(40, box.width / 2);
  const y = box.y + Math.min(20, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("canvas: middle-button dragging pans from empty space, cards and handles without editing the document", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "中键平移" });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "中键拖动画布", workspaceId: ws.id, topicId: topic.id });
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const card = page.getByTestId("canvas-card");
  const world = page.getByTestId("canvas-world");
  const viewport = page.getByTestId("canvas-viewport");
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "复位" }).click();
  const before = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const vbox = (await viewport.boundingBox())!;

  for (const target of [null, card.locator(".canvas-card-title"), card.getByTestId("canvas-handle").first()]) {
    const box = target ? (await target.boundingBox())! : null;
    const x = box ? box.x + box.width / 2 : vbox.x + vbox.width - 200;
    const y = box ? box.y + box.height / 2 : vbox.y + vbox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(x + 40, y + 20, { steps: 3 });
    await expect(viewport).toHaveClass(/panning/);
    await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
    // Releasing another button must not end the middle-button gesture.
    await page.mouse.down({ button: "right" });
    await page.mouse.up({ button: "right" });
    await page.mouse.move(x + 80, y + 45, { steps: 3 });
    await expect(world).toHaveAttribute("style", /translate\(80px, 45px\) scale\(1\)/);
    await page.mouse.up({ button: "middle" });
    await expect(viewport).not.toHaveClass(/panning/);
    await page.mouse.move(x + 100, y + 60);
    await expect(world).toHaveAttribute("style", /translate\(80px, 45px\) scale\(1\)/);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "复位" }).click();
  }
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  expect(await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).toEqual(before);
  await screenshot(studio.app, "studio", "canvas-middle-pan", page);
});

test("canvas: left-button marquee selects cards and moves them together at a changed zoom and pan", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "左键框选" });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const empty = await canvas();
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...empty, nodes: [
    { id: "a", kind: "note", text: "一起移动 A", groupId: null, pos: { x: 120, y: 120 } },
    { id: "b", kind: "note", text: "一起移动 B", groupId: null, pos: { x: 380, y: 120 } },
    { id: "c", kind: "note", text: "追加选择 C", groupId: null, pos: { x: 120, y: 360 } },
  ] });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const notes = page.getByTestId("canvas-note");
  await expect(notes).toHaveCount(3);
  await page.getByRole("button", { name: "复位" }).click();
  await page.getByRole("button", { name: "缩小" }).click();
  const viewport = page.getByTestId("canvas-viewport");
  const world = page.getByTestId("canvas-world");
  const v = (await viewport.boundingBox())!;
  await page.mouse.move(v.x + v.width - 150, v.y + 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(v.x + v.width - 130, v.y + 120, { steps: 3 });
  await page.mouse.up({ button: "middle" });
  const transform = await world.getAttribute("style");
  const before = await canvas();
  const a = (await notes.nth(0).boundingBox())!;
  const b = (await notes.nth(1).boundingBox())!;
  // Reverse direction, starting and ending on gaps, with only part of B intersecting the box.
  await page.mouse.move(b.x + b.width / 2, b.y + b.height + 15);
  await page.mouse.down();
  await page.mouse.move(a.x - 15, a.y - 15, { steps: 8 });
  await expect(page.getByTestId("canvas-selection-box")).toBeVisible();
  await expect(page.locator(".canvas-note.selected")).toHaveCount(2);
  await expect(world).toHaveAttribute("style", transform!);
  await screenshot(studio.app, "studio", "canvas-left-marquee", page);
  await page.mouse.up();
  await expect(page.getByTestId("canvas-selection-box")).toHaveCount(0);
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  expect(await canvas()).toEqual(before);

  await dragBy(page, notes.nth(0), 50, 25);
  await expect.poll(async () => (await canvas()).nodes.map((n) => n.pos)).toEqual([
    { x: 180, y: 150 }, { x: 440, y: 150 }, { x: 120, y: 360 },
  ]);
  await expect(page.locator(".canvas-note.selected")).toHaveCount(2);
  await expect(world).toHaveAttribute("style", transform!);

  const c = (await notes.nth(2).boundingBox())!;
  await page.keyboard.down("Control");
  await page.mouse.move(c.x - 15, c.y - 15);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width + 15, c.y + c.height + 15, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(page.locator(".canvas-note.selected")).toHaveCount(3);
  const saved = await canvas();
  const savedBox = (await notes.nth(0).boundingBox())!;
  await page.mouse.move(savedBox.x + 40, savedBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(savedBox.x + 90, savedBox.y + 45, { steps: 4 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".canvas-note.selected")).toHaveCount(0);
  await expect.poll(async () => (await notes.nth(0).boundingBox())?.x).toBe(savedBox.x);
  expect(await canvas()).toEqual(saved);
  await notes.nth(0).click();
  await expect(page.getByTestId("canvas-detail")).toBeVisible();
  await page.mouse.click(v.x + v.width - 130, v.y + 80);
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await expect(page.locator(".canvas-note.selected")).toHaveCount(0);
});

test("canvas: Ctrl-click adds and toggles cards, groups and lines without replacing the selection", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "Ctrl 多选" });
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const empty = await canvas();
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...empty,
    groups: [
      { id: "g1", title: "分组一", workspaceId: null, rect: { x: 80, y: 60, w: 300, h: 550 } },
      { id: "g2", title: "分组二", workspaceId: null, rect: { x: 640, y: 60, w: 200, h: 140 } },
    ],
    nodes: [
      { id: "a", kind: "note", text: "选择 A", groupId: "g1", pos: { x: 110, y: 130 } },
      { id: "b", kind: "note", text: "选择 B", groupId: "g1", pos: { x: 110, y: 350 } },
      { id: "c", kind: "note", text: "选择 C", groupId: null, pos: { x: 430, y: 350 } },
    ],
    links: [{ id: "l1", from: "a", fromSide: "bottom", to: "c", toSide: "left", label: "A → C" }],
  });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "复位" }).click();
  const note = (id: string) => page.locator(`[data-node-id="${id}"]`);
  const group = (id: string) => page.locator(`.canvas-group[data-group-id="${id}"]`);
  const selected = page.locator(".canvas-note.selected");
  const before = await canvas();
  await note("a").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(1);
  await page.keyboard.down("Control");
  await note("b").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(2);
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  await note("a").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(1);
  await expect(note("b")).toHaveClass(/selected/);
  await note("a").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(2);
  await page.getByTestId("canvas-link-label").click();
  await expect(page.getByTestId("canvas-link")).toHaveClass(/selected/);
  await note("c").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(3);
  await expect(page.getByTestId("canvas-link")).toHaveClass(/selected/);
  await note("c").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(2);
  await group("g1").locator(".canvas-group-bar").click();
  await group("g2").locator(".canvas-group-bar").click();
  await page.keyboard.up("Control");
  await expect(page.locator(".canvas-group.selected")).toHaveCount(2);
  expect(await canvas()).toEqual(before);
  await screenshot(studio.app, "studio", "canvas-ctrl-multiselect", page);

  // A card selected with its own group moves only once; both selected groups move together.
  await dragBy(page, note("a"), 40, 20);
  await expect.poll(async () => (await canvas()).nodes.map((n) => n.pos)).toEqual([
    { x: 150, y: 150 }, { x: 150, y: 370 }, { x: 430, y: 350 },
  ]);
  expect((await canvas()).groups.map((g) => g.rect)).toEqual(before.groups.map((g) => ({ ...g.rect, x: g.rect.x + 40, y: g.rect.y + 20 })));
  await page.keyboard.press("Delete");
  const confirm = page.getByTestId("canvas-delete-confirm");
  await expect(confirm).toContainText("2 个分组、2 张卡片、1 条连线");
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(selected).toHaveCount(2);
  await expect(page.locator(".canvas-group.selected")).toHaveCount(2);

  // A plain click on another card replaces the mixed selection; Ctrl-clicking it again clears it.
  await note("c").click({ position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(1);
  await expect(note("c")).toHaveClass(/selected/);
  await expect(page.locator(".canvas-group.selected, .canvas-link.selected")).toHaveCount(0);
  await note("c").click({ modifiers: ["Control"], position: { x: 20, y: 20 } });
  await expect(selected).toHaveCount(0);

  await group("g1").locator(".canvas-group-bar").click();
  await group("g2").locator(".canvas-group-bar").click({ modifiers: ["Control"] });
  await expect(page.locator(".canvas-group.selected")).toHaveCount(2);
  const beforeGroupsRemoved = await canvas();
  await page.keyboard.press("Delete");
  await expect(confirm).toContainText("2 个分组");
  await expect(confirm).toContainText("未选中的卡片留在原处");
  await confirm.getByTestId("confirm-action").click();
  await expect.poll(async () => (await canvas()).groups).toEqual([]);
  expect((await canvas()).nodes).toEqual(beforeGroupsRemoved.nodes.map((n) => ({ ...n, groupId: null })));
  expect((await canvas()).links).toEqual(beforeGroupsRemoved.links);
});

test("canvas: tasks appear, cards move and persist, pan and zoom", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  for (const title of ["整理导入流程", "掉落表校验"]) {
    const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true }); // shown on the canvas (S11-A: not automatic)
  }

  await page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await expect(cards).toHaveCount(2);
  await expect.poll(async () => (await studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.length).toBe(2);
  await page.getByRole("button", { name: "复位" }).click();
  await expect(page.getByTestId("zoom-label")).toHaveText("100%");

  // Drag a card: the new position is saved in the Host.
  const card = cards.filter({ hasText: "掉落表校验" });
  const nodeId = (await card.getAttribute("data-node-id"))!;
  const before = (await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.find((n) => n.id === nodeId)!.pos;
  await dragBy(page, card, 120, 160);
  await expect
    .poll(async () => (await studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes.find((n) => n.id === nodeId)!.pos)
    .toEqual({ x: before.x + 120, y: before.y + 160 });

  // Pan with the middle button; zoom with the wheel and the buttons; reset (the dragged card's 详情框 put away first:
  // the wheel over it scrolls the box, not the canvas).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("canvas-detail")).toHaveCount(0);
  const world = page.getByTestId("canvas-world");
  const viewport = page.getByTestId("canvas-viewport");
  const vbox = (await viewport.boundingBox())!;
  await page.mouse.move(vbox.x + vbox.width - 120, vbox.y + vbox.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(vbox.x + vbox.width - 220, vbox.y + vbox.height / 2 + 50, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await expect(world).toHaveAttribute("style", /translate\(-100px, 50px\) scale\(1\)/);
  await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2);
  await page.mouse.wheel(0, -120);
  await expect(page.getByTestId("zoom-label")).toHaveText("110%");
  await page.getByRole("button", { name: "缩小" }).click();
  await expect(page.getByTestId("zoom-label")).toHaveText("92%");
  await page.getByRole("button", { name: "复位" }).click();
  await expect(world).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/);
  await screenshot(studio.app, "stage-3", "S3-02-canvas", page);

  // A task created elsewhere is not placed by itself (S11-A); shown while the canvas is open, it appears. Double-click
  // opens it.
  const { task: late } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "新来的任务", workspaceId: ws.id, topicId: topic.id, firstSession: { profileId: "codex-mock" } });
  await expect(cards).toHaveCount(2);
  await studio.api("PUT", `/api/tasks/${late.id}/canvas`, { onCanvas: true });
  await expect(cards).toHaveCount(3);
  await cards.filter({ hasText: "新来的任务" }).dblclick();
  await expect(page.getByTestId("task-title")).toHaveText("新来的任务");
});

test("an archived task keeps its card on the canvas, greyed and marked 已归档, with its dependency (2026-10-22)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布" });
  const ids: string[] = [];
  for (const title of ["拆掉旧的掉落表", "改导入流程"]) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
    ids.push(task.id);
  }
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...doc, edges: [{ id: "e-dep", kind: "depends", from: ids[0], to: ids[1] }] });
  await studio.api("POST", `/api/tasks/${ids[0]}/archive`);

  await page.getByRole("navigation", { name: "视图" }).getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await expect(cards).toHaveCount(2);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
  const gone = cards.filter({ hasText: "拆掉旧的掉落表" });
  await expect(gone).toHaveClass(/is-archived/);
  await expect(gone.getByTestId("canvas-card-archived")).toHaveText("已归档");
  await expect(cards.filter({ hasText: "改导入流程" })).not.toHaveClass(/is-archived/);

  // Its menu: read-only, so no description and no new dependency.
  await gone.click({ button: "right" });
  const menu = page.getByTestId("canvas-menu");
  await expect(menu.getByRole("menuitem", { name: "打开任务（只读）" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /添加说明|连依赖/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await screenshot(app, "stage-18", "S18-canvas-archived-card", page);
  await gone.dblclick();
  await expect(page.getByTestId("task-archived-banner")).toContainText("已归档 · 只读");
});
