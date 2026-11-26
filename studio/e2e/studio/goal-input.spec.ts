import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionGoalState, SessionGoalUpdate, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function openGoal() {
  studio = await launchStudio({ dsh: true, taskSidebar: false });
  const { page } = studio;
  const dir = studio.workspace("goal-input");
  writeFileSync(join(dir, "goal-check.md"), "Goal 输入验证\n");
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { task: target } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "目标引用任务", workspaceId: ws.id });
  const { session } = await studio.api<{ session: Session }>("POST", "/api/tasks", { title: "Goal 输入", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "hello" } });
  // Exercise the real Electron UI and Host reference APIs without starting an autonomous model loop.
  const state: SessionGoalState = { goal: null, capabilities: { tokenBudget: false, roundBudget: true, pause: true, tokens: false, elapsed: false } };
  const sent: SessionGoalUpdate[] = [];
  await page.route(`**/api/sessions/${session.id}/goal`, async (route) => {
    if (route.request().method() === "PUT") {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: 500, json: { error: { code: "runtime_error", message: "Goal 写入失败，请重试" } } });
    } else await route.fulfill({ json: state });
  });
  await page.getByTestId("task-card").filter({ hasText: "Goal 输入" }).click();
  await expect(page.getByTestId("msg-agent").first()).toBeVisible();
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByTestId("switch-goal").click();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  return { page, app: studio.app, input: page.getByTestId("goal-objective-input"), sent, target, ws, dir };
}

test("Goal / 与 $ 菜单只补全目标，技能高亮、撤销与 Esc 保留面板", async () => {
  const { page, app, input, sent, dir } = await openGoal();
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, "# Goal 检查技能\n");
  await page.route("**/api/sessions/*/commands", (route) => route.fulfill({ json: { commands: [
    { name: "compact", description: "压缩上下文", group: "studio" },
    { name: "goal-check", description: "检查目标完成标准", group: "skill", skillPath },
  ] } }));
  let commandRuns = 0;
  page.on("request", (request) => { if (request.method() === "POST" && /\/commands(?:\?|$)/.test(request.url())) commandRuns++; });
  await input.fill("/comp");
  const menu = page.getByTestId("goal-tray").getByTestId("slash-menu");
  await expect(menu.getByRole("option")).toContainText("/compact");
  await input.press("Enter");
  await expect(input).toHaveText("/compact ");
  expect(sent).toHaveLength(0);
  expect(commandRuns).toBe(0);
  await input.fill("/goal");
  await expect(menu.getByRole("option")).toContainText("/goal-check");
  await input.press("Tab");
  await expect(input.getByRole("link", { name: "打开技能 goal-check" })).toBeVisible();
  // Completion restores the caret on the next frame; finish it before replacing the entire test draft.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await input.fill("请使用 $goal 检查完成标准");
  await expect(input).toHaveText("请使用 $goal 检查完成标准");
  await input.press("Home");
  for (let i = 0; i < 9; i++) await input.press("ArrowRight");
  await input.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
  await expect(menu.getByRole("option")).toContainText("$goal-check");
  await input.press("Enter");
  await expect(input).toHaveText("请使用 $goal-check 检查完成标准");
  await input.press("Control+z");
  await expect(input).toHaveText("请使用 $goal 检查完成标准");
  await input.press("Control+y");
  await expect(input.getByRole("link", { name: "打开技能 goal-check" })).toBeVisible();
  await input.fill("$");
  await expect(menu).toBeVisible();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(app, "studio", `goal-input-skills-${theme}`, page);
  }
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.setSize(1000, 900); });
  await expect(page.getByTestId("goal-tray")).toBeVisible();
  expect(await page.locator(".goal-tray").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await screenshot(app, "studio", "goal-input-skills-narrow", page);
  await input.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("goal-tray")).toBeVisible();
  expect(sent).toHaveLength(0);
});

test("Goal / 模板、@ 引用与找文件弹窗可用，失败重试保留真实引用", async () => {
  const { page, app, input, sent, target, ws, dir } = await openGoal();
  await studio!.api("POST", "/api/prompt-templates", { title: "Goal 检查模板", body: "检查实现并提供完成证据。", workspaceId: ws.id });
  await input.fill("/提示词模板");
  await page.getByTestId("goal-tray").getByTestId("slash-menu").getByRole("option", { name: /提示词模板/ }).click();
  const dialog = page.getByTestId("prompt-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("prompt-item").filter({ hasText: "Goal 检查模板" }).click();
  await dialog.getByRole("button", { name: "粘进输入框", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveText("检查实现并提供完成证据。");
  await input.press("End");
  await input.pressSequentially(" @目标引用");
  await page.getByTestId("goal-tray").getByRole("option", { name: "目标引用任务", exact: true }).click();
  await expect(input).toContainText("@目标引用任务");
  await input.press("End");
  await input.pressSequentially(" @goal-check");
  await page.getByTestId("goal-tray").locator('[data-kind="file"]').click();
  await expect(input.locator(".resource-atom")).toContainText("goal-check.md");
  await input.press("End");
  await input.pressSequentially(" @");
  await page.getByTestId("goal-tray").getByRole("option", { name: /找文件/ }).click();
  await expect(page.getByTestId("file-picker")).toBeVisible();
  await page.getByRole("textbox", { name: "找文件", exact: true }).fill("goal-check");
  await page.getByRole("textbox", { name: "找文件", exact: true }).press("Escape");
  await expect(page.getByTestId("file-picker")).toHaveCount(0);
  await expect(page.getByTestId("goal-tray")).toBeVisible();
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("switch-goal").click();
  await expect(input).toContainText("@目标引用任务");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(app, "studio", `goal-input-refs-${theme}`, page);
  }
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-error")).toContainText("Goal 写入失败");
  await expect(input).toContainText("@目标引用任务");
  await page.getByTestId("goal-start").click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]!.objective).toContain(`AMO 任务 ${target.id}`);
  expect(sent[0]!.objective).toContain(join(dir, "goal-check.md"));
  expect(sent[0]!.objective).not.toContain("[[amo:");
});
