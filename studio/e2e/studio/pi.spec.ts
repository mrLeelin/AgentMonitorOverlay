import { selectSettingsPage } from "../support/settings.js";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Session, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("Pi settings and a complete session use the native RPC adapter", async () => {
  const agent = fileURLToPath(new URL("../../packages/testkit/scripts/mock-pi.mjs", import.meta.url));
  studio = await launchStudio({ env: { AMO_STUDIO_TEST_PI_AGENT: agent } });
  const { page, app } = studio;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "模型与渠道");
  await dialog.locator('[data-testid="channel-nav"][data-id="pi"]').click();
  await expect(dialog.getByTestId("pi-section")).toContainText("本机 Pi");
  await expect(dialog.getByTestId("channel-page")).toContainText("Pi 测试模型");
  await dialog.getByTestId("pi-models-reload").click();
  await expect(dialog.getByTestId("channel-page")).toContainText("Pi 测试模型");
  await screenshot(app, "studio", "pi-settings", page);
  await page.keyboard.press("Escape");

  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("pi-project") });
  const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "Pi 接入验证", workspaceId: ws.id, firstSession: { profileId: "pi", text: "检查项目 [[tool]]" } });
  expect(session.runtime).toBe("pi");
  await page.getByTestId("task-card").filter({ hasText: "Pi 接入验证" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK-PI 1", { timeout: 30_000 });
  await expect(page.getByTestId("tool").first()).toHaveAttribute("data-status", "completed");
  await expect(page.getByTestId("session-fork")).toHaveCount(0);
  await page.getByTestId("session-more").click();
  await expect(page.getByTestId("session-terminal")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await screenshot(app, "studio", "pi-session", page);

  const composer = page.getByLabel("输入消息");
  await composer.fill("等待后续指令 [[hold]]");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "排队", exact: true })).toBeVisible();
  await composer.fill("现在接着做");
  await page.getByRole("button", { name: "排队", exact: true }).click();
  const waiting = page.getByTestId("msg-delivery").filter({ hasText: "立即发送" });
  await expect(waiting).toHaveAttribute("data-delivery", "waiting");
  await waiting.getByRole("button", { name: "立即发送" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("现在接着做", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await screenshot(app, "studio", "pi-queue-finished", page);

  await composer.fill("需要人选择 [[question]]");
  await composer.press("Enter");
  const question = page.getByTestId("question-card");
  await expect(question).toContainText("Pi 在问你");
  await expect(question).toContainText("选择下一步");
  await screenshot(app, "studio", "pi-question", page);
  await question.getByRole("radio", { name: "继续", exact: true }).click();
  await question.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("-> 继续", { timeout: 30_000 });
  await expect(question).toHaveCount(0);
});
