import { expect, test } from "@playwright/test";
import type { CanvasDoc, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("canvas task and reference cards share the board runner and remove it when stopped", async () => {
  studio = await launchStudio({ dsh: true });
  const { page, app } = studio;
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("canvas-runner") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "画布运行状态" });
  const create = (title: string, lead = false, external = false) => studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title, lead, workspaceId: ws.id, topicId: external ? undefined : topic.id, firstSession: { profileId: "dsh-mock", text: "[[slow]]" },
  });
  const lead = await create("游戏开发主控", true);
  const worker = await create("校验掉落表");
  const referenced = await create("引用的音效任务", false, true);
  for (const item of [lead, worker]) await studio.api("PUT", `/api/tasks/${item.task.id}/canvas`, { onCanvas: true });
  const doc = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  await studio.api("PUT", `/api/topics/${topic.id}/canvas`, {
    ...doc,
    nodes: [
      ...doc.nodes.map((node, i) => ({ ...node, pos: { x: 40 + i * 280, y: 40 } })),
      { id: "runner-ref", kind: "ref", taskId: referenced.task.id, pos: { x: 40, y: 220 }, groupId: null },
    ],
  });
  await page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  const ref = page.getByTestId("canvas-ref");
  await expect(cards).toHaveCount(2);
  await expect(ref.locator(".card-runner")).toBeVisible();
  await expect(cards.locator(".card-runner")).toHaveCount(2);
  const runner = cards.filter({ hasText: worker.task.title }).locator(".card-runner");
  await expect(runner).toHaveAttribute("aria-hidden", "true");
  await expect.poll(() => runner.evaluate((el) => el.getAnimations().length)).toBe(1);
  const poses: string[] = [];
  for (const time of [0, 400]) {
    poses.push(await runner.evaluate((el, ms) => {
      for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = ms; }
      return getComputedStyle(el).backgroundPositionX;
    }, time));
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", `canvas-runner-dark-${time}`, page);
  }
  expect(poses[0]).not.toBe(poses[1]);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "canvas-runner-light", page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => runner.evaluate((el) => el.getAnimations().length)).toBe(0);
  await expect(runner).toBeVisible();
  await studio.api("POST", `/api/sessions/${worker.session.id}/interrupt`, {});
  await expect(runner).toHaveCount(0);
  await expect(ref.locator(".card-runner")).toBeVisible();
  await studio.api("POST", `/api/sessions/${referenced.session.id}/interrupt`, {});
  await expect(ref.locator(".card-runner")).toHaveCount(0);
  await expect(cards.filter({ hasText: lead.task.title }).locator(".card-runner")).toBeVisible();
  await studio.api("POST", `/api/sessions/${lead.session.id}/interrupt`, {});
  await expect(cards.locator(".card-runner")).toHaveCount(0);
});
