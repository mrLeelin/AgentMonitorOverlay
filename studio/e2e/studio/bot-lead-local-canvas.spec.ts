import { expect, test, type Page } from "@playwright/test";
import type { BotLeadOperationReceipt, BotLeadOperationView, CanvasDoc, Session, Topic } from "@amo-studio/protocol";
import { createBot, evidence, holdRequest, items, leadState, otherWindow, project, submitMessage, workbench } from "../support/bot-lead-local.js";
import { seedCanvasPerformance } from "../support/canvas-performance.js";
import { launchStudio, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("a Bot chat routes a real user message by task id across same-name topics, projects and roots", async ({}, info) => {
  studio = await launchStudio();
  const own = studio;
  const { page } = own;
  const east = await project(own, "路由项目甲");
  const west = await project(own, "路由项目乙");
  const topics = await Promise.all([east, west].map((ws) => own.api<Topic>("POST", "/api/topics", { title: "同名交付专题", workspaceIds: [ws.id] })));
  const bot = await createBot(own, east, "路由助手");
  const roots = [];
  for (const [index, ws] of [east, west, west].entries()) {
    roots.push(await own.api<BotLeadOperationReceipt>("POST", "/api/bot-leads/appointments", { operationId: `route-root-${index}`, source: { kind: "manual" }, intent: "create", workspaceId: ws.id, title: "同名交付目标", topic: { topicId: topics[index === 0 ? 0 : 1]!.id }, botId: bot.id }));
  }
  const selected = roots[2]!;
  const selectedCanvas = `/api/topics/${selected.topicId}/canvas`;
  const original = await own.api<CanvasDoc>("GET", selectedCanvas);
  const moved = await own.api<CanvasDoc>("PUT", selectedCanvas, { ...original, nodes: original.nodes.map((node, index) => ({ ...node, pos: { x: 100 + 360 * index, y: 133 } })) });
  const home = await own.api<Session>("POST", `/api/bots/${bot.id}/home`, {});
  const input = "请把窄屏也纳入临时验收";
  await submitMessage(own, home.id, input);
  await workbench(page);
  await page.getByRole("button", { name: "打开主聊天", exact: true }).click();
  const row = page.locator(".msg-user-row").filter({ hasText: input });
  await row.getByText("安排这条请求", { exact: true }).click();
  await row.getByRole("button", { name: "交给已有主控", exact: true }).click();
  const form = page.getByTestId("lead-appointment");
  const target = form.getByRole("combobox", { name: "收件目标", exact: true });
  await expect(target).toHaveValue("");
  const choices = await target.locator("option").allTextContents();
  expect(choices.filter((value) => value.includes("路由项目甲"))).toHaveLength(1);
  expect(choices.filter((value) => value.includes("路由项目乙"))).toHaveLength(2);
  expect(new Set(choices).size).toBe(choices.length);
  await target.selectOption(selected.taskId);
  const reopen = form.getByRole("checkbox", { name: "重开这项工作", exact: true });
  const needsReopen = await reopen.isVisible();
  if (needsReopen) await reopen.check();
  const post = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bot-leads/appointments" && response.request().method() === "POST");
  await form.getByRole("button", { name: needsReopen ? "确认重开并追加" : "发送给主控", exact: true }).click();
  const response = await post;
  expect(response.ok(), await response.text()).toBe(true);
  const receipt = await response.json() as BotLeadOperationReceipt;
  expect(receipt).toMatchObject({ taskId: selected.taskId, topicId: selected.topicId, action: "continue" });
  const operation = () => own.api<BotLeadOperationView>("GET", `/api/bot-leads/operations/${receipt.operationId}`);
  await expect.poll(async () => (await operation()).delivery?.stage, { timeout: 30_000 }).toBe("processed");
  const delivery = (await operation()).delivery!;
  for (const root of roots) {
    const state = (await leadState(own, root.taskId)).state;
    if (state?.kind !== "appointed" || !state.term.sessionId) throw new Error("Expected an active lead session");
    expect((await items(own, state.term.sessionId)).filter((item) => item.id === delivery.messageId)).toHaveLength(root.taskId === selected.taskId ? 1 : 0);
  }
  await page.reload();
  await expect(row.getByTestId("lead-acceptance")).toContainText("路由项目乙");
  await row.getByRole("button", { name: "打开专题画布", exact: true }).click();
  const selectedNode = moved.nodes.find((node) => node.kind === "task" && node.taskId === selected.taskId)!;
  await expect(page.locator(`[data-node-id="${selectedNode.id}"]`)).toHaveClass(/selected/);
  await expect(page.getByTestId("canvas-card")).toHaveCount(2);
  expect(await own.api("GET", selectedCanvas)).toEqual(moved);
  await page.getByRole("button", { name: "返回原对话", exact: true }).click();
  await expect(row.getByTestId("lead-acceptance")).toContainText("路由项目乙");
  await evidence(info, "explicit-target", { receipt, choices, delivery, layout: moved });
});

test("concurrent canvas drags preserve both formally appointed cards and merge separate moves", async ({}, info) => {
  studio = await launchStudio();
  const own = studio;
  const { page } = own;
  const ws = await project(own, "concurrent-layout");
  const topic = await own.api<Topic>("POST", "/api/topics", { title: "并发画布布局", workspaceIds: [ws.id] });
  const bot = await createBot(own, ws, "布局机器人");
  for (const title of ["并发左根", "并发右根"]) {
    await own.api("POST", "/api/bot-leads/appointments", { operationId: `layout-${title}`, source: { kind: "manual" }, intent: "create", workspaceId: ws.id, title, topic: { topicId: topic.id }, botId: bot.id });
  }
  const path = `/api/topics/${topic.id}/canvas`;
  const canvas = () => own.api<CanvasDoc>("GET", path);
  const original = await canvas();
  const before = await own.api<CanvasDoc>("PUT", path, { ...original, nodes: original.nodes.map((node, index) => ({ ...node, pos: { x: 70 + 300 * index, y: 120 } })) });
  const [left, right] = before.nodes;
  const select = async (view: Page) => {
    await view.getByTestId(`scope-topic-${topic.title}`).click();
    await view.getByRole("button", { name: "画布", exact: true }).click();
    await view.getByRole("button", { name: "复位", exact: true }).click();
    await expect(view.getByTestId("canvas-card")).toHaveCount(2);
  };
  const second = await otherWindow(own);
  await Promise.all([select(page), select(second)]);
  const drag = async (view: Page, id: string, dx: number, dy: number) => {
    const box = await view.locator(`[data-node-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`Missing draggable card ${id}`);
    const from = { x: box.x + 50, y: box.y + 20 };
    await view.mouse.move(from.x, from.y);
    await view.mouse.down();
    await view.mouse.move(from.x + dx, from.y + dy, { steps: 5 });
    await view.mouse.up();
  };
  const gate = holdRequest(second, path, "PUT");
  await gate.installed;
  await drag(second, right!.id, 55, 40);
  const held = await gate.arrived;
  expect(held.request().postDataJSON()).toMatchObject({ version: before.version });
  const firstSave = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "PUT");
  const staleSave = second.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "PUT");
  try {
    await drag(page, left!.id, 50, 30);
    expect((await firstSave).status()).toBe(200);
  } finally { await held.continue(); }
  expect((await staleSave).status()).toBe(409);
  const expectedNodes = [{ ...left, pos: { x: 120, y: 150 } }, { ...right, pos: { x: 425, y: 160 } }];
  await expect.poll(async () => (await canvas()).nodes).toEqual(expectedNodes);
  await expect(page.locator(`[data-node-id="${right!.id}"]`)).toHaveCSS("left", "425px");
  await expect(second.locator(`[data-node-id="${left!.id}"]`)).toHaveCSS("left", "120px");
  await page.locator(`[data-node-id="${left!.id}"]`).click();
  await expect(page.getByTestId("canvas-detail").getByRole("button", { name: "收起分支", exact: true })).toBeVisible();
  await evidence(info, "canvas-concurrency", { before, saved: await canvas(), statuses: [200, 409] });
});

test("opening one branch in the 302-card fixture fetches only that branch's root-scoped summary", async ({}, info) => {
  studio = await launchStudio();
  const fixture = await seedCanvasPerformance(studio, 49);
  const { page } = studio;
  const root = fixture.saved.nodes.find((node) => node.id === "perf-root-0");
  const branch = fixture.saved.nodes.find((node) => node.id === "perf-branch-0-0");
  if (root?.kind !== "task" || branch?.kind !== "task") throw new Error("Missing performance fixture cards");
  await page.reload();
  const reads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes("/workflow/") || url.pathname.endsWith("/context")) reads.push(url.pathname + url.search);
  });
  await page.getByTestId(`scope-topic-${fixture.topic.title}`).click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(302);
  await expect.poll(() => reads.length).toBe(2);
  await page.locator(`[data-node-id="${root.id}"]`).click();
  const detail = page.getByTestId("canvas-detail");
  await detail.getByRole("button", { name: "性能分支 0-0", exact: true }).click();
  await expect(detail.getByRole("button", { name: "性能执行 0-0-0", exact: true })).toBeVisible();
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)).toBe(`/api/tasks/${root.taskId}/workflow/summary?parentTaskId=${branch.taskId}`);
  await evidence(info, "branch-requests", reads);
});
