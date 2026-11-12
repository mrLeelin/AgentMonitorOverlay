import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, TaskResult, TaskWorkflow, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });
const settled = async (taskId: string) => expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.taskId === taskId).every((s) => /idle|completed|interrupted/.test(s.status)), { timeout: 30_000 }).toBe(true);

test("root final delivery waits for explicit user return and acceptance with matching persisted board state", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("user-final-review") });
  const created = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "投币小游戏最终交付", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: '[[mcp: task_submit_result {"summary":"投币小游戏已集成","verification":"隔离验证：投币触发一次，音效与画面同步。"}]]' } });
  const workflow = () => studio!.api<TaskWorkflow>("GET", `/api/tasks/${created.task.id}/workflow`);
  const column = async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.id === created.task.id)?.column;
  await expect.poll(async () => (await workflow()).results.at(-1)?.state).toBe("submitted");
  await settled(created.task.id);
  expect(await column()).toBe("review");
  const first = (await workflow()).results.at(-1)!;
  await page.getByTestId("task-card").filter({ hasText: created.task.title }).click();
  await page.getByTestId("task-management-toggle").click();
  let result = page.getByTestId("workflow-result").last();
  await expect(result).toContainText("待用户审核");
  await result.locator("summary").first().click();
  await expect(page.getByTestId("workflow-user-review")).toBeVisible();
  await expect(page.getByRole("button", { name: "退回修改", exact: true })).toBeDisabled();
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.getByTestId("workflow-user-review").scrollIntoViewIfNeeded();
    await screenshot(app, "studio", `user-review-pending-${theme}`, page);
  }
  // Generic board movement cannot masquerade as explicit acceptance.
  await expect(studio.api("PATCH", `/api/tasks/${created.task.id}`, { column: "done" })).rejects.toThrow(/交付与验收/);
  await page.getByLabel("验收意见或退回原因", { exact: true }).fill("请补充第二次投币的验证记录。");
  await page.getByRole("button", { name: "退回修改", exact: true }).click();
  await expect(result).toHaveAttribute("data-state", "returned");
  await expect(result).toContainText("请补充第二次投币");
  expect(await column()).toBe("doing");
  expect((await workflow()).results.at(-1)).toMatchObject({ id: first.id, state: "returned", reviewedBy: "user" });
  await result.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "user-review-returned", page);
  await settled(created.task.id);
  const second = await studio.api<TaskResult>("POST", `/api/tasks/${created.task.id}/workflow/submit`, { sessionId: created.session.id, summary: "补充验证后重新交付", verification: "连续两次投币均只触发一次；音效、画面与计数同步。" });
  result = page.getByTestId("workflow-result").last();
  await expect(result).toHaveAttribute("data-state", "submitted");
  await result.locator("summary").first().click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await expect(result).toHaveAttribute("data-state", "accepted");
  await expect(result).toContainText("用户已验收");
  await expect(page.getByTestId("workflow-user-review")).toHaveCount(0);
  expect(await column()).toBe("done");
  expect((await workflow()).results.at(-1)).toMatchObject({ id: second.id, state: "accepted", reviewedBy: "user", review: "用户验收通过" });
  await page.reload();
  await page.getByTestId("task-management-toggle").click();
  await expect(page.getByTestId("workflow-result").last()).toContainText("用户已验收");
  await page.getByTestId("workflow-result").last().scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "user-review-accepted", page);
});

test("managed domain leads still return to their direct manager and expose no human final-review controls", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("domain-review") });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "游戏总主控", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: "等待分工成果。" } });
  const child = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "音效二级主控", workspaceId: ws.id, lead: true, managerTaskId: root.task.id, firstSession: { profileId: "codex-mock", text: "登记已验证的音效成果。" } });
  await settled(child.task.id);
  const submitted = await studio.api<TaskResult>("POST", `/api/tasks/${child.task.id}/workflow/submit`, { sessionId: child.session.id, summary: "音效完成", verification: "触发和播放次数检查通过。" });
  await page.getByTestId("task-card").filter({ hasText: root.task.title }).click();
  await page.getByTestId("task-management-toggle").click();
  const result = page.getByTestId("workflow-result");
  await expect(result).toContainText("待主控验收");
  await result.locator("summary").first().click();
  await expect(page.getByTestId("workflow-user-review")).toHaveCount(0);
  await expect(studio.api("POST", `/api/tasks/${child.task.id}/workflow/user-review`, { resultId: submitted.id, accept: true, review: "越过直属主控" })).rejects.toThrow(/直属主控/);
  await settled(child.task.id);
  await studio.api("POST", `/api/tasks/${root.task.id}/workflow/review`, { sessionId: root.session.id, resultId: submitted.id, accept: true, review: "直属主控验收通过。" });
  await expect(result).toHaveAttribute("data-state", "accepted");
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.id === child.task.id)?.column).toBe("done");
});
