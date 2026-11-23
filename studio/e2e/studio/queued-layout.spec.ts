import { expect, test } from "@playwright/test";
import type { Session, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot } from "../support/studio.js";

test("排队消息显示在输入框上方", async () => {
  const studio = await launchStudio();
  try {
    const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
    const { session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "排队布局测试", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo queue-test]]" } });
    const { page } = studio;
    await page.getByTestId("task-card").first().click();
    await expect(page.getByTestId("approval").first()).toHaveAttribute("data-state", "pending", { timeout: 30_000 });
    await page.getByLabel("输入消息").fill("这是等待本轮结束的排队消息");
    await page.getByRole("button", { name: "排队", exact: true }).click();
    const queued = page.getByTestId("queued-message");
    await expect(queued).toContainText("这是等待本轮结束的排队消息");
    await expect(queued.getByRole("button", { name: /立即发送/ })).toBeVisible();
    await queued.getByRole("button", { name: "编辑消息" }).click();
    await page.getByLabel("编辑排队消息").fill("编辑后的排队消息");
    await queued.getByRole("button", { name: "保存" }).click();
    await expect(queued).toContainText("编辑后的排队消息");
    await page.getByLabel("输入消息").fill("这条排队消息要删除");
    await page.getByRole("button", { name: "排队", exact: true }).click();
    await expect(queued).toHaveCount(2);
    await queued.filter({ hasText: "这条排队消息要删除" }).getByRole("button", { name: "删除排队消息" }).click();
    await expect(queued).toHaveCount(1);
    const stored = await studio.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
    const removed = stored.find((item) => item.type === "user" && item.text === "这条排队消息要删除");
    expect(removed).toMatchObject({ delivery: "expired", queueCancelled: true });
    await expect(studio.api("PATCH", `/api/sessions/${session.id}/items/${removed!.id}/queued`, { text: "不应保存", originalText: "这条排队消息要删除" })).rejects.toThrow();
    await screenshot(studio.app, "studio", "queued-layout", page);
    await page.getByRole("button", { name: "深色模式" }).click();
    await screenshot(studio.app, "studio", "queued-layout-dark", page);
    await page.getByTestId("approval").first().getByRole("button", { name: "批准" }).click();
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId("msg-agent").last()).toContainText("编辑后的排队消息", { timeout: 30_000 });
    await expect(page.getByTestId("msg-user").filter({ hasText: "这条排队消息要删除" })).toHaveCount(0);
  } finally {
    await studio.close();
  }
});
