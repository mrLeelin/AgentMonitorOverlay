import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { CanvasDoc, ModelChannel, Session, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { MOCK_MODEL_CATALOG } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("task cards and canvas show the task's primary main model", async () => {
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

  await studio.api("PATCH", `/api/sessions/${claude.session.id}/options`, { model: "mock-claude-b" });
  await expect(boardCard(claude.task.id).locator(".task-model-name")).toHaveText("mock-claude-b");
  const extra = await studio.api<Session>("POST", `/api/tasks/${claude.task.id}/sessions`, { profileId: "codex-mock" });
  await expect(boardCard(claude.task.id).locator(".task-model-more")).toHaveCount(0);
  await expect(boardCard(claude.task.id).locator(".task-model-name")).toHaveText("mock-claude-b");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-models-board-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "task-models-board-light", page);

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
  await expect(canvasCard(claude.task.title).locator(".task-model-more")).toHaveCount(0);
  await expect(canvasCard(claude.task.title).locator(".task-model-name")).toHaveText("mock-claude-b");
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
  await expect(canvasCard(claude.task.title).locator(".task-model-name")).toHaveText("Mock Model");
});

test("the same task shows its channel icon on the board, canvas and session composer", async () => {
  studio = await launchStudio();
  const { page, app, mock } = studio;
  const config = join(studio.root, "codex-home", "config.toml");
  writeFileSync(config, `model_catalog_json = ${JSON.stringify(MOCK_MODEL_CATALOG)}\n${readFileSync(config, "utf8")}`);
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("task-channel-icon") });
  await studio.api<Topic>("POST", "/api/topics", { title: "渠道图标" });
  const channel = await studio.api<ModelChannel>("POST", "/api/channels", { kind: "codex", label: "Dxx Codex", baseUrl: mock!.baseUrl, model: "mock-model", key: "mock-channel-key" });
  const icon = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#32695d";
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText("DX", 4, 21);
    return canvas.toDataURL();
  });
  await studio.api("PUT", `/api/profiles/${channel.id}/icon`, { icon });
  await page.getByTestId("scope-topic-渠道图标").click();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const title = "核对同一个任务的模型图标";
  const draftPicker = page.getByTestId("all-models");
  await draftPicker.click();
  await page.getByTestId("model-drawer").getByRole("group", { name: channel.label, exact: true })
    .getByRole("button", { name: "Mock Model", exact: true }).click();
  await expect(draftPicker).toContainText("Mock Model");
  await expect(draftPicker.locator("img")).toHaveAttribute("src", icon);
  await page.getByLabel("第一句话").fill(title);
  await screenshot(app, "studio", "task-channel-icon-draft", page);
  await page.getByRole("button", { name: "开始", exact: true }).click();
  const picker = page.getByTestId("switch-model");
  await expect(picker).toContainText("Mock Model", { timeout: 30_000 });
  await expect(picker.locator("img")).toHaveAttribute("src", icon);
  await screenshot(app, "studio", "task-channel-icon-session", page);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const task = state.tasks.find((item) => item.title === title)!;
  expect(state.sessions.find((session) => session.taskId === task.id)?.profileId).toBe(channel.id);
  await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });

  await page.getByTestId("back").click();
  const card = page.locator(`[data-testid="task-card"][data-task-id="${task.id}"]`);
  const badge = card.getByTestId("task-models");
  await expect(badge.locator(".task-model-name")).toHaveText("Mock Model");
  await expect(badge.locator("img")).toHaveAttribute("src", icon, { timeout: 3000 });
  await screenshot(app, "studio", "task-channel-icon-board", page);

  const canvasTab = page.getByRole("button", { name: "画布", exact: true });
  await canvasTab.click();
  const canvasBadge = page.getByTestId("canvas-card").filter({ hasText: task.title }).getByTestId("task-models");
  await expect(canvasBadge.locator(".task-model-name")).toHaveText("Mock Model");
  await expect(canvasBadge.locator("img")).toHaveAttribute("src", icon);
  await screenshot(app, "studio", "task-channel-icon-canvas", page);
  await studio.api("PUT", `/api/profiles/${channel.id}/icon`, { icon: null });
  await expect(canvasBadge.locator(".mark")).toHaveText("G");
  await expect(canvasBadge.locator("img")).toHaveCount(0);
});
