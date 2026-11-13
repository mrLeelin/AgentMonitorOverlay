import { expect, test } from "@playwright/test";
import type { Task } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("long titles keep the conversation usable and task header height survives reload", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const title = "对于随包视频我怎么进行更新呢？如果下一版本修改了，不更新整包";
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, firstSession: { profileId: "codex-mock", text: title } });
  await page.locator(`[data-task-id="${task.id}"]`).click();
  const header = page.getByTestId("task-header");
  const divider = page.getByRole("separator", { name: "任务信息栏高度" });
  const height = async () => (await header.boundingBox())!.height;
  await expect(page.getByTestId("thread-head")).toBeVisible();
  for (const width of [1440, 1000]) {
    await app.evaluate(({ BrowserWindow }, [url, w]) => { BrowserWindow.getAllWindows().find((v) => v.webContents.getURL() === url)!.setSize(w, 900); }, [page.url(), width] as const);
    expect(await height()).toBeLessThan(200);
    expect((await page.getByTestId("thread-head").boundingBox())!.height).toBeLessThan(125);
    const box = (await divider.boundingBox())!;
    const before = await height();
    await page.mouse.move(box.x + box.width / 2, box.y + 3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 83, { steps: 8 });
    await page.mouse.up();
    expect(await height()).toBeGreaterThan(before + 60);
    await page.reload();
    await expect(header).toBeVisible();
    expect(await height()).toBeGreaterThan(before + 60);
    await divider.focus();
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowUp");
    expect(await height()).toBe(56);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await screenshot(app, "studio", `task-header-small-${width}-${theme}`, page);
    }
    await divider.dblclick();
    expect(await height()).toBeLessThan(200);
    expect(await page.evaluate(() => localStorage.getItem("amo.taskHeaderHeight"))).toBeNull();
    await screenshot(app, "studio", `task-header-default-${width}`, page);
  }
});

test("session list folds from its own header and expands from the narrow rail", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "会话列表折叠" });
  await page.locator(`[data-task-id="${task.id}"]`).click();
  const list = page.locator(".session-list");
  const thread = page.locator(".thread-col");
  await expect(list).toBeVisible();
  const width = (await thread.boundingBox())!.width;
  await page.getByTestId("sessions-collapse").click();
  await expect(list).toHaveCount(0);
  expect((await thread.boundingBox())!.width).toBeGreaterThan(width + 150);
  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByTestId("sessions-expand")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await screenshot(app, "studio", `session-list-folded-${theme}`, page);
  }
  await page.getByTestId("sessions-expand").click();
  await expect(list).toBeVisible();
  await expect(page.getByTestId("sessions-toggle")).toHaveAttribute("aria-pressed", "true");
  await screenshot(app, "studio", "session-list-expanded", page);
  await page.getByTestId("sessions-toggle").click();
  await expect(page.getByTestId("sessions-expand")).toBeVisible();
  await page.getByTestId("sessions-expand").click();
  await expect(list).toBeVisible();
});

test("progress sidebar folds locally and stays synchronized with the top toggle", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "右侧栏折叠" });
  await page.locator(`[data-task-id="${task.id}"]`).click();
  const panel = page.locator(".anno-panel");
  const thread = page.locator(".thread-col");
  await expect(panel).toBeVisible();
  const width = (await thread.boundingBox())!.width;
  await screenshot(app, "studio", "task-sidebar-expanded", page);
  await page.getByTestId("sidebar-collapse").click();
  await expect(panel).toHaveCount(0);
  expect((await thread.boundingBox())!.width).toBeGreaterThan(width + 200);
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await expect(page.getByTestId("sidebar-expand")).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await screenshot(app, "studio", `task-sidebar-folded-${theme}`, page);
  }
  await page.getByTestId("sidebar-expand").click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("sidebar-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar-expand")).toBeVisible();
  await page.getByTestId("sidebar-expand").click();
  await expect(panel).toBeVisible();
});
