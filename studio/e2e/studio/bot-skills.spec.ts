import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import type { BotSkillRef, StudioBot, Workspace } from "@amo-studio/protocol";
import { selectSettingsPage } from "../support/settings.js";
import { launchStudio, screenshot } from "../support/studio.js";

function skill(root: string, name: string, description: string) {
  const path = join(root, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n核对本次会话的测试资料。\n`, "utf8");
}

test("adds shared and project skills and shows a cached plugin as unavailable", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const workspace = studio.workspace("release");
    const project = await studio.api<Workspace>("POST", "/api/workspaces", { path: workspace });
    skill(join(studio.dataDir, "test-skill-home", ".agents", "skills"), "文档检索", "查找项目文档和技术参考。");
    skill(join(studio.dataDir, "test-skill-home", ".agents", "skills"), "更新日志", "从改动生成发布说明。");
    skill(join(workspace, ".agents", "skills"), "项目提交规范", "核对仓库约定与改动范围。");
    skill(join(studio.root, "codex-home", "plugins", "cache", "team", "测试助手", "1.0", "skills"), "测试覆盖分析", "识别未覆盖的代码路径。");
    const input = { purpose: "检查改动并报告风险。", memory: "", profileId: "codex-mock", workspaceId: project.id, enabled: true };
    const reviewer = await studio.api<StudioBot>("POST", "/api/bots", { ...input, name: "审核员" });
    const assistant = await studio.api<StudioBot>("POST", "/api/bots", { ...input, name: "项目助手", profileId: "claude-mock" });

    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await selectSettingsPage(settings, "Bots");
    const panel = settings.getByTestId("studio-bots-settings");
    const picker = page.getByRole("dialog", { name: "添加技能", exact: true });
    const add = panel.getByRole("button", { name: "添加技能", exact: true });
    await add.click();
    await expect(picker.getByRole("heading", { name: "本机全局" })).toBeVisible();
    await expect(picker.getByRole("checkbox", { name: /测试覆盖分析/ })).toBeDisabled();
    await expect(picker).toContainText("请在单个 Bot 中添加");
    await expect(picker.getByRole("heading", { name: "项目技能" })).toHaveCount(0);
    await picker.getByRole("checkbox", { name: /文档检索/ }).check();
    await picker.getByRole("button", { name: "添加（1）" }).click();
    const saveShared = panel.getByRole("button", { name: "保存共有技能" });
    await saveShared.click();
    await expect(panel.getByText("已保存，新建聊天时生效。", { exact: true })).toBeVisible();
    expect(await studio.api<BotSkillRef[]>("GET", "/api/bot-skills/shared")).toMatchObject([{ name: "文档检索" }]);
    await screenshot(app, "studio", "bot-skills-shared", page);

    await panel.getByRole("button", { name: "审核员", exact: true }).click();
    const tabs = panel.getByRole("navigation", { name: "Bot 设置分区" });
    await tabs.getByRole("button", { name: "访问与技能", exact: true }).click();
    await add.click();
    await expect(picker.getByRole("checkbox", { name: /项目提交规范/ })).toBeEnabled();
    await expect(picker).toContainText("未确认可用");
    await picker.getByLabel("技能来源").selectOption("plugin");
    await expect(picker.getByRole("checkbox", { name: /项目提交规范/ })).toHaveCount(0);
    await picker.getByLabel("技能来源").selectOption("all");
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", "bot-skills-picker-dark", page);
    await picker.getByRole("searchbox", { name: "搜索技能" }).fill("提交");
    await picker.getByRole("checkbox", { name: /项目提交规范/ }).check();
    await picker.getByRole("button", { name: "添加（1）" }).click();
    await panel.getByRole("button", { name: "管理共有技能" }).click();
    await expect(panel.getByRole("heading", { name: "共有技能", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "审核员", exact: true }).click();
    const section = panel.getByRole("region", { name: "技能", exact: true });
    await expect(section.getByText("项目提交规范", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "保存", exact: true }).click();
    await expect(panel.getByText("已保存。", { exact: true })).toBeVisible();
    expect((await studio.api<StudioBot[]>("GET", "/api/bots")).find((bot) => bot.id === reviewer.id)?.skills).toMatchObject([{ name: "项目提交规范" }]);
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await section.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await screenshot(app, "studio", "bot-skills-individual", page);

    await panel.getByRole("button", { name: "项目助手", exact: true }).click();
    await tabs.getByRole("button", { name: "访问与技能", exact: true }).click();
    await expect(section.getByText("文档检索", { exact: true })).toBeVisible();
    await expect(section.getByText("项目提交规范", { exact: true })).toHaveCount(0);

    await studio.api("POST", `/api/bots/${reviewer.id}/requests`, { id: "check-codex-skills", text: "核对 Codex 技能上下文。" });
    await studio.api("POST", `/api/bots/${assistant.id}/requests`, { id: "check-claude-skills", text: "核对 Claude 技能上下文。" });
    const codex = () => JSON.stringify(studio.mock?.requests.find((request) => request.lastUserText.includes("核对 Codex 技能上下文"))?.body ?? {});
    const claude = () => JSON.stringify(studio.claudeMock?.requests.find((request) => request.tools.length && request.lastUserText.includes("核对 Claude 技能上下文"))?.body ?? {});
    await expect.poll(codex, { timeout: 30_000 }).toMatch(/项目提交规范\/SKILL\.md/);
    expect(codex()).toContain("文档检索/SKILL.md");
    await expect.poll(claude, { timeout: 30_000 }).toMatch(/文档检索\/SKILL\.md/);
    expect(claude()).not.toContain("项目提交规范/SKILL.md");
  } finally { await studio.close(); }
});
