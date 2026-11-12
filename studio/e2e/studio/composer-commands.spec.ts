import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlashCommand, StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const commands: SlashCommand[] = [
  { name: "compact", description: "压缩上下文", group: "studio" },
  { name: "context", description: "查看上下文", group: "runtime" },
  { name: "release-notes", description: "根据改动写发布说明", group: "skill" },
  { name: "code-review", description: "检查代码问题", group: "skill" },
];

for (const trigger of ["/", "$"] as const) {
  test(`composer ${trigger} opens commands and skills while typing`, async () => {
    studio = await launchStudio({ dsh: true });
    const { page, app } = studio;
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("commands") });
    await studio.api("POST", "/api/tasks", { title: "输入命令与技能", workspaceId: ws.id, firstSession: { profileId: "dsh-mock", text: "hello" } });
    await page.getByTestId("task-card").filter({ hasText: "输入命令与技能" }).click();
    await expect(page.getByTestId("msg-agent").first()).toBeVisible();
    await page.route("**/api/sessions/*/commands", (route) => route.fulfill({ json: { commands } }));
    const composer = page.getByLabel("输入消息");
    await composer.pressSequentially(trigger);
    const menu = page.getByTestId("slash-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-group="skill"]')).toHaveCount(2);
    await expect(menu.locator('[data-group="studio"]')).toHaveCount(trigger === "/" ? 1 : 0);
    await expect(menu.getByRole("option", { name: new RegExp(`\\${trigger}release-notes`) })).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", `composer-${trigger === "/" ? "slash" : "skills"}-dark`, page);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await screenshot(app, "studio", `composer-${trigger === "/" ? "slash" : "skills"}-light`, page);
    await composer.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(composer).toHaveText(trigger);
    if (trigger === "$") {
      const userCount = await page.getByTestId("msg-user").count();
      await composer.fill("请用 $rel 检查改动");
      await composer.press("Home");
      for (let i = 0; i < 7; i++) await composer.press("ArrowRight");
      await expect(menu.getByRole("option")).toHaveCount(1);
      await composer.press("Enter");
      await expect(composer).toHaveText("请用 $release-notes 检查改动");
      await expect(menu).toHaveCount(0);
      await composer.pressSequentially("先");
      await expect(composer).toHaveText("请用 $release-notes 先检查改动");
      await expect(page.getByTestId("msg-user")).toHaveCount(userCount);
      await composer.fill("$code");
      await menu.getByRole("option").click();
      await expect(composer).toHaveText("$code-review ");
      await expect(menu).toHaveCount(0);
      await composer.fill("$rel 和 $code");
      await composer.press("Home");
      for (let i = 0; i < 4; i++) await composer.press("ArrowRight");
      await expect(menu).toBeVisible();
      await composer.press("Escape");
      await expect(menu).toHaveCount(0);
      await composer.press("End");
      await expect(menu.getByRole("option")).toContainText("$code-review");
    } else {
      await composer.fill("  /con");
      await expect(menu.getByRole("option")).toHaveCount(1);
      await composer.press("Tab");
      await expect(composer).toHaveText("  /context ");
      await expect(menu).toHaveCount(0);
    }
  });
}

test("new-task / and $ menus follow the selected project and model without creating sessions", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  const requests: Array<{ profileId: string; workspaceId: string | null }> = [];
  await page.route("**/api/commands", async (route) => {
    const body = route.request().postDataJSON() as { profileId: string; workspaceId: string | null };
    requests.push(body);
    await route.fulfill({ json: { commands: body.workspaceId === beta.id ? [{ name: "beta-skill", description: "beta 项目技能", group: "skill" }] : commands } });
  });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha", exact: true }).click();
  await page.getByRole("group", { name: "模型", exact: true }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  const composer = page.getByLabel("第一句话");
  await composer.pressSequentially("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.locator('[data-group="skill"]')).toHaveCount(2);
  expect(requests.at(-1)).toEqual({ profileId: "codex-mock", workspaceId: alpha.id });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "newtask-slash-dark", page);
  await composer.fill("$rel");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveText("$release-notes ");
  await expect(page.getByLabel("第一句话")).toBeVisible();
  await composer.fill("$");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "newtask-skills-light", page);
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "beta", exact: true }).click();
  await expect(menu.getByRole("option")).toContainText("$beta-skill");
  expect(requests.at(-1)).toEqual({ profileId: "codex-mock", workspaceId: beta.id });
  await page.getByRole("group", { name: "模型", exact: true }).getByTestId("model-tile").filter({ hasText: "Mock Claude" }).click();
  await expect.poll(() => requests.at(-1)?.profileId).toBe("claude-mock");
  await expect(menu.getByRole("option")).toContainText("$beta-skill");
  await composer.press("Tab");
  await expect(composer).toHaveText("$beta-skill ");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks).toHaveLength(0);
  expect(state.sessions).toHaveLength(0);
});

test("new-task discovers a real Codex project skill and sends it in the first message", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dir = studio.workspace("skill-project");
  const folder = join(dir, ".agents", "skills", "release-notes");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "---\nname: release-notes\ndescription: 根据改动写发布说明\n---\n\n写发布说明。\n");
  await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "skill-project", exact: true }).click();
  await page.getByRole("group", { name: "模型", exact: true }).getByTestId("model-tile").filter({ hasText: "Mock 模型" }).click();
  const composer = page.getByLabel("第一句话");
  await composer.fill("/release");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option", { name: /\/release-notes/ })).toBeVisible({ timeout: 30_000 });
  await composer.fill("$release");
  await expect(menu.getByRole("option", { name: /\$release-notes/ })).toBeVisible();
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).sessions).toHaveLength(0);
  await composer.press("Enter");
  await expect(composer).toHaveText("$release-notes ");
  const skill = composer.getByRole("link", { name: "打开技能 release-notes" });
  await expect(skill).toHaveText("$release-notes");
  const style = await skill.evaluate((el) => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, parent: getComputedStyle(el.parentElement!).color }));
  expect(style.color).not.toBe(style.parent);
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  const windowOpened = app.waitForEvent("window");
  await skill.click();
  const viewer = await windowOpened;
  await expect(viewer.getByTestId("viewer-name")).toHaveText("SKILL.md");
  await expect(viewer.locator(".fp-md")).toContainText("写发布说明");
  await expect(composer).toHaveText("$release-notes ");
  await page.reload();
  await expect(skill).toBeVisible({ timeout: 30_000 });
  await composer.press("End");
  await composer.press("Backspace");
  await composer.press("Backspace");
  await expect(skill).toHaveCount(0);
  await composer.press("Control+z");
  await expect(skill).toBeVisible();
  await composer.fill("$release-notes ");
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await screenshot(app, "studio", `skill-reference-draft-${theme}`, page);
  }
  await composer.pressSequentially("请总结本次改动");
  await page.getByTestId("draft-start").click();
  await expect(page.getByTestId("msg-user").first()).toContainText("$release-notes 请总结本次改动");
  await expect(page.getByTestId("msg-agent").first()).toContainText("MOCK:", { timeout: 30_000 });
  const chat = page.getByLabel("输入消息");
  await chat.fill("请使用 $release-notes 检查本次改动");
  const chatSkill = chat.getByRole("link", { name: "打开技能 release-notes" });
  await expect(chatSkill).toBeVisible({ timeout: 30_000 });
  await chatSkill.click();
  await expect(viewer.getByTestId("viewer-name")).toHaveText("SKILL.md");
  await expect(chat).toHaveText("请使用 $release-notes 检查本次改动");
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await screenshot(app, "studio", `skill-reference-chat-${theme}`, page);
  }
});
