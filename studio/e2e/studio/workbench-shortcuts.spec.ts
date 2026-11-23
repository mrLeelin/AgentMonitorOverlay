import { expect, test } from "@playwright/test";
import type { Session, Task } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("sidebar and bell resolve live work, and quick controls keep the board in place", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const all = page.getByRole("button", { name: "全部任务", exact: true });
  const recent = page.getByRole("button", { name: "最近会话", exact: true });
  const bell = page.getByRole("button", { name: "待处理通知", exact: true });
  const needs = page.getByRole("button", { name: "待你处理", exact: true });
  const popup = page.locator(".wb-shortcuts:popover-open");
  await bell.click();
  await expect(popup).toContainText("当前没有待处理事项");
  const bellBox = (await bell.boundingBox())!;
  expect((await popup.boundingBox())!.y).toBeGreaterThanOrEqual(bellBox.y + bellBox.height);
  await page.keyboard.press("Escape");
  await recent.click();
  await expect(popup).toContainText("还没有最近会话");
  const navBox = (await recent.boundingBox())!;
  expect((await popup.boundingBox())!.x).toBeGreaterThanOrEqual(navBox.x + navBox.width);

  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "核对导航布局", firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo check]]" },
  });
  const card = page.getByTestId("task-card").filter({ hasText: task.title });
  await expect(card).toContainText("待批准", { timeout: 30_000 });
  await expect(all).toHaveText("全部任务1");
  await expect(needs).toHaveText("待你处理1");
  await expect(popup.getByRole("button")).toHaveCount(1);
  await needs.click();
  await expect(popup).toHaveAccessibleName("待你处理");
  const waitingLabel = await popup.getByRole("button").textContent();
  await bell.click();
  await expect(popup).toHaveAccessibleName("待处理通知");
  await expect(popup.getByRole("button")).toHaveText(waitingLabel!);
  await popup.getByRole("button").click();
  await expect(card).toBeFocused();
  await expect(popup).toHaveCount(0);

  const grouped = page.getByTestId("board-group-topics");
  await grouped.uncheck();
  await expect(page.getByTestId("topic-group")).toHaveCount(0);
  await grouped.focus();
  await page.keyboard.press("Space");
  await expect(grouped).toBeChecked();

  const theme = page.getByRole("button", { name: "深色模式", exact: true });
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await screenshot(app, "studio", "workbench-shortcuts-dark", page);
  await page.reload();
  await expect(theme).toHaveAttribute("aria-pressed", "true");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await screenshot(app, "studio", "workbench-shortcuts-light", page);
  await app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === url)!.setSize(960, 600); }, page.url());
  await bell.click();
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("search-input")).toBeFocused();
  await expect(popup).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "+ 新任务" }).click();
  await recent.click();
  await popup.getByRole("button").click();
  await expect(page.getByTestId("task-title")).toHaveText(task.title);
  await expect(page.getByTestId("session-row").filter({ hasText: session.title })).toHaveAttribute("aria-current", "true");
});
