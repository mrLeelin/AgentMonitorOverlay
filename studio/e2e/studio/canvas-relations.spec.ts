import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CanvasDoc, CanvasLink, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const line = (id: string, from: string, to: string, label?: string): CanvasLink => ({ id, from, to, fromSide: "right", toSide: "left", ...(label ? { label } : {}) });

async function seed(titles = ["甲：方案", "乙：实现", "丙：验收"]) {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("canvas-relations") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "连线纠错验收" });
  const tasks: Task[] = [];
  for (const title of titles) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id });
    tasks.push(task);
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  }
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const base = await canvas();
  const positions = [{ x: 80, y: 80 }, { x: 450, y: 80 }, { x: 270, y: 330 }, { x: 700, y: 330 }];
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, { ...base, nodes: base.nodes.map((n, i) => ({ ...n, pos: positions[i] ?? { x: 80 + i * 260, y: 500 } })) });
  const card = (index: number) => studio!.page.getByTestId("canvas-card").filter({ hasText: titles[index]! });
  const open = async () => {
    await studio!.page.getByRole("button", { name: "画布", exact: true }).click();
    await expect(studio!.page.getByTestId("canvas-card")).toHaveCount(tasks.length);
    await studio!.page.getByRole("button", { name: "全部", exact: true }).click();
  };
  return { ws, topic, tasks, canvas, card, open };
}

async function connect(page: Page, from: Locator, to: Locator, side = "right", toSide = "left") {
  await page.keyboard.press("Escape");
  await from.hover();
  const h = (await from.locator(`[data-testid="canvas-handle"][data-side="${side}"]`).boundingBox())!;
  const t = (await to.locator(`[data-testid="canvas-handle"][data-side="${toSide}"]`).boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function rightClickLine(page: Page, hit: Locator) {
  const at = await hit.evaluate((el) => {
    const p = el as SVGGeometryElement;
    const point = p.getPointAtLength(p.getTotalLength() / 2);
    const matrix = p.getScreenCTM()!;
    return { x: point.x * matrix.a + matrix.e, y: point.y * matrix.d + matrix.f };
  });
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.getByTestId("canvas-menu")).toBeVisible();
}

test("ordinary lines: real drags reject cross-side duplicates, self links and cycles; reversal shares the rules", async () => {
  const { canvas, card, open } = await seed();
  const { page, app } = studio!;
  await open();
  await connect(page, card(0), card(1));
  await expect.poll(async () => (await canvas()).links?.length).toBe(1);
  const first = await canvas();
  await connect(page, card(0), card(1), "bottom", "top");
  await expect(page.getByTestId("canvas-notice")).toContainText("已存在");
  expect(await canvas()).toEqual(first);
  await connect(page, card(0), card(0), "right", "bottom");
  await expect(page.getByTestId("canvas-notice")).toContainText("自身");
  expect(await canvas()).toEqual(first);
  await connect(page, card(1), card(0), "top", "top");
  await expect(page.getByTestId("canvas-notice")).toContainText("循环");
  expect(await canvas()).toEqual(first);
  await connect(page, card(1), card(2), "bottom", "right");
  await expect.poll(async () => (await canvas()).links?.length).toBe(2);
  const chain = await canvas();
  await connect(page, card(2), card(0), "left", "bottom");
  await expect(page.getByTestId("canvas-notice")).toContainText("循环");
  await expect(page.getByTestId("canvas-notice")).toContainText("甲：方案");
  await expect(page.getByTestId("canvas-notice")).toContainText("丙：验收");
  expect(await canvas()).toEqual(chain);
  await screenshot(app, "studio", "canvas-relations-drag-cycle", page);

  await connect(page, card(0), card(2), "bottom", "left");
  await expect.poll(async () => (await canvas()).links?.length).toBe(3);
  const triangle = await canvas();
  const shortcut = triangle.links![2]!;
  await rightClickLine(page, page.locator(`[data-link-id="${shortcut.id}"]`).locator("..").getByTestId("canvas-link-hit"));
  await page.getByTestId("canvas-menu").getByRole("menuitem", { name: "反过来", exact: true }).click();
  await expect(page.getByTestId("canvas-notice")).toContainText("循环");
  expect(await canvas()).toEqual(triangle);
  await screenshot(app, "studio", "canvas-relations-reverse-cycle", page);

  const ab = triangle.links![0]!;
  await rightClickLine(page, page.locator(`[data-link-id="${ab.id}"]`).locator("..").getByTestId("canvas-link-hit"));
  await page.getByTestId("canvas-menu").getByRole("menuitem", { name: "反过来", exact: true }).click();
  await expect.poll(async () => (await canvas()).links?.find((l) => l.id === ab.id)).toMatchObject({ from: ab.to, to: ab.from, fromSide: ab.toSide, toSide: ab.fromSide });
  await expect(page.getByTestId("canvas-link")).toHaveCount(3);
});

test("dependencies: details allow a diamond; reverse and direct API reject cycles atomically", async () => {
  const { topic, tasks, canvas, card, open } = await seed(["甲：策划", "乙：程序", "丙：美术", "丁：集成"]);
  const { page, app } = studio!;
  const doc = await canvas();
  const edge = (id: string, from: number, to: number) => ({ id, kind: "depends" as const, from: tasks[from]!.id, to: tasks[to]!.id });
  await studio!.api("PUT", `/api/topics/${topic.id}/canvas`, { ...doc, edges: [edge("ab", 0, 1), edge("ac", 0, 2), edge("bd", 1, 3)] });
  await open();
  await card(3).click();
  await page.getByRole("combobox", { name: "添加前置任务", exact: true }).selectOption(tasks[2]!.id);
  await page.getByTestId("canvas-detail").getByRole("button", { name: "添加", exact: true }).click();
  await expect.poll(async () => (await canvas()).edges.length).toBe(4);
  const diamond = await canvas();
  await page.getByRole("combobox", { name: "添加前置任务", exact: true }).selectOption(tasks[1]!.id);
  await page.getByTestId("canvas-detail").getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByTestId("canvas-notice")).toContainText("已存在");
  await expect(page.getByTestId("canvas-notice")).toContainText("乙：程序");
  await expect(page.getByTestId("canvas-notice")).toContainText("丁：集成");
  expect(await canvas()).toEqual(diamond);
  await page.keyboard.press("Escape");
  await card(0).click();
  await page.getByRole("combobox", { name: "添加前置任务", exact: true }).selectOption(tasks[3]!.id);
  await page.getByTestId("canvas-detail").getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByTestId("canvas-notice")).toContainText("循环");
  await expect(page.getByTestId("canvas-notice")).toContainText("甲：策划");
  await expect(page.getByTestId("canvas-notice")).toContainText("丁：集成");
  expect(await canvas()).toEqual(diamond);
  await page.keyboard.press("Escape");
  await card(0).click({ button: "right" });
  await page.getByTestId("canvas-menu").getByTestId("menu-link").click();
  await card(3).click();
  await expect.poll(async () => (await canvas()).edges.length).toBe(5);
  await page.keyboard.press("Escape");
  await rightClickLine(page, page.getByTestId("canvas-edge-hit").last());
  await page.getByTestId("canvas-menu").getByRole("menuitem", { name: "反过来", exact: true }).click();
  await expect(page.getByTestId("canvas-notice")).toContainText("循环");
  const before = await canvas();
  await expect(studio!.api("PUT", `/api/topics/${topic.id}/canvas`, { ...before, nodes: before.nodes.map((n) => ({ ...n, pos: { x: n.pos.x + 11, y: n.pos.y } })), edges: [...before.edges, edge("da", 3, 0)] })).rejects.toThrow(/400.*循环/);
  expect(await canvas()).toEqual(before);

  await expect(page.getByRole("combobox", { name: "添加协作任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /协作/ })).toHaveCount(0);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(5);
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await screenshot(app, "studio", "canvas-relations-dependency-only", page);
});

test("legacy dirty board: readable and movable; locatable repairs preserve distinct labels until explicitly removed", async () => {
  const seeded = await seed();
  const { topic, tasks } = seeded;
  const doc = await seeded.canvas();
  const [a, b, c] = doc.nodes.map((n) => n.id);
  const dirty: CanvasDoc = { ...doc, links: [line("legacy-one", a!, b!, "策划说明必须保留"), { ...line("legacy-two", a!, b!, "程序补充也必须保留"), fromSide: "top" }, line("legacy-bc", b!, c!), line("legacy-ca", c!, a!)] };
  const root = studio!.root;
  await studio!.close({ keepData: true });
  studio = undefined;
  const db = new DatabaseSync(join(root, "data", "studio.db"));
  db.prepare("UPDATE canvas_docs SET body = ? WHERE id = ?").run(JSON.stringify(dirty), topic.id);
  db.close();
  studio = await launchStudio({ root });
  const { page, app } = studio;
  const canvas = () => studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("canvas-link")).toHaveCount(4);
  const repair = page.locator("details").filter({ has: page.locator("summary", { hasText: "连线需要检查" }) });
  await repair.locator("summary").click();
  await expect(repair).toContainText("策划说明必须保留");
  await expect(repair).toContainText("程序补充也必须保留");
  await repair.getByRole("button", { name: "定位", exact: true }).first().click();
  await expect(page.getByTestId("canvas-detail")).toContainText(tasks[0]!.title);
  await page.keyboard.press("Escape");
  const card = page.getByTestId("canvas-card").filter({ hasText: tasks[0]!.title });
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + 35, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await canvas()).version).toBeGreaterThan(dirty.version);
  expect((await canvas()).links).toEqual(dirty.links);
  await page.getByTestId("canvas-detail-close").click();
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await screenshot(app, "studio", "canvas-relations-legacy-repair", page);
  await repair.locator("[data-relation-id='legacy-two']").first().scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "canvas-relations-legacy-labels", page);
  // A person chooses the exact labelled line to remove; no automatic deduplication is allowed.
  const row = repair.locator("[data-relation-id='legacy-two']").first();
  await row.getByRole("button", { name: "删除此线", exact: true }).click();
  await expect.poll(async () => (await canvas()).links?.map((l) => l.id)).toEqual(["legacy-one", "legacy-bc", "legacy-ca"]);
  expect((await canvas()).links?.[0]?.label).toBe("策划说明必须保留");
  const cycleRow = repair.locator("[data-relation-id='legacy-ca']").first();
  await cycleRow.getByRole("button", { name: "删除此线", exact: true }).click();
  await expect.poll(async () => (await canvas()).links?.length).toBe(2);
  await expect(repair).toHaveCount(0);
});

test("management layout: hierarchy stays aligned and centered with distinct orthogonal management paths", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("canvas-tree") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "管理树布局验收" });
  const make = async (title: string, lead = false, managerTaskId?: string) => (await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, lead, managerTaskId, workspaceId: ws.id, topicId: topic.id })).task;
  const root = await make("总主控", true);
  const left = await make("玩法主控", true, root.id);
  const right = await make("表现主控", true, root.id);
  const leaves = [await make("关卡执行", false, left.id), await make("角色执行", false, left.id), await make("视听执行", false, right.id)];
  for (const task of [root, left, right, ...leaves]) await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(6);
  await page.getByRole("button", { name: "按管理层级排列", exact: true }).click();
  await expect.poll(async () => {
    const d = await studio!.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    const pos = (task: Task) => d.nodes.find((n) => n.kind === "task" && n.taskId === task.id)!.pos;
    return pos(root).y < pos(left).y && pos(left).y === pos(right).y && leaves.every((t) => pos(t).y > pos(left).y);
  }).toBe(true);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("canvas-management-line")).toHaveCount(5);
  for (const route of await page.getByTestId("canvas-management-line").all()) await expect(route).toHaveAttribute("d", /^M.*L/);
  const boxes = await page.getByTestId("canvas-card").evaluateAll((cards) => cards.map((card) => {
    const r = card.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]!; const b = boxes[j]!;
    expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  }
  const rootBox = boxes[0]!;
  const forestMid = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.w))) / 2;
  expect(Math.abs(rootBox.x + rootBox.w / 2 - forestMid)).toBeLessThan(1);
  const crossesCard = await page.getByTestId("canvas-management-line").evaluateAll((paths) => {
    const cards = [...document.querySelectorAll('[data-testid="canvas-card"]')].map((card) => card.getBoundingClientRect());
    return paths.some((el) => {
      const path = el as SVGPathElement;
      const matrix = path.getScreenCTM()!;
      const length = path.getTotalLength();
      for (let i = 1; i < 100; i++) {
        const p = path.getPointAtLength(length * i / 100);
        const x = p.x * matrix.a + matrix.e; const y = p.y * matrix.d + matrix.f;
        if (cards.some((r) => x > r.left + 0.5 && x < r.right - 0.5 && y > r.top + 0.5 && y < r.bottom - 0.5)) return true;
      }
      return false;
    });
  });
  expect(crossesCard).toBe(false);
  await screenshot(app, "studio", "canvas-relations-management-tree", page);
});
