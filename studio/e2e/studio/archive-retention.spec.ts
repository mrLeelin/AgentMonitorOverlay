import { expect, test } from "@playwright/test";
import type { Task, Workspace } from "@amo-studio/protocol";
import { selectSettingsPage } from "../support/settings.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("归档任务自动删除默认为七天，所有保留选项均可保存并在重开设置后保留", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "归档任务自动清理示例", workspaceId: workspace.id });
  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "数据管理");
  const retention = settings.getByRole("combobox", { name: "归档任务自动删除", exact: true });
  await expect(retention).toBeEnabled();
  await expect(retention).toHaveValue("7");
  await expect(retention.locator("option")).toHaveText(["1 天后自动删除", "3 天后自动删除", "5 天后自动删除", "7 天后自动删除", "不自动删除"]);
  for (const value of ["1", "3", "5", "7", "never"]) {
    await retention.selectOption(value);
    await expect(settings.getByTestId("data-message")).toHaveText(value === "never" ? "已关闭归档任务自动删除" : `已设置归档任务 ${value} 天后自动删除`);
    await expect(retention).toBeEnabled();
    expect(await studio.api("GET", "/api/data/retention")).toEqual({ taskRetentionDays: value === "never" ? null : Number(value) });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(retention).toBeEnabled();
    await expect(retention).toHaveValue(value);
  }
  await retention.selectOption("7");
  await expect(retention).toBeEnabled();
  await expect(retention).toHaveValue("7");
  await expect(settings.getByTestId("data-row")).toContainText("归档任务自动清理示例");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "archive-retention-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "archive-retention-light", page);
  await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
  await page.evaluate(() => { localStorage.setItem("amo.settings.size", JSON.stringify({ w: 640, h: 460 })); });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(retention).toBeVisible();
  await expect(retention).toBeEnabled();
  await screenshot(app, "studio", "archive-retention-small", page);
});
