import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import type { Session, SessionItem, StateSnapshot, Task, TaskPlan, TaskResult, TaskWorkflow, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
const settled = async (sessionId: string) => {
  await expect.poll(async () => (await state()).sessions.find((s) => s.id === sessionId)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
};

test("reopening a prerequisite keeps old dependent evidence invalid until the revised dependent is accepted", async () => {
  test.setTimeout(180_000);
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("dependency-recovery") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "同一管理根的前置失效恢复" });
  const create = async (title: string, lead: boolean, managerTaskId?: string) => {
    const row = await studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id, lead, managerTaskId, firstSession: { profileId: "codex-mock", text: "登记隔离任务。" } });
    await settled(row.session.id);
    return row;
  };
  const root = await create("恢复测试总主控", true);
  const sourceLead = await create("资源二级主控", true, root.task.id);
  const targetLead = await create("实现二级主控", true, root.task.id);
  expect(sourceLead.task.managerTaskId).toBe(root.task.id);
  expect(targetLead.task.managerTaskId).toBe(root.task.id);
  const a = await create("会重开的资源", false, sourceLead.task.id);
  const submit = async (taskId: string, sessionId: string, summary: string) => {
    await settled(sessionId);
    return studio!.api<TaskResult>("POST", `/api/tasks/${taskId}/workflow/submit`, { sessionId, summary, verification: "隔离 mock Electron：真实门禁和交付持久化。" });
  };
  const accept = (manager: typeof sourceLead, result: TaskResult) => studio!.api<TaskResult>("POST", `/api/tasks/${manager.task.id}/workflow/review`, { sessionId: manager.session.id, resultId: result.id, accept: true, review: "已核对当前实际前置。" });
  const plan = async (title: string, dependsOn: string) => {
    await settled(targetLead.session.id);
    await studio!.api("POST", `/api/sessions/${targetLead.session.id}/messages`, { text: `[[mcp: task_plan_propose ${JSON.stringify({ summary: title, tasks: [{ key: title, title, dependsOn: [dependsOn], firstMessage: "只采用已验收的最新前置，完成后重新提交。" }] })}]]` });
    await expect.poll(async () => (await state()).tasks.find((t) => t.title === title)?.id, { timeout: 60_000 }).toBeTruthy();
    await settled(targetLead.session.id);
    return (await state()).tasks.find((t) => t.title === title)!;
  };
  const started = async (taskId: string) => {
    await expect.poll(async () => (await state()).sessions.find((s) => s.taskId === taskId)?.id, { timeout: 60_000 }).toBeTruthy();
    const row = (await state()).sessions.find((s) => s.taskId === taskId)!;
    await settled(row.id);
    return row;
  };
  const initialA = await accept(sourceLead, await submit(a.task.id, a.session.id, "资源初版"));
  const b = await plan("依赖资源的集成", a.task.id), bSession = await started(b.id);
  const oldB = await accept(targetLead, await submit(b.id, bSession.id, "集成初版"));
  expect(oldB.prerequisiteResultIds).toEqual([initialA.id]);
  await studio.api("PATCH", `/api/tasks/${a.task.id}`, { column: "doing" });
  const c = await plan("重验集成后的下游", b.id);
  const dispatch = (await studio.api<TaskPlan[]>("GET", "/api/task-plans")).find((p) => p.created?.some((row) => row.taskId === c.id));
  expect(dispatch).toMatchObject({ fromTaskId: targetLead.task.id, state: "accepted" });
  const stages: unknown[] = [{ stage: "downstream-plan", plan: dispatch, managementRootId: root.task.id }];
  const stillWaiting = async (stage: string) => {
    const snapshot = await state();
    const history = await studio!.api<TaskWorkflow>("GET", `/api/tasks/${targetLead.task.id}/workflow`);
    const cSessions = snapshot.sessions.filter((s) => s.taskId === c.id);
    expect(cSessions).toEqual([]);
    expect(history.results.find((r) => r.id === oldB.id)?.prerequisiteResultIds).toEqual([initialA.id]);
    await expect(studio!.page.locator(`[data-testid="task-card"][data-task-id="${c.id}"]`).getByTestId("card-waiting")).toContainText(b.title);
    stages.push({ stage, observedAt: new Date().toISOString(), cSessions, bResults: history.results.filter((r) => r.taskId === b.id) });
  };
  await stillWaiting("prerequisite-reopened");
  const revisedA = await accept(sourceLead, await submit(a.task.id, a.session.id, "资源新版"));
  expect(revisedA.id).not.toBe(initialA.id);
  await stillWaiting("prerequisite-reaccepted-only");
  await studio.api("PATCH", `/api/tasks/${b.id}`, { column: "doing" });
  const revisedB = await submit(b.id, bSession.id, "按新版资源重新集成");
  expect(revisedB.prerequisiteResultIds).toEqual([revisedA.id]);
  await stillWaiting("dependent-resubmitted-not-accepted");
  await accept(targetLead, revisedB);
  const cSession = await started(c.id);
  const items = await studio.api<SessionItem[]>("GET", `/api/sessions/${cSession.id}/items`);
  const firstInput = items.find((i) => i.type === "user" && i.text.includes("【启动时已验收的前置交付】"));
  expect(firstInput?.type === "user" && firstInput.text).toContain(revisedB.id);
  expect(firstInput?.type === "user" && firstInput.text).not.toContain(oldB.id);
  const final = await submit(c.id, cSession.id, "恢复后的下游交付");
  expect(final.prerequisiteResultIds).toEqual([revisedB.id]);
  const acceptedFinal = await accept(targetLead, final);
  expect(acceptedFinal.state).toBe("accepted");
  expect((await state()).sessions.filter((s) => s.taskId === c.id)).toHaveLength(1);
  stages.push({ stage: "downstream-recovered", sessionId: cSession.id, sessionCreatedAt: cSession.createdAt, firstInput, result: acceptedFinal });
  const evidencePath = test.info().outputPath("dependency-recovery-stages.json");
  writeFileSync(evidencePath, JSON.stringify(stages, null, 2), "utf8");
  await test.info().attach("dependency-recovery-stages", { path: evidencePath, contentType: "application/json" });
});

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
