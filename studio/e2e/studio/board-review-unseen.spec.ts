import { expect, test } from "@playwright/test";
import type { Task } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("review cards remember visits per round, survive reload and keep edits from rearming the hint", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const add = async (title: string, column = "review") => (await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, column })).task;
  const unread = await add("完善这个 Prefab 和脚本文件");
  const other = await add("接入中的打开描述界面");
  const seen = await add("已打开查看的任务");
  const doing = await add("仍在进行中的任务", "doing");
  const card = (task: Task) => page.locator(`[data-testid="task-card"][data-task-id="${task.id}"]`);
  const hint = (task: Task) => card(task).getByTestId("card-review-unseen");
  const back = async () => { await page.getByRole("button", { name: "全部任务", exact: true }).click(); };
  await expect(hint(unread)).toHaveText("未查看");
  await expect(hint(doing)).toHaveCount(0);
  await card(unread).click({ modifiers: ["Control"] });
  await expect(hint(unread)).toBeVisible();
  await card(seen).click();
  await back();
  await expect(hint(seen)).toHaveCount(0);
  await expect(hint(other)).toBeVisible();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(studio.app, "studio", "board-review-unseen-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(studio.app, "studio", "board-review-unseen-light", page);
  await page.reload();
  await expect(hint(seen)).toHaveCount(0);
  await expect(hint(unread)).toBeVisible();
  await studio.api("PATCH", `/api/tasks/${seen.id}`, { title: "改标题仍保持已查看" });
  await expect(card(seen)).toContainText("改标题仍保持已查看");
  await expect(hint(seen)).toHaveCount(0);
  await studio.api("PATCH", `/api/tasks/${seen.id}`, { column: "doing" });
  await expect(page.getByTestId("column-doing").locator(`[data-task-id="${seen.id}"]`)).toBeVisible();
  await studio.api("PATCH", `/api/tasks/${seen.id}`, { column: "review" });
  await expect(hint(seen)).toBeVisible();
  await card(seen).click();
  // A round finishing with this task already visible counts as viewed.
  await studio.api("PATCH", `/api/tasks/${seen.id}`, { column: "doing" });
  await expect(page.getByTestId("task-status")).toHaveAttribute("aria-label", "状态：进行中");
  await studio.api("PATCH", `/api/tasks/${seen.id}`, { column: "review" });
  await expect(page.getByTestId("task-status")).toHaveAttribute("aria-label", "状态：待审阅");
  await back();
  await expect(hint(seen)).toHaveCount(0);
});
