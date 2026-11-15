import { expect, test } from "@playwright/test";
import type { DecisionRequest, Session, SessionItem, StateSnapshot, Task, TaskResult, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("coordinator progress stays local while formal delivery still wakes the upstream lead", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("coordinator-progress") });
  const create = (title: string, managerTaskId?: string) => studio!.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, lead: true, managerTaskId, firstSession: { profileId: "codex-mock", text: "已派工，等待下级交付。" } });
  const items = (id: string) => studio!.api<SessionItem[]>("GET", `/api/sessions/${id}/items`);
  const settled = async (id: string, turns: number) => {
    await expect.poll(async () => (await items(id)).filter((i) => i.type === "turn" && i.state === "completed").length).toBe(turns);
    await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === id)?.status).toMatch(/idle|completed/);
  };
  const top = await create("总主控");
  await settled(top.session.id, 1);
  for (const title of ["开发主控", "测试主控"]) {
    const middle = await create(title, top.task.id);
    await settled(middle.session.id, 1);
    for (let turn = 2; turn <= 3; turn++) {
      await studio.api("POST", `/api/sessions/${middle.session.id}/messages`, { text: "普通进度：继续等下级交付。" });
      await settled(middle.session.id, turn);
    }
    expect((await items(middle.session.id)).filter((i) => i.type === "agent")).toHaveLength(3);
  }
  // Give an erroneous automatic dispatch time to start its extra turn before checking absence.
  await studio.page.waitForTimeout(1000);
  expect((await items(top.session.id)).filter((i) => i.type === "turn")).toHaveLength(1);
  expect((await items(top.session.id)).filter((i) => i.type === "user" && i.text.includes("【下级任务本轮状态】"))).toHaveLength(0);
  const middle = (await studio.api<StateSnapshot>("GET", "/api/state")).tasks.find((t) => t.title === "开发主控")!;
  const middleSession = (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.taskId === middle.id)!;
  const result = await studio.api<TaskResult>("POST", `/api/tasks/${middle.id}/workflow/submit`, { sessionId: middleSession.id, summary: "开发交付", verification: "隔离验证通过" });
  await settled(top.session.id, 2);
  expect((await items(top.session.id)).some((i) => i.type === "user" && i.text.includes(result.id))).toBe(true);
});

test("a new lead is the single contact and sees delegated deliveries for review", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("managed-workflow") });
  await expect(page.getByTestId(`scope-ws-${ws.name}`)).toBeVisible();
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目" }).getByRole("button", { name: ws.name, exact: true }).click();
  await page.getByTestId("draft-lead").check();
  await expect(page.getByTestId("draft-lead-permission")).toContainText("主控只读项目");
  await page.getByLabel("第一句话").fill("投币小游戏总主控：组织资源、音效与逻辑负责人，验收后汇总交付。");
  await screenshot(app, "studio", "managed-workflow-new-lead", page);
  await page.getByTestId("draft-start").click();
  await expect(page.getByTestId("task-lead")).toBeVisible();
  await expect(page.getByTestId("msg-agent")).toBeVisible({ timeout: 30_000 });
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const root = state.tasks.find((t) => t.lead)!;
  const rootSession = state.sessions.find((s) => s.taskId === root.id)!;
  expect(rootSession.options.permission).toBe("read-only");
  const profileId = rootSession.profileId;
  const sound = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "音效负责人", workspaceId: ws.id, managerTaskId: root.id, lead: true, firstSession: { profileId, text: "音效负责人，仅登记教学用交付。" } });
  const worker = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "投币音效", workspaceId: ws.id, managerTaskId: sound.task.id, firstSession: { profileId, text: "教学用交付：一声投币提示音，完成验证后交给音效负责人。" } });
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === worker.session.id)?.status).toMatch(/idle|completed/);
  const result = await studio.api<TaskResult>("POST", `/api/tasks/${worker.task.id}/workflow/submit`, { sessionId: worker.session.id, summary: "已准备投币提示音", verification: "教学验证：确认音效名称、触发时机及播放次数。" });
  await page.getByTestId("task-management-toggle").click();
  await expect(page.getByTestId("task-workflow")).toBeVisible();
  await expect(page.getByTestId("task-management")).toContainText("音效负责人");
  const delivery = page.getByTestId("workflow-result").filter({ hasText: "投币音效" });
  await expect(delivery).toHaveAttribute("data-state", "submitted");
  await delivery.locator("summary").first().click();
  await expect(delivery).toContainText("教学验证");
  await delivery.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "managed-workflow-submitted", page);
  await studio.api("POST", `/api/tasks/${sound.task.id}/workflow/review`, { sessionId: sound.session.id, resultId: result.id, accept: true, review: "投币音效命名与触发约定通过。" });
  await expect(delivery).toHaveAttribute("data-state", "accepted");
  await expect(delivery).toContainText("投币音效命名与触发约定通过");
  await delivery.scrollIntoViewIfNeeded();
  await screenshot(app, "studio", "managed-workflow-accepted", page);
});

test("routed business questions wait with the manager while unrelated person decisions stay visible", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("managed-decisions") });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "游戏总主控", workspaceId: ws.id, lead: true, firstSession: { profileId: "codex-mock", text: "整理音效任务的业务问题。" } });
  const worker = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "音效制作", workspaceId: ws.id, managerTaskId: root.task.id, firstSession: { profileId: "codex-mock", text: '[[mcp: decision_request {"question":"投币音效用Q版还是写实？","options":["Q版","写实"]}]]' } });
  const decisions = () => studio!.api<DecisionRequest[]>("GET", "/api/decisions?state=open");
  await expect.poll(async () => (await decisions()).find((d) => d.taskId === worker.task.id)?.routedToTaskId, { timeout: 60_000 }).toBe(root.task.id);
  const child = page.getByTestId("task-card").filter({ hasText: "音效制作" });
  await expect(child.getByTestId("card-asks")).toHaveCount(0);
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
  await page.getByTestId("task-card").filter({ hasText: "游戏总主控" }).click();
  await page.getByTestId("task-management-toggle").click();
  await expect(page.getByTestId("workflow-decision")).toContainText("投币音效用Q版还是写实？");
  await expect(page.getByTestId("question-popup")).toHaveCount(0);
  await screenshot(app, "studio", "managed-workflow-business-question", page);
  const opened = app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-decision")).toHaveCount(0);
  await studio.api("POST", "/api/tasks", { title: "独立需求确认", workspaceId: ws.id, firstSession: { profileId: "codex-mock", text: '[[mcp: decision_request {"question":"独立任务需要用户决定是否导出？","options":["导出","保留"]}]]' } });
  await expect(focus.getByTestId("focus-decision")).toHaveCount(1);
  await expect(focus.getByTestId("focus-decision")).toContainText("独立任务需要用户决定是否导出？");
  await expect(focus.getByTestId("focus-decision")).not.toContainText("投币音效用Q版还是写实？");
  await screenshot(app, "studio", "managed-workflow-focus-routed", focus, "focus");
});
