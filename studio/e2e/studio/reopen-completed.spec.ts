import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("sending another message to completed work moves its card back to 进行中", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "继续已完成任务",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "第一轮" },
  });
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  await expect(page.getByTestId("msg-agent")).toContainText("MOCK: 第一轮", { timeout: 60_000 });
  await expect(page.getByTestId("task-status")).toHaveText("待审阅", { timeout: 15_000 });
  await page.getByTestId("task-status").click();
  await page.getByTestId("status-done").click();
  await expect(page.getByTestId("task-status")).toHaveText("完成");

  await page.getByLabel("输入消息").fill("[[slow]]");
  await page.getByLabel("输入消息").press("Enter");
  await expect(page.getByTestId("task-status")).toHaveText("进行中");
  await page.getByTestId("scope-all").click();
  await expect(page.getByTestId("column-doing").getByTestId("task-card")).toContainText(task.title);
  await expect(page.getByTestId("column-done").getByTestId("task-card")).toHaveCount(0);
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.find((t) => t.id === task.id)?.column).toBe("doing");
  await screenshot(app, "studio", "reopen-completed-doing", page);
  await expect(page.getByTestId("column-review").getByTestId("task-card")).toContainText(task.title, { timeout: 30_000 });
});
