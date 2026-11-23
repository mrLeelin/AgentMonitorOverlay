import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, TaskWorkflow, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("human-accepted root survives ordinary follow-up and real board dragging, but new child work reopens it", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("root-completion") });
  const { task, session } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "总主控：人工验收后保持完成", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: '[[mcp: task_submit_result {"summary":"已完成隔离交付","verification":"等待人工验收；普通追问不代表重新工作。"}]]' } });
  const workflow = () => studio!.api<TaskWorkflow>("GET", `/api/tasks/${task.id}/workflow`);
  const column = async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.id === task.id)?.column;
  const items = () => studio!.api<SessionItem[]>("GET", `/api/sessions/${session.id}/items`);
  await expect.poll(async () => (await workflow()).results.at(-1)?.state).toBe("submitted");
  await expect.poll(async () => (await items()).filter((i) => i.type === "turn").at(-1)?.state, { timeout: 30_000 }).toBe("completed");
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  await page.getByTestId("task-management-toggle").click();
  const result = page.getByTestId("workflow-result").last();
  await result.locator("summary").first().click();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await expect(result).toHaveAttribute("data-state", "accepted");
  const accepted = (await workflow()).results.at(-1)!;
  expect(accepted.reviewedBy).toBe("user");
  expect(await column()).toBe("done");

  const question = "那这个任务状态应该是啥，应该可以去到完成吧？";
  await page.getByRole("textbox", { name: "输入消息", exact: true }).fill(question);
  await page.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");
  await expect.poll(async () => (await items()).filter((i) => i.type === "user" && i.text.startsWith(question)).length).toBe(1);
  await expect.poll(async () => (await items()).filter((i) => i.type === "turn").at(-1)?.state, { timeout: 30_000 }).toBe("completed");
  // Cross the automatic review settle timer as well as the running/completed session events.
  await page.waitForTimeout(4500);
  expect(await column()).toBe("done");
  expect((await workflow()).results.at(-1)).toEqual(accepted);
  await expect(result).toContainText("用户已验收");
  await screenshot(app, "studio", "root-completion-followup", page);

  await page.getByTestId("back").click();
  const card = page.locator(`[data-testid="task-card"][data-task-id="${task.id}"]`);
  await card.dragTo(page.getByTestId("column-review"));
  await expect.poll(column).toBe("review");
  expect((await workflow()).results.at(-1)).toEqual(accepted);
  expect(await studio.api("POST", `/api/tasks/${task.id}/workflow/submit`, { sessionId: session.id, summary: accepted.summary, verification: accepted.verification })).toEqual(accepted);
  await card.dragTo(page.getByTestId("column-done"));
  await expect(page.getByTestId("column-done").locator(`[data-task-id="${task.id}"]`)).toBeVisible();
  expect(await column()).toBe("done");
  expect((await workflow()).results.at(-1)).toEqual(accepted);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await screenshot(app, "studio", `root-completion-drag-${theme}`, page);
  }
  await page.reload();
  await expect(page.getByTestId("column-done").locator(`[data-task-id="${task.id}"]`)).toBeVisible();
  expect((await workflow()).results.at(-1)).toEqual(accepted);
  expect(await windowState(app)).toMatchObject({ focused: false, anyFocused: false, onScreen: false });

  await studio.api("POST", "/api/tasks", { title: "新增实际工作", workspaceId: ws.id, managerTaskId: task.id });
  await expect.poll(column).toBe("doing");
  expect((await workflow()).results.at(-1)).toMatchObject({ id: accepted.id, state: "returned", userReview: accepted.userReview });
  await expect(studio.api("PATCH", `/api/tasks/${task.id}`, { column: "done" })).rejects.toThrow(/交付与验收/);
});
