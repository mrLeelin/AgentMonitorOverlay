import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("a lead waits on the board until all children deliver or finish, then reopens with a child", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("lead-review-wait") });
  const top = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "主控：等待全部子任务返回", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: "整理工作分工。" } });
  const worker = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "子任务：本轮停止后提交交付", workspaceId: ws.id, managerTaskId: top.task.id, firstSession: { profileId: "codex-mock", text: "检查实现。" } });
  const waiting = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "子任务：等待完成", workspaceId: ws.id, managerTaskId: top.task.id });
  const column = async (id: string) => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.id === id)?.column;
  await page.getByTestId("scope-all").click();
  await expect.poll(() => column(worker.task.id), { timeout: 30_000 }).toBe("review");
  // The lead's own turn has settled too; a child ending a turn alone is insufficient.
  await page.waitForTimeout(4500);
  await expect(page.getByTestId("column-doing").locator(`[data-task-id="${top.task.id}"]`)).toBeVisible();
  expect(await column(top.task.id)).toBe("doing");
  await screenshot(app, "studio", "lead-review-wait-pending", page);

  await studio.api("POST", `/api/tasks/${worker.task.id}/workflow/submit`, { sessionId: worker.session.id, summary: "实现已返回", verification: "隔离 mock 检查通过。" });
  expect(await column(top.task.id)).toBe("doing");
  await studio.api("PATCH", `/api/tasks/${waiting.task.id}`, { column: "done" });
  await expect.poll(() => column(top.task.id), { timeout: 30_000 }).toBe("review");
  await expect(page.getByTestId("column-review").locator(`[data-task-id="${top.task.id}"]`)).toBeVisible();
  await screenshot(app, "studio", "lead-review-wait-returned", page);

  await studio.api("PATCH", `/api/tasks/${waiting.task.id}`, { column: "doing" });
  await expect(page.getByTestId("column-doing").locator(`[data-task-id="${top.task.id}"]`)).toBeVisible();
  expect((await studio.api<Task>("PATCH", `/api/tasks/${top.task.id}`, { column: "review" })).column).toBe("doing");
});
