import { expect, test } from "@playwright/test";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("settings groups collapse, remember selection and restore after cross-group search", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  await studio.api("POST", "/api/prompt-templates", { title: "每日巡检", body: "检查近期改动，列出需要关注的问题。" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const nav = dialog.getByRole("navigation", { name: "设置分类" });
  const group = (name: string) => nav.getByRole("button", { name, exact: true });
  await expect(nav.getByRole("button", { expanded: true })).toHaveCount(1);
  await expect(group("通用")).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("tab")).toHaveCount(3);
  await expect(nav.getByRole("tab", { name: "界面", exact: true })).toHaveAttribute("aria-selected", "true");
  await group("模型与会话").click();
  await expect(nav.getByRole("button", { expanded: true })).toHaveCount(1);
  await expect(nav.getByRole("tab")).toHaveCount(5);
  await nav.getByRole("tab", { name: "提示词模板", exact: true }).click();
  await expect(dialog.getByTestId("prompt-preview")).toContainText("检查近期改动");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "settings-groups-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(app, "studio", "settings-groups-light", page);

  const search = dialog.getByLabel("搜索设置");
  await search.fill("代理");
  await expect(nav.getByRole("tab")).toHaveCount(1);
  await expect(nav.getByRole("tab", { name: "网络", exact: true })).toHaveAttribute("aria-selected", "true");
  await search.fill("维护");
  await expect(nav.getByRole("tab")).toHaveCount(2);
  await search.fill("没有这个设置xyz");
  await expect(dialog.getByRole("status")).toContainText("没有匹配的设置");
  await search.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(group("模型与会话")).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("tab", { name: "提示词模板", exact: true })).toHaveAttribute("aria-selected", "true");
  await search.fill("模型");
  await expect(nav.getByRole("tab")).toHaveCount(5);
  await nav.getByRole("tab", { name: "子会话", exact: true }).click();
  await dialog.getByLabel("清空设置搜索").click();
  await expect(dialog.getByTestId("prompt-manager")).toBeVisible();

  await group("模型与会话").click();
  await expect(nav.getByRole("tab")).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(nav.getByRole("tab")).toHaveCount(0);
  await expect(dialog.getByTestId("prompt-manager")).toBeVisible();
  await group("模型与会话").click();
  await nav.getByRole("tab", { name: "提示词模板", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(group("模型与会话")).toBeFocused();
  await expect(nav.getByRole("tab")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(nav.getByRole("tab")).toHaveCount(5);
  await page.keyboard.press("ArrowDown");
  await expect(nav.getByRole("tab", { name: "模型与渠道", exact: true })).toBeFocused();
  await expect(nav.getByRole("tab", { name: "模型与渠道", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(group("数据与维护")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(group("通用")).toBeFocused();
  await group("通用").click();
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.evaluate(() => { localStorage.setItem("amo.settings.size", JSON.stringify({ w: 640, h: 460 })); });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await screenshot(app, "studio", "settings-groups-small", page);
  await expect(nav.getByRole("tab")).toHaveCount(3);
});

test("settings reopens the last page with its parent group expanded", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const groups = [
    ["通用", ["界面", "项目与目录", "便签"]],
    ["模型与会话", ["模型与渠道", "子会话", "提示词模板", "额度", "用量统计"]],
    ["工具与自动化", ["MCP", "Git 编辑器", "值守"]],
    ["高级设置", ["网络", "功能开关", "测试功能"]],
    ["数据与维护", ["数据管理", "维护"]],
  ] as const;
  for (const [name, children] of groups) {
    const toggle = dialog.getByRole("button", { name, exact: true });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(dialog.getByRole("tab")).toHaveText([...children]);
    await expect(dialog.getByRole("button", { expanded: true })).toHaveCount(1);
  }
  await dialog.getByRole("button", { name: "工具与自动化", exact: true }).click();
  await dialog.getByRole("tab", { name: "MCP", exact: true }).click();
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "工具与自动化", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByRole("tab", { name: "MCP", exact: true })).toHaveAttribute("aria-selected", "true");
});
