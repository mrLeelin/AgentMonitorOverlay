import { expect, test } from "@playwright/test";
import type { PlaneBotJob, Session, SessionItem, StudioBot } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("opens the main conversation and keeps Bot tools in the right panel", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    const bot = await studio.api<StudioBot>("POST", "/api/bots", {
      name: "审核员", purpose: "负责审核项目改动", memory: "先核对回归结果", profileId: "codex-mock", workspaceId: null, enabled: true,
    });
    const chats = () => studio.api<Session[]>("GET", `/api/bots/${bot.id}/chats`);
    const bots = () => studio.api<StudioBot[]>("GET", "/api/bots");
    const row = page.getByTestId("bots-nav").getByRole("button", { name: bot.name, exact: true });
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await row.click();
    const mainRow = page.getByTestId("bots-nav").getByRole("button", { name: `${bot.name} 主聊天`, exact: true });
    const panel = page.getByRole("complementary", { name: `${bot.name} 的 Bot 侧栏` });
    const tabs = panel.getByRole("navigation", { name: "Bot 页面" });
    await expect(mainRow).toHaveAttribute("aria-current", "true");
    const [home] = await chats();
    expect(home?.id).toBe((await bots())[0]?.homeSessionId);
    await expect(page.getByTestId("thread-head")).toHaveText(bot.name);
    await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
    await expect(page.getByText("开始与 审核员 聊天")).toBeVisible();
    await expect(panel.getByText("还没有事项")).toBeVisible();
    await expect(panel.getByRole("button", { name: /^巡视/ })).toContainText("未启用");
    await expect(panel.getByRole("button", { name: /^整理记忆/ })).toContainText("每天 03:00");
    await screenshot(app, "studio", "bot-workspace-home-dark", page);

    await expect(page.getByRole("button", { name: "让审核员带队" })).toHaveCount(0);
    await row.click({ button: "right" });
    const leadMenu = page.getByRole("menu", { name: "Bot 操作" });
    await screenshot(app, "studio", "bot-lead-topics-menu", page);
    await leadMenu.getByRole("menuitem", { name: "带队专题…", exact: true }).click();
    const leadTopics = page.getByRole("dialog", { name: "审核员 · 带队专题" });
    await expect(leadTopics.getByText("还没有负责的专题。")).toBeVisible();
    await screenshot(app, "studio", "bot-lead-topics-dialog", page);
    await leadTopics.getByRole("button", { name: "让审核员带队" }).click();
    const appointment = page.getByTestId("lead-appointment");
    await expect(appointment.getByRole("heading", { name: "建立独立主控任务" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(appointment).toHaveCount(0);
    await expect(leadTopics).toBeVisible();
    await leadTopics.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(row).toBeFocused();

    await panel.getByRole("button", { name: "Bot 更多操作" }).click();
    const menu = page.getByRole("menu", { name: "Bot 更多操作" });
    await screenshot(app, "studio", "bot-workspace-menu-dark", page);
    await menu.getByRole("menuitem", { name: "暂停 Bot" }).click();
    await expect(row).toContainText("已暂停");
    await panel.getByRole("button", { name: "Bot 更多操作" }).click();
    await menu.getByRole("menuitem", { name: "继续 Bot" }).click();
    await expect(row).not.toContainText("已暂停");

    await panel.getByRole("button", { name: "Bot 设置", exact: true }).click();
    await expect(panel.getByRole("button", { name: "权限", exact: true })).toBeVisible();
    await screenshot(app, "studio", "bot-workspace-settings-dark", page);
    await panel.getByRole("combobox", { name: "多久算长期未活动" }).selectOption("7");
    await expect.poll(async () => (await bots())[0]?.preferences?.inactiveDays).toBe(7);

    await tabs.getByRole("button", { name: "连接器" }).click();
    await expect(panel.getByText("Webhook 接单")).toBeVisible();
    await tabs.getByRole("button", { name: "文件" }).click();
    const files = panel.getByRole("region", { name: "Bot 文件" });
    await files.getByRole("button", { name: "SOUL.md", exact: true }).click();
    await expect(files.getByRole("region", { name: "文件预览" })).toContainText(bot.purpose);
    await files.getByRole("button", { name: "关闭预览" }).click();
    await screenshot(app, "studio", "bot-workspace-files-dark", page);
    await files.getByRole("button", { name: "内容", exact: true }).click();
    await files.getByRole("searchbox", { name: "搜索文件内容" }).fill("先核对回归结果");
    await expect(files.getByRole("button", { name: "MEMORY.md", exact: true })).toBeVisible();
    await expect(files.getByRole("button", { name: "SOUL.md", exact: true })).toHaveCount(0);

    await tabs.getByRole("button", { name: "聊天", exact: true }).click();
    const chatList = panel.getByRole("region", { name: "Bot 聊天列表" });
    await expect(chatList.getByRole("button", { name: /^主聊天/ })).toHaveAttribute("aria-current", "true");
    await chatList.getByRole("button", { name: "新建聊天" }).click();
    await expect(page.getByText("开始与 审核员 聊天")).toBeVisible();
    expect(await chats()).toHaveLength(1);
    await screenshot(app, "studio", "bot-workspace-new-chat-dark", page);
    await chatList.getByRole("button", { name: /^主聊天/ }).click();
    await expect(mainRow).toHaveAttribute("aria-current", "true");
    expect(await chats()).toHaveLength(1);
    await chatList.getByRole("button", { name: "新建聊天" }).click();
    await page.getByRole("textbox", { name: "聊天消息" }).fill("检查项目的回归用例");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect.poll(async () => (await chats()).length).toBe(2);
    const conversation = (await chats()).find((session) => session.id !== home?.id)!;
    await expect.poll(async () => (await studio.api<SessionItem[]>("GET", `/api/sessions/${conversation.id}/items`))
      .some((item) => item.type === "user" && item.text.includes("检查项目的回归用例"))).toBe(true);
    expect((await bots())[0]?.homeSessionId).toBe(home?.id);
    await expect(page.locator(".bot-workspace-conversation").getByText("MOCK: 检查项目的回归用例", { exact: true })).toBeVisible();
    await expect(chatList.getByRole("button", { name: /检查项目的回归用例/ })).toBeVisible();
    await expect(chatList.getByText("MOCK: 检查项目的回归用例", { exact: true })).toBeVisible();
    await screenshot(app, "studio", "bot-workspace-chats-dark", page);

    await panel.getByRole("button", { name: "收起 Bot 侧栏" }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "展开 Bot 侧栏" }).click();
    await expect(tabs.getByRole("button", { name: "聊天", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await tabs.getByRole("button", { name: "主页" }).click();
    await screenshot(app, "studio", "bot-workspace-home-light", page);
    await page.setViewportSize({ width: 960, height: 740 });
    await tabs.getByRole("button", { name: "文件" }).click();
    await expect(files.getByRole("button", { name: "SOUL.md", exact: true })).toBeVisible();
    await screenshot(app, "studio", "bot-workspace-files-narrow", page);
  } finally {
    await studio.close();
  }
});

test("collapses running Plane jobs and puts actionable jobs first in the Bot chat", async () => {
  const studio = await launchStudio();
  try {
    const { page, app } = studio;
    await studio.api("PUT", "/api/settings", { teamTasksEnabled: true });
    const bot = await studio.api<StudioBot>("POST", "/api/bots", { name: "处理大师", purpose: "跟进团队工单", memory: "", profileId: "codex-mock", workspaceId: null, enabled: true, avatar: "mascot:B1" });
    const home = await studio.api<Session>("POST", `/api/bots/${bot.id}/home`, {});
    const job = (number: string, title: string, state: PlaneBotJob["state"]): PlaneBotJob => ({
      jobId: number, botId: bot.id, workspaceId: home.workspaceId, itemId: number, botTaskId: home.taskId,
      botSessionId: home.id, taskId: null, item: { number, title }, state,
    });
    const executing = job("TALUO-13", "补齐 Plane Bot 接单说明", "executing");
    const plan = job("TALUO-12", "对照 AMO Studio 与 Orca 的机器人协作流程并汇总需要继续验证的事项", "awaiting-approval");
    const review = job("TALUO-11", "验证 Bot 请求重试不会重复派发", "review");
    let jobs = [executing];
    await page.route(`**/api/team-board/plane/bots/${bot.id}/jobs*`, (route) => route.fulfill({ json: route.request().url().includes("unfinished=1") ? jobs : [] }));
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await page.getByRole("button", { name: "处理大师 主聊天", exact: true }).click();
    const bar = page.getByTestId("plane-bot-conversation");
    const toggle = bar.getByRole("button", { name: /^Plane 工单/ });
    const rows = bar.getByTestId("plane-bot-conversation-job");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(rows.first()).toBeHidden();
    await screenshot(app, "studio", "plane-bot-jobs-collapsed-dark", page);
    await toggle.click();
    const openJob = rows.first().getByRole("button", { name: "查看工单" });
    await openJob.click();
    const dialog = page.getByRole("dialog", { name: "Bot 工单" });
    await expect(dialog.getByRole("heading")).toHaveText("处理大师 · TALUO-13");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(openJob).toBeFocused();

    jobs = [executing, plan, review];
    await page.reload();
    await page.getByRole("button", { name: "处理大师 主聊天", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(toggle).toContainText("2 项待处理");
    await expect(rows.getByRole("status")).toHaveText(["计划待确认", "等待人工验收", "Bot 已进入独立工作树"]);
    await page.getByRole("button", { name: "深色模式", exact: true }).click();
    await screenshot(app, "studio", "plane-bot-jobs-expanded-light", page);
    await app.evaluate(({ BrowserWindow }, url) => { BrowserWindow.getAllWindows().find((win) => win.webContents.getURL() === url)!.setSize(960, 740); }, page.url());
    await expect(rows.first().getByRole("button", { name: "查看计划" })).toBeInViewport();
    await expect(rows.nth(1).getByRole("button", { name: "验收交付" })).toBeInViewport();
    await expect(rows.nth(2).getByRole("button", { name: "查看工单" })).toBeInViewport();
    await screenshot(app, "studio", "plane-bot-jobs-narrow", page);
    await toggle.click();
    await expect(rows.first()).toBeHidden();
    await expect(toggle).toContainText("2 项待处理");
  } finally {
    await studio.close();
  }
});
