import { expect, type Locator } from "@playwright/test";

const ALIASES: Record<string, string> = { 模型: "模型与渠道", 统计: "用量统计", 功能: "功能开关" };
const GROUPS: Record<string, string> = {
  界面: "通用", 项目与目录: "通用", 便签: "通用",
  模型与渠道: "模型与会话", 子会话: "模型与会话", 提示词模板: "模型与会话", 额度: "模型与会话", 用量统计: "模型与会话",
  MCP: "工具与自动化", "Git 编辑器": "工具与自动化", 值守: "工具与自动化",
  网络: "高级设置", 功能开关: "高级设置", 测试功能: "高级设置",
  数据管理: "数据与维护", 维护: "数据与维护",
};

/** Follow the same category → page path as the person, including after another page or a filtered search. */
export async function selectSettingsPage(dialog: Locator, name: string): Promise<void> {
  const label = ALIASES[name] ?? name;
  const groupName = GROUPS[label];
  if (!groupName) throw new Error(`Unknown settings page: ${name}`);
  const tab = dialog.getByRole("tab", { name: label, exact: true });
  if (!(await tab.isVisible())) {
    const search = dialog.getByLabel("搜索设置", { exact: true });
    if (await search.inputValue()) await search.fill("");
    const group = dialog.getByRole("button", { name: groupName, exact: true });
    if ((await group.getAttribute("aria-expanded")) !== "true") await group.click();
  }
  await expect(tab).toBeVisible();
  await tab.click();
}
