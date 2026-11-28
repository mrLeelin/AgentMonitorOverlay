import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("task instructions stay in the sidebar while reading, editing, folding, and switching sessions", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const folder = studio.workspace("demo");
  const file = join(folder, "README.md");
  writeFileSync(file, "# 验收记录\n");
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: folder });
  const description = [
    "负责任务入口和右侧面板。保存后核对会话草稿和说明全文。",
    "核对任务页入口：packages/ui/src/task/TaskPage.tsx",
    "核对长字符串折行：" + "task-description-".repeat(5) + "sidebar",
    ...Array.from({ length: 18 }, (_, i) => `第 ${i + 1} 项验收要求：核对当前任务的执行范围和提交入口。`),
    "说明末尾：记录验证结果。",
  ].join("\n\n");
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", {
    title: "任务说明布局",
    description,
    workspaceId: workspace.id,
    firstSession: { profileId: "codex-mock", text: `会话甲\n\n引用文件：\n- ${file}` },
  });
  await studio.api("POST", `/api/tasks/${task.id}/sessions`, { profileId: "codex-mock", text: "会话乙" });
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  const sidebar = page.getByRole("complementary", { name: "任务侧栏" });
  const tab = sidebar.getByRole("button", { name: "任务说明", exact: true });
  const panel = sidebar.getByRole("region", { name: "任务说明" });
  const input = page.getByLabel("输入消息");
  const body = page.locator(".task-body");

  await expect(page.getByTestId("task-description")).toBeHidden();
  await expect(page.getByTestId("sidebar-environment")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("session-row").filter({ hasText: "会话甲" }).click();
  await input.fill("留在会话里的草稿");
  const bodyTop = (await body.boundingBox())?.y;
  await tab.press("Enter");
  await expect(tab).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("task-description")).toHaveText(description);
  await expect(input).toHaveText("留在会话里的草稿");
  expect((await body.boundingBox())?.y).toBe(bodyTop);
  expect((await sidebar.boundingBox())?.width).toBe(300);

  const edit = panel.getByRole("button", { name: "编辑", exact: true });
  const scroll = panel.locator(".task-sidebar-body");
  expect(await scroll.evaluate((node) => node.scrollHeight > node.clientHeight && node.scrollWidth <= node.clientWidth)).toBe(true);
  await scroll.press("End");
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await expect(edit).toBeInViewport();
  await scroll.press("Home");
  await scroll.blur();

  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "task-description-sidebar-dark", page);
  await page.getByTestId("msg-user").getByTestId("msg-file").click({ button: "right" });
  await expect(page.getByTestId("file-menu").getByRole("menuitem", { name: /在侧栏预览/ })).toBeVisible();
  await page.keyboard.press("p");
  const preview = page.getByTestId("file-preview");
  await expect(preview).toBeVisible();
  await expect(panel).toBeHidden();
  await preview.getByRole("button", { name: "关闭预览" }).click();
  await expect(tab).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("task-description")).toBeVisible();

  await page.getByTestId("session-row").filter({ hasText: "会话乙" }).click();
  await expect(panel.getByTestId("task-description")).toHaveText(description);
  await app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === url)!.setSize(1000, 760); }, page.url());
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await expect(tab).toBeInViewport();
  expect(await scroll.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await screenshot(app, "studio", "task-description-sidebar-light-narrow", page);

  await page.getByTestId("sidebar-collapse").click();
  await expect(panel).toBeHidden();
  await page.getByTestId("sidebar-expand").click();
  await expect(tab).toHaveAttribute("aria-pressed", "true");
  await edit.click();
  const dialog = page.getByRole("dialog", { name: "任务说明" });
  await expect(dialog.getByLabel("说明内容")).toHaveValue(description);
  await dialog.getByLabel("说明内容").fill("编辑后的任务说明");
  await dialog.getByTestId("description-save").click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByTestId("task-description")).toHaveText("编辑后的任务说明");

  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await expect(page.getByTestId("task-archived-banner")).toBeVisible();
  await expect(panel.getByTestId("task-description")).toHaveText("编辑后的任务说明");
  await expect(edit).toHaveCount(0);
});
