import { expect, test } from "@playwright/test";
import type { BotRequest, Session, StudioBot, Task } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("creates a Bot from settings and routes a task mention to its own main chat", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page, app } = studio;
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await expect(page.getByLabel("Bots 工作台")).toBeVisible();
  await page.getByRole("button", { name: "管理 Bots", exact: true }).click();
  const settings = page.getByTestId("studio-bots-settings");
  await settings.getByRole("button", { name: "用审核员模板" }).click();
  const avatarPreview = settings.getByTestId("bot-avatar-preview");
  await expect(avatarPreview.locator(".bot-avatar")).toHaveText("审");
  const picture = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#176d65";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#e2fff1";
    context.lineWidth = 9;
    context.lineCap = context.lineJoin = "round";
    context.beginPath();
    context.moveTo(59, 49);
    context.lineTo(74, 64);
    context.lineTo(101, 35);
    context.stroke();
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await settings.getByLabel("选择头像").setInputFiles({ name: "avatar.png", mimeType: "image/png", buffer: Buffer.from(picture, "base64") });
  await expect.poll(() => avatarPreview.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(128);
  await settings.getByLabel("模型配置").selectOption("codex-mock");
  await settings.getByLabel("记忆", { exact: true }).fill("优先验证用户能感知的功能回归。");
  await settings.getByRole("button", { name: "保存", exact: true }).click();
  await expect(settings.getByText("已保存。")).toBeVisible();
  const [bot] = await studio.api<StudioBot[]>("GET", "/api/bots");
  expect(bot?.avatar).toMatch(/^data:image\/png;base64,/);
  await screenshot(app, "studio", "bots-settings", page);
  await page.getByRole("button", { name: "关闭设置" }).click();
  await expect(page.getByLabel("Bot 列表").locator(".bot-avatar img")).toBeVisible();
  await screenshot(app, "studio", "bots-workbench", page);
  await page.getByRole("button", { name: "全部任务", exact: true }).click();

  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "测试 Bot 审查", firstSession: { profileId: "codex-mock" } });
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  const input = page.getByRole("textbox", { name: "输入消息" });
  await input.pressSequentially("@");
  await expect(page.getByRole("option", { name: /审核员/ }).locator(".bot-avatar img")).toBeVisible();
  await page.getByText("审核员", { exact: true }).click();
  await input.pressSequentially("检查当前改动");
  await expect(page.getByLabel("发送给 Bot")).toHaveValue("home");
  await input.press("Enter");
  const result = page.getByTestId("bot-request");
  await expect(result).toContainText("已完成", { timeout: 45_000 });
  await expect(result).toContainText("检查当前改动");
  await expect(result.locator(".bot-avatar img")).toBeVisible();
  const [request] = await studio.api<BotRequest[]>("GET", `/api/bot-requests?sourceSessionId=${session.id}`);
  expect(request?.sessionId).toBeTruthy();
  expect(request?.sessionId).not.toBe(session.id);
  await result.getByText("查看结论").click();
  await screenshot(app, "studio", "bots-request", page);
  await result.getByRole("button", { name: /打开 Bot 会话/ }).click();
  await expect(page.getByTestId("task-title").locator(".bot-avatar img")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
});

test("group members answer in their own chats and show results in the Bot workbench", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page, app } = studio;
  for (const name of ["代码审核员", "回归审核员"]) {
    await studio.api<StudioBot>("POST", "/api/bots", { name, purpose: "按你的职责复核项目。", memory: "", profileId: "codex-mock", workspaceId: null, enabled: true });
  }
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  const group = page.getByRole("region", { name: "Bot 群组" });
  await group.getByRole("button", { name: "新建群组" }).click();
  await group.getByLabel("群组名称").fill("复核小组");
  await group.getByRole("checkbox", { name: "代码审核员" }).check();
  await group.getByRole("checkbox", { name: "回归审核员" }).check();
  await group.getByRole("button", { name: "保存群组" }).click();
  await group.getByLabel("群组消息").fill("分别检查同一份改动。");
  await group.getByRole("button", { name: "发送群组消息" }).click();
  const requests = group.getByTestId("bot-request");
  await expect(requests).toHaveCount(2);
  await expect(requests.filter({ hasText: "已完成" })).toHaveCount(2, { timeout: 45_000 });
  await screenshot(app, "studio", "bots-group", page);
});
