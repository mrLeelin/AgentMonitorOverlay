import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SkillCatalog, Workspace } from "@amo-studio/protocol";
import { selectSettingsPage } from "../support/settings.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

function writeSkill(root: string, name: string, description: string, valid = true): string {
  const path = join(root, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, valid ? `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\n技能说明正文，用于真实文件查看验收。\n` : "# 缺少元数据的技能\n", "utf8");
  return path;
}

async function openSkills(current: Studio) {
  await current.page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = current.page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(dialog, "技能展览");
  return dialog.getByTestId("skills-page");
}

test("skills exhibition reads real files, filters sources and changes projects", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const common = join(studio.dataDir, "test-skill-home", ".agents", "skills");
  writeSkill(common, "release-check", "发布前检查改动、构建结果与发布说明。");
  writeSkill(common, "frontend-design", "Create polished frontend interfaces with clear hierarchy and precise typography.");
  writeSkill(common, "broken-skill", "", false);
  writeSkill(join(studio.root, "codex-home", "skills"), "code-review", "审查代码改动，定位影响功能的缺陷。");
  const alphaPath = studio.workspace("alpha");
  const betaPath = studio.workspace("beta");
  writeSkill(join(alphaPath, ".claude", "skills"), "alpha-build", "alpha 项目构建流程");
  writeSkill(join(betaPath, ".agents", "skills"), "beta-build", "beta 项目构建流程");
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: alphaPath });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: betaPath });
  const panel = await openSkills(studio);
  await expect(panel.getByLabel("技能统计")).toContainText("4 技能条目");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "skills-overview", page);
  const agents = panel.locator('[data-source="agents"]');
  await agents.locator(".skills-source-toggle").click();
  await expect(panel.getByTestId("skill-item")).toHaveCount(3);
  const opened = page.waitForResponse((response) => response.url().endsWith("/api/open-in") && response.request().method() === "POST");
  await agents.getByRole("button", { name: "打开 公共 Agent 技能目录", exact: true }).click();
  expect(await (await opened).json()).toMatchObject({ path: common, app: "explorer", dryRun: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "skills-global-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "skills-global-light", page);
  await panel.getByLabel("搜索技能").fill("发布");
  await expect(panel.getByTestId("skill-item")).toHaveCount(1);
  await expect(panel.getByTestId("skill-item")).toContainText("release-check");
  await panel.getByRole("button", { name: "清除筛选" }).click();
  await panel.getByLabel("技能状态").selectOption("diagnostic");
  await expect(panel.getByTestId("skill-item")).toHaveCount(1);
  await panel.getByRole("button", { name: "broken-skill", exact: true }).click();
  await expect(panel.getByTestId("skill-item")).toContainText("缺少有效的 YAML");
  await panel.getByRole("button", { name: "清除筛选" }).click();
  await panel.getByLabel("技能来源").selectOption("codex");
  await panel.locator('[data-source="codex"] .skills-source-toggle').click();
  await expect(panel.getByTestId("skill-item")).toHaveCount(1);
  const viewerPromise = app.waitForEvent("window");
  await panel.getByRole("button", { name: "查看 code-review 说明" }).click();
  const viewer = await viewerPromise;
  await expect(viewer.getByText("技能说明正文，用于真实文件查看验收。")).toBeVisible();
  await viewer.close();
  writeSkill(join(studio.root, "codex-home", "skills"), "new-skill", "新增的技能");
  await panel.getByRole("button", { name: "刷新技能" }).click();
  await expect(panel.getByLabel("技能统计")).toContainText("5 技能条目");
  await panel.getByRole("tab", { name: "项目技能", exact: true }).click();
  await panel.getByLabel("技能项目").selectOption(alpha.id);
  await panel.getByLabel("搜索技能").fill("alpha");
  await expect(panel.getByTestId("skill-item")).toHaveCount(1);
  await expect(panel.getByTestId("skill-item")).toContainText("alpha-build");
  await screenshot(app, "studio", "skills-project", page);
  await panel.getByLabel("搜索技能").fill("");
  await panel.getByLabel("技能项目").selectOption(beta.id);
  await panel.getByLabel("搜索技能").fill("beta");
  await expect(panel.getByTestId("skill-item")).toHaveCount(1);
  await expect(panel.getByTestId("skill-item")).toContainText("beta-build");
  await expect(panel).not.toContainText("alpha-build");
  await panel.getByLabel("搜索技能").fill("missing-xyz");
  await expect(panel).toContainText("没有匹配的技能");
  await page.getByRole("button", { name: "关闭设置" }).click();
  await page.evaluate(() => { localStorage.setItem("amo.settings.size", JSON.stringify({ w: 640, h: 460 })); });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(panel.getByLabel("技能统计")).toContainText("5 技能条目");
  await screenshot(app, "studio", "skills-small", page);
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("skills exhibition handles an older Host and retries without restarting it", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await page.route("**/api/skills*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: "No route" } }) }));
  const panel = await openSkills(studio);
  await expect(panel.getByRole("alert")).toContainText("手动重启源码版 Studio");
  await page.unroute("**/api/skills*");
  await panel.getByRole("button", { name: "重试", exact: true }).click();
  await expect(panel.getByLabel("技能统计")).toContainText("0 技能条目");
  await panel.getByRole("tab", { name: "项目技能", exact: true }).click();
  await expect(panel).toContainText("先在 Studio 添加项目");
  await expect(panel.getByRole("button", { name: "刷新技能" })).toBeDisabled();
  const emptyCatalog: SkillCatalog = { scope: "global", workspaceId: null, sources: [], notes: [] };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/skills*", async (route) => { await held; await route.fulfill({ contentType: "application/json", body: JSON.stringify(emptyCatalog) }); });
  await panel.getByRole("tab", { name: "全局技能", exact: true }).click();
  await expect(panel).toContainText("正在读取技能目录");
  await panel.getByRole("tab", { name: "发现技能", exact: true }).click();
  release();
  await expect(panel.getByRole("heading", { name: "Anthropic Skills" })).toBeVisible();
  await expect(panel).not.toContainText("技能目录读取失败");
});

test("skills discovery opens the selected directory and fits both themes", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  // Test mode records bridge calls in the main process without launching a browser.
  const visited = () => app.evaluate(() => (globalThis as { __amoOpenedUrls?: string[] }).__amoOpenedUrls ?? []);
  const panel = await openSkills(studio);
  await panel.getByRole("tab", { name: "全局技能", exact: true }).focus();
  await page.keyboard.press("End");
  await expect(panel.getByRole("tab", { name: "发现技能", exact: true })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "浏览仓库" }).click();
  await expect.poll(visited).toContain("https://github.com/anthropics/skills");
  await panel.getByRole("button", { name: "ClawHub", exact: true }).click();
  await panel.getByRole("button", { name: "前往 ClawHub" }).click();
  await expect.poll(visited).toContain("https://clawhub.ai/");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "skills-discover-dark", page);
  await panel.getByRole("button", { name: "skills.sh", exact: true }).click();
  await panel.getByRole("button", { name: "前往 skills.sh" }).click();
  await expect.poll(visited).toContain("https://skills.sh/");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "skills-discover-light", page);
});
