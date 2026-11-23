import { expect, test, type Page } from "@playwright/test";
import type { Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";
import { selectSettingsPage } from "../support/settings.js";

// Chat panel against the real Codex app-server and the mock model: approvals, steer, interrupt, subagents.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function openTask(s: Studio, text: string) {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace("alpha") });
  const created = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "对话面板",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text },
  });
  await s.page.getByTestId("task-card").first().click();
  await expect(s.page.getByTestId("task-title")).toHaveText("对话面板");
  return created;
}

const composer = (page: Page) => page.getByLabel("输入消息");
const lastAgent = (page: Page) => page.getByTestId("msg-agent").last();

test("approves and declines commands from the approval card", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[shell: cmd /c echo e2e-approved]]");

  const card = page.getByTestId("approval").first();
  await expect(card).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(card).toContainText("cmd /c echo e2e-approved");
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await card.getByRole("button", { name: "批准" }).click();
  await expect(card).toHaveAttribute("data-state", "accepted");
  await expect(card).toContainText("已批准");
  await expect(lastAgent(page)).toContainText("MOCK-DONE", { timeout: 30_000 });
  const tool = page.getByTestId("tool").first();
  await expect(tool).toHaveAttribute("data-status", "completed");
  await tool.getByRole("button").click();
  await expect(tool).toContainText("e2e-approved");
  await expect(page.getByTestId("needs-you")).toHaveCount(0);

  await composer(page).fill("[[shell: cmd /c echo e2e-declined]]");
  await composer(page).press("Enter");
  const second = page.getByTestId("approval").nth(1);
  await expect(second).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await second.getByRole("button", { name: "拒绝" }).click();
  await expect(second).toContainText("已拒绝");
  await expect(page.getByTestId("tool").nth(1)).toHaveAttribute("data-status", "declined", { timeout: 30_000 });
  await screenshot(studio.app, "stage-1", "S1-11c-approval", page);
});

test("steers a running reply and interrupts another", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[slow]]");

  // The default is to queue, with a per-message shortcut to insert into the running turn instead.
  await expect(page.getByRole("button", { name: "排队" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible();
  await composer(page).fill("补充一句");
  const sent = page.waitForResponse((res) => res.url().endsWith("/messages") && res.request().method() === "POST");
  await composer(page).press("Control+Shift+Enter");
  expect(await (await sent).json()).toMatchObject({ mode: "steer" });
  // Codex delivers steered input at the next sampling boundary, i.e. after the current (slow) model response.
  await expect(page.getByTestId("msg-user").filter({ hasText: "补充一句" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(lastAgent(page)).toContainText("MOCK: 补充一句");

  await composer(page).fill("[[slow]]");
  await composer(page).press("Enter");
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible({ timeout: 30_000 });
  await expect(lastAgent(page)).toContainText("slow");
  // 问题 #16 (2026-11-03): until the turn has stopped (held here, as a real one can take seconds) the button greys and
  // the composer says it is stopping.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/interrupt", async (route) => (await held, route.continue()));
  await page.getByRole("button", { name: "打断" }).click();
  await expect(page.getByRole("button", { name: "正在停止" })).toBeDisabled();
  await expect(page.locator(".composer-hint")).toContainText("正在停止…");
  await screenshot(studio.app, "stage-1", "S1-12-stopping", page);
  release();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "打断" })).toHaveCount(0);
  // A reply had come back: the message stays sent.
  await expect(composer(page)).toHaveText("");

  // 停止 before anything came back (2026-10-28): the message goes back into the composer to be reworded.
  await composer(page).fill("改一下掉落表 [[wait]]");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveText("");
  await expect(page.getByRole("button", { name: "打断" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "打断" }).click();
  await expect(composer(page)).toHaveText("改一下掉落表 [[wait]]");
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible({ timeout: 30_000 });
});

test("input settings keep follow-ups in separate Codex turns and allow Enter to make a newline", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  const { session } = await openTask(studio, "[[shell: cmd /c echo first-turn]]");
  const approvals = page.getByTestId("approval");
  await expect(approvals.first()).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(dialog, "界面");
  const enter = dialog.getByLabel("发送与开始快捷键");
  const followup = dialog.getByLabel("后续消息处理方式");
  await expect(followup).toHaveValue("queue");
  await enter.selectOption("newline-shift");
  await dialog.getByRole("radio", { name: "深色", exact: true }).click();
  await screenshot(app, "studio", "input-settings-dark", page);
  await dialog.getByRole("radio", { name: "浅色", exact: true }).click();
  await screenshot(app, "studio", "input-settings-light", page);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const input = composer(page);
  await input.fill("第一条跟进");
  await input.press("End");
  await input.press("Enter");
  await input.pressSequentially(" [[shell: cmd /c echo second-turn]]");
  await input.press("Control+Enter");
  await input.fill("第二条跟进");
  await page.getByRole("button", { name: "排队", exact: true }).click();
  const items = () => studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
  const pending = page.getByTestId("msg-delivery");
  await expect(pending).toHaveCount(2);
  const before = await items();
  expect(before.filter((item) => item.type === "user" && item.delivery === "held").map((item) => item.type === "user" && item.text)).toEqual([
    "第一条跟进\n [[shell: cmd /c echo second-turn]]", "第二条跟进",
  ]);
  await screenshot(app, "studio", "queued-followups", page);
  await approvals.first().getByRole("button", { name: "批准" }).click();
  await expect(approvals.nth(1)).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
  await expect(approvals.nth(1)).toContainText("second-turn");
  await expect(pending).toHaveCount(1);
  expect((await items()).filter((item) => item.type === "user" && item.delivery === "held")).toMatchObject([{ type: "user", text: "第二条跟进" }]);
  await approvals.nth(1).getByRole("button", { name: "批准" }).click();
  await expect(lastAgent(page)).toContainText("MOCK: 第二条跟进", { timeout: 30_000 });
  const turns = (await items()).filter((item) => item.type === "turn");
  expect(turns).toHaveLength(3);

  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await selectSettingsPage(dialog, "界面");
  await expect(enter).toHaveValue("newline-shift");
});

test("numbered lists continue only on a composer line break", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  await openTask(studio, "你好");
  await expect(lastAgent(page)).toContainText("MOCK: 你好", { timeout: 30_000 });
  const input = composer(page);
  const first = "1. First item";
  const second = `${first}\n2. Second item`;
  await input.fill(first);
  await input.press("End");
  await input.press("Shift+Enter");
  await expect(input).toHaveJSProperty("textContent", `${first}\n2. `);
  await input.pressSequentially("Second item");
  await input.press("Shift+Enter");
  await expect(input).toHaveJSProperty("textContent", `${second}\n3. `);
  await screenshot(app, "studio", "composer-numbered-list", page);
  await input.press("Control+Z");
  await expect(input).toHaveJSProperty("textContent", second);
  await input.press("Control+Shift+Z");
  await input.press("Shift+Enter");
  await expect(input).toHaveJSProperty("textContent", `${second}\n`);
  await input.pressSequentially("3.14 is a decimal");
  await input.press("Shift+Enter");
  await expect(input).toHaveJSProperty("textContent", `${second}\n3.14 is a decimal\n`);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "界面");
  await settings.getByLabel("发送与开始快捷键").selectOption("newline-shift");
  await page.keyboard.press("Escape");
  await input.fill("9. Ninth item");
  await input.press("End");
  await input.press("Enter");
  await expect(input).toHaveJSProperty("textContent", "9. Ninth item\n10. ");
  await input.pressSequentially("Tenth item");
  const sent = page.waitForRequest((req) => req.url().endsWith("/messages") && req.method() === "POST");
  await input.press("Control+Enter");
  expect((await sent).postDataJSON()).toMatchObject({ text: "9. Ninth item\n10. Tenth item" });
});

test("the newline shortcut swaps the chat send key and cannot collide with filing a task", async () => {
  studio = await launchStudio();
  const { app, page } = studio;
  await openTask(studio, "你好");
  await expect(lastAgent(page)).toContainText("MOCK: 你好", { timeout: 30_000 });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "界面");
  const todo = settings.getByLabel("放进待办快捷键");
  const enter = settings.getByLabel("发送与开始快捷键");
  await expect(settings.getByLabel("换行快捷键", { exact: true })).toHaveCount(0);
  await expect(enter).toHaveValue("send-shift");
  await expect(enter.locator("option")).toHaveCount(6);
  await todo.selectOption("ctrl");
  const available = enter.locator("option:not(:disabled)");
  await expect(available).toHaveCount(1);
  await expect(available).toHaveAttribute("value", "send-shift");
  await todo.selectOption("alt");
  await enter.selectOption("newline-ctrl");
  await expect(todo.locator('option[value="ctrl"]')).toHaveJSProperty("disabled", true);
  await expect(enter.locator("option:checked")).toHaveText("Shift+Enter 发送，Enter 或 Ctrl+Enter 换行");
  await todo.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "composer-shortcuts-combined", page);
  await page.keyboard.press("Escape");

  const input = composer(page);
  await expect(input).toHaveAttribute("data-placeholder", /Shift\+Enter 发送，Enter 或 Ctrl\+Enter 换行/);
  await input.fill("1. First");
  await input.press("End");
  await input.press("Control+Enter");
  await expect(input).toHaveJSProperty("textContent", "1. First\n2. ");
  await input.pressSequentially("Second");
  const sent = page.waitForRequest((req) => req.url().endsWith("/messages") && req.method() === "POST");
  await input.press("Shift+Enter");
  expect((await sent).postDataJSON()).toMatchObject({ text: "1. First\n2. Second" });

  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: "alpha" }).click();
  const draft = page.getByLabel("第一句话");
  await draft.fill("1. New task");
  await draft.press("End");
  await expect(page.getByTestId("draft-start").locator("kbd")).toHaveText("Shift+Enter");
  await draft.press("Enter");
  await expect(draft).toHaveJSProperty("textContent", "1. New task\n2. ");
  await draft.pressSequentially("Follow-up");
  await draft.press("Control+Enter");
  await expect(draft).toHaveJSProperty("textContent", "1. New task\n2. Follow-up\n3. ");
  await draft.press("Enter"); // Finish the numbered list.
  await draft.pressSequentially("Done");
  await screenshot(app, "studio", "newtask-start-shortcut", page);
  await draft.press("Shift+Enter");
  await expect(draft).toHaveCount(0);
  await expect(page.getByTestId("msg-user").last()).toContainText("Done");
});

test("a message the Host does not answer: 正在发送… after a few seconds, its text back in the composer after 30", async () => {
  test.setTimeout(120_000);
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "你好");
  await expect(lastAgent(page)).toContainText("MOCK: 你好", { timeout: 60_000 });
  // 2026-11-05: one sent right after 停止 never came back — no row, no error, the composer already empty.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/sessions/*/messages", async (route) => (await held, route.continue()));
  await composer(page).fill("这条卡住了");
  await composer(page).press("Enter");
  await expect(composer(page)).toHaveText("");
  await expect(page.locator(".composer-hint")).toHaveText("正在发送…", { timeout: 10_000 });
  await screenshot(studio.app, "studio", "send-slow", page);
  await expect(composer(page)).toHaveText("这条卡住了", { timeout: 40_000 });
  await expect(page.getByText(/Host 还没回应：文字放回了输入框/)).toBeVisible();
  await expect(page.locator(".composer-hint")).not.toContainText("正在发送");
  await screenshot(studio.app, "studio", "send-given-up", page);
  // It went in after all: the row shows, and the composer keeps the text (the person decides).
  release();
  await expect(page.getByTestId("msg-user").filter({ hasText: "这条卡住了" })).toBeVisible({ timeout: 30_000 });
  await expect(composer(page)).toHaveText("这条卡住了");
});

test("shows a subagent under its parent and jumps to it", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await openTask(studio, "[[spawn: explorer: list call sites]]");

  const sub = page.getByTestId("msg-subagent");
  await expect(sub).toContainText("/root/explorer", { timeout: 30_000 });
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("data-kind", "sub");
  await expect(rows.nth(1)).toHaveAttribute("data-depth", "1");
  await expect(rows.nth(1)).toContainText("explorer");
  await screenshot(studio.app, "stage-1", "S1-11c-subagent", page);

  await sub.getByRole("button", { name: "查看" }).click();
  await expect(page.getByTestId("thread-head")).toContainText("explorer");
  await expect(lastAgent(page)).toContainText("MOCK-SUB: /root/explorer");
});
