import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, TaskPlan, TaskResult, TaskWorkflow, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
const settled = async (sessionId: string) => {
  await expect.poll(async () => (await state()).sessions.find((s) => s.id === sessionId)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
};

test("a coordinator waits for another lead's prerequisite, accepts its dependent children and delivers up to human review", async () => {
  test.setTimeout(180_000);
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("managed-dependencies") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "中控与任务依赖回归" });
  const create = async (title: string, lead: boolean, managerTaskId?: string) => {
    const created = await studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, lead, managerTaskId, firstSession: { profileId: "codex-mock", text: "登记隔离验证任务，等待明确派工或交付。" } });
    await settled(created.session.id);
    return created;
  };
  const assetsLead = await create("资源总主控", true);
  const root = await create("实现总主控", true);
  const coordinator = await create("实现中控", true, root.task.id);
  const prerequisite = await create("前置资源", false, assetsLead.task.id);
  const proposal = { summary: "资源验收后实现，实现验收后检查", tasks: [
    { key: "implementation", title: "依赖资源的实现子任务", dependsOn: [prerequisite.task.id], firstMessage: "根据已验收资源实现功能。" },
    { key: "check", title: "依赖实现的检查子任务", dependsOn: ["implementation"], firstMessage: "根据实现交付检查行为。" },
  ] };
  await studio.api("POST", `/api/sessions/${coordinator.session.id}/messages`, { text: `[[mcp: task_plan_propose ${JSON.stringify(proposal)}]]` });
  await expect.poll(async () => (await studio!.api<TaskPlan[]>("GET", "/api/task-plans")).find((p) => p.fromTaskId === coordinator.task.id)?.state, { timeout: 60_000 }).toBe("accepted");
  const planned = await state();
  const implementation = planned.tasks.find((t) => t.title === "依赖资源的实现子任务")!;
  const check = planned.tasks.find((t) => t.title === "依赖实现的检查子任务")!;
  expect(implementation.managerTaskId).toBe(coordinator.task.id);
  expect(check.managerTaskId).toBe(coordinator.task.id);
  expect(planned.sessions.some((s) => s.taskId === implementation.id || s.taskId === check.id)).toBe(false);
  const card = page.locator(`[data-testid="task-card"][data-task-id="${implementation.id}"]`);
  await expect(card.getByTestId("card-waiting")).toContainText("前置资源");

  const submit = async (task: Task, sessionId: string) => {
    await settled(sessionId);
    return studio!.api<TaskResult>("POST", `/api/tasks/${task.id}/workflow/submit`, { sessionId, summary: `${task.title}交付`, verification: "隔离验证依赖、当前归属、交付与验收链路。" });
  };
  const accept = (manager: { task: Task; session: Session }, result: TaskResult) => studio!.api<TaskResult>("POST", `/api/tasks/${manager.task.id}/workflow/review`, { sessionId: manager.session.id, resultId: result.id, accept: true, review: "已对照真实前置及验证证据，验收通过。" });
  const started = async (task: Task) => {
    await expect.poll(async () => (await state()).sessions.find((s) => s.taskId === task.id)?.id, { timeout: 60_000 }).toBeTruthy();
    const session = (await state()).sessions.find((s) => s.taskId === task.id)!;
    await settled(session.id);
    return session;
  };
  const preResult = await submit(prerequisite.task, prerequisite.session.id);
  await accept(assetsLead, preResult);
  const implementationSession = await started(implementation);
  await expect(card.getByTestId("card-waiting")).toHaveCount(0);
  expect((await state()).sessions.some((s) => s.taskId === check.id)).toBe(false);
  const input = await studio.api<SessionItem[]>("GET", `/api/sessions/${implementationSession.id}/items`);
  expect(input.some((i) => i.type === "user" && i.text.includes(preResult.id))).toBe(true);

  // This acceptance used to reject a valid input from the other root, permanently blocking the rest of the chain.
  const implementationResult = await submit(implementation, implementationSession.id);
  expect(implementationResult.prerequisiteResultIds).toEqual([preResult.id]);
  expect(implementationResult.contextMismatch).toBeUndefined();
  await accept(coordinator, implementationResult);
  const checkSession = await started(check);
  const checkResult = await submit(check, checkSession.id);
  expect(checkResult.prerequisiteResultIds).toEqual([implementationResult.id]);
  await accept(coordinator, checkResult);

  // A domain coordinator delivers to its own manager, and the root still waits for the person's explicit acceptance.
  const coordinatorResult = await submit(coordinator.task, coordinator.session.id);
  await accept(root, coordinatorResult);
  const rootResult = await submit(root.task, root.session.id);
  expect(rootResult.state).toBe("submitted");
  expect((await state()).tasks.find((t) => t.id === root.task.id)?.column).toBe("review");
  await page.locator(`[data-testid="task-card"][data-task-id="${root.task.id}"]`).click();
  await page.getByTestId("task-management-toggle").click();
  const delivery = page.getByTestId("workflow-result").filter({ hasText: coordinatorResult.summary });
  await expect(delivery).toHaveAttribute("data-state", "accepted");
  await screenshot(app, "studio", "managed-dependencies-reviewed", page);
  const accepted = await studio.api<TaskResult>("POST", `/api/tasks/${root.task.id}/workflow/user-review`, { resultId: rootResult.id, accept: true, review: "用户验收完整中控及依赖子任务交付。" });
  expect(accepted.state).toBe("accepted");
  expect((await state()).tasks.find((t) => t.id === root.task.id)?.column).toBe("done");
  const workflow = await studio.api<TaskWorkflow>("GET", `/api/tasks/${root.task.id}/workflow`);
  expect(workflow.results.filter((r) => r.state === "accepted").map((r) => r.id)).toEqual(expect.arrayContaining([rootResult.id, coordinatorResult.id, implementationResult.id, checkResult.id]));
});
