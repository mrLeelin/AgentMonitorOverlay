import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { startMockAnthropic, type ClaudeMockServer } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
let claude: ClaudeMockServer | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; await claude?.close(); claude = undefined; });

test("Claude uses the approved runner on board, canvas and references while other models keep the original", async () => {
  claude = await startMockAnthropic({ script: (req) => req.tools.length ? { kind: "text", text: "running ".repeat(200), chunks: 200, delayMs: 200 } : { kind: "text", text: "runner" } });
  studio = await launchStudio({ dsh: true, env: { AMO_STUDIO_TEST_CLAUDE_URL: claude.baseUrl } });
  const { page, app } = studio;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("claude-runner") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "人物动画验证" });
  const create = (title: string, profileId: string, external = false) => studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title, workspaceId: ws.id, topicId: external ? undefined : topic.id, firstSession: { profileId, text: "[[slow]]" },
  });
  const orange = await create("Claude 橙发人物", "claude-mock");
  const original = await create("DeepSeek 原版人物", "dsh-mock");
  const referenced = await create("Claude 引用人物", "claude-mock", true);
  for (const item of [orange, original]) await studio.api("PUT", `/api/tasks/${item.task.id}/canvas`, { onCanvas: true });
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...doc, nodes: [...doc.nodes.map((node, i) => ({ ...node, pos: { x: 40 + i * 280, y: 40 } })), { id: "claude-runner-ref", kind: "ref", taskId: referenced.task.id, pos: { x: 40, y: 200 }, groupId: null }],
  });
  const orangeBoard = page.getByTestId("task-card").filter({ hasText: orange.task.title }).locator(".card-runner");
  const oldBoard = page.getByTestId("task-card").filter({ hasText: original.task.title }).locator(".card-runner");
  await expect(orangeBoard).toHaveAttribute("data-skin", "claude");
  await expect(oldBoard).toHaveAttribute("data-skin", "default");
  const orangeImage = await orangeBoard.evaluate((el) => getComputedStyle(el).backgroundImage);
  const oldImage = await oldBoard.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(orangeImage).not.toBe(oldImage);
  expect(await orangeBoard.evaluate(async (el) => { const img = new Image(); img.src = getComputedStyle(el).backgroundImage.slice(5, -2); await img.decode(); return [img.naturalWidth, img.naturalHeight]; })).toEqual([768, 96]);
  await screenshot(app, "studio", "claude-runner-board", page);

  await page.getByRole("button", { name: "画布", exact: true }).click();
  const orangeCanvas = page.getByTestId("canvas-card").filter({ hasText: orange.task.title }).locator(".card-runner");
  const oldCanvas = page.getByTestId("canvas-card").filter({ hasText: original.task.title }).locator(".card-runner");
  const ref = page.getByTestId("canvas-ref").locator(".card-runner");
  await expect(orangeCanvas).toHaveAttribute("data-skin", "claude");
  await expect(oldCanvas).toHaveAttribute("data-skin", "default");
  await expect(ref).toHaveAttribute("data-skin", "claude");
  expect(await ref.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe(orangeImage);
  expect(await oldCanvas.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe(oldImage);
  const poses: string[] = [];
  for (const time of [0, 400]) {
    poses.push(await orangeCanvas.evaluate((el, ms) => { for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = ms; } return getComputedStyle(el).backgroundPositionX; }, time));
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", `claude-runner-canvas-dark-${time}`, page);
  }
  expect(poses[0]).not.toBe(poses[1]);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "claude-runner-canvas-light", page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => orangeCanvas.evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect(orangeCanvas).toBeVisible();
  await studio.api("POST", `/api/sessions/${orange.session.id}/interrupt`, {});
  await expect(orangeCanvas).toHaveCount(0);
  await expect(ref).toBeVisible();
  await studio.api("POST", `/api/sessions/${referenced.session.id}/interrupt`, {});
  await expect(ref).toHaveCount(0);
  await studio.api("POST", `/api/sessions/${original.session.id}/interrupt`, {});
  await expect(oldCanvas).toHaveCount(0);
});
