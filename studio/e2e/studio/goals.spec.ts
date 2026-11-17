import { expect, test } from "@playwright/test";
import type { Session, SessionGoalState, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { startMockModel, type MockModelServer } from "@amo-studio/testkit";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
let model: MockModelServer | undefined;
const sessions: string[] = [];

test.afterEach(async () => {
  // A native Goal can continue without further HTTP input. Stop every test-owned thread before closing its Host.
  for (const id of sessions.splice(0)) {
    await studio?.api("POST", `/api/sessions/${id}/interrupt`).catch(() => undefined);
    await studio?.api("DELETE", `/api/sessions/${id}/goal`).catch(() => undefined);
  }
  await studio?.close(); studio = undefined;
  await model?.close(); model = undefined;
});

async function openTask(title: string, profileId = "codex-mock") {
  model = await startMockModel({ script: (request) => request.lastUserText === "goal-e2e-ready"
    ? { kind: "text", text: "GOAL READY" }
    : { kind: "text", text: "Goal 自动回合正在执行验证工作。".repeat(12), chunks: 30, delayMs: 100 } });
  studio = await launchStudio({ taskSidebar: false, dsh: profileId === "dsh-mock", env: { AMO_STUDIO_TEST_PROVIDER_URL: model.baseUrl } });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("goal-project") });
  const result = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, firstSession: { profileId, text: "goal-e2e-ready", options: { permission: profileId === "claude-mock" ? "bypassPermissions" : profileId === "dsh-mock" ? "full-access" : "full-auto", effort: "high" } } });
  sessions.push(result.session.id);
  await studio.page.getByTestId("task-card").filter({ hasText: title }).click();
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === result.session.id)?.status, { timeout: 60_000 }).toBe("idle");
  return result.session;
}

test("Codex Goal 从底栏开启原生自动轮，暂停、恢复、刷新和清除均同步", async () => {
  const session = await openTask("Goal 原生执行");
  const { page, app } = studio!;
  const path = `/api/sessions/${session.id}/goal`;
  const goal = () => studio!.api<SessionGoalState>("GET", path);
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  await page.getByTestId("switch-goal").click();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  await page.getByTestId("goal-objective-input").fill("检查当前项目的实现与验证结果，完成后报告证据。");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(app, "studio", "goal-create-dark", page);
  const before = model!.requests.length;
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("进行中", { timeout: 15_000 });
  await expect.poll(() => model!.requests.length).toBeGreaterThan(before);
  expect((await goal()).goal).toMatchObject({ objective: "检查当前项目的实现与验证结果，完成后报告证据。", tokenBudget: null, status: "active" });
  expect(model!.requests.at(-1)?.body.reasoning).toMatchObject({ effort: "high" });

  await page.getByTestId("goal-pause").click();
  await expect(page.getByTestId("goal-status")).toHaveText("已暂停");
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status).toBe("idle");
  const pausedRequests = model!.requests.length;
  await page.waitForTimeout(400);
  expect(model!.requests.length).toBe(pausedRequests);
  await page.getByTestId("goal-resume").click();
  await expect.poll(() => model!.requests.length).toBeGreaterThan(pausedRequests);
  await expect(page.getByTestId("switch-goal")).toContainText("进行中");
  // The existing stop API must pause Goal as well as interrupt the active native turn.
  await studio!.api("POST", `/api/sessions/${session.id}/interrupt`);
  await expect(page.getByTestId("goal-status")).toHaveText("已暂停");
  await page.reload();
  await expect(page.getByTestId("switch-goal")).toContainText("已暂停");
  await page.getByTestId("switch-goal").click();
  await expect(page.getByTestId("goal-objective")).toContainText("验证结果");

  for (const [width, theme] of [[1280, "dark"], [1280, "light"], [1000, "dark"]] as const) {
    await app.evaluate(({ BrowserWindow }, [url, size]) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.setSize(size, 900); }, [page.url(), width] as const);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const button = await page.getByTestId("switch-goal").boundingBox();
    expect(button).not.toBeNull();
    expect(button!.x).toBeGreaterThanOrEqual(0);
    expect(button!.x + button!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await screenshot(app, "studio", `goal-paused-${theme}-${width}`, page);
  }
  await page.getByTestId("goal-clear").click();
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  await expect(page.getByTestId("goal-objective-input")).toHaveValue("");
  expect((await goal()).goal).toBeNull();
});

test("原生 Goal 预算耗尽后可以提高总预算再继续", async () => {
  const session = await openTask("Goal 预算");
  const { page, app } = studio!;
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("goal-objective-input").fill("逐项检查项目并报告进展。");
  await page.getByTestId("goal-budget").fill("1");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("预算已用尽", { timeout: 30_000 });
  const old = (await studio!.api<SessionGoalState>("GET", `/api/sessions/${session.id}/goal`)).goal!;
  expect(old.tokenBudget).toBe(1);
  expect(old.tokensUsed).toBeGreaterThan(1);
  await screenshot(app, "studio", "goal-budget-limited", page);
  await page.getByTestId("goal-budget").fill(String(old.tokensUsed));
  await page.getByTestId("goal-budget-resume").click();
  await expect(page.getByTestId("goal-error")).toContainText("必须大于");
  const before = model!.requests.length;
  await page.getByTestId("goal-budget").fill(String(old.tokensUsed + 10000));
  await page.getByTestId("goal-budget-resume").click();
  await expect.poll(() => model!.requests.length).toBeGreaterThan(before);
  await expect(page.getByTestId("goal-status")).toHaveText("进行中");
  await studio!.api("POST", `/api/sessions/${session.id}/interrupt`);
  await expect(page.getByTestId("goal-status")).toHaveText("已暂停");
});

test("Goal 接口不可用和写入失败均明确显示，失败保留草稿", async () => {
  await openTask("Goal 兼容错误");
  const { page, app } = studio!;
  let legacy = true;
  await page.route("**/api/sessions/*/goal", (route) => {
    if (!legacy && route.request().method() === "GET") return route.continue();
    return route.fulfill({ status: legacy ? 404 : 500, contentType: "application/json", body: JSON.stringify({ error: { code: legacy ? "not_found" : "runtime_error", message: legacy ? "no route" : "Goal 写入失败，请重试" } }) });
  });
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("goal-tray").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByTestId("goal-unavailable")).toContainText("当前 Host 没有提供 Goal 接口");
  await expect(page.getByTestId("goal-start")).toBeDisabled();
  await screenshot(app, "studio", "goal-legacy-host", page);
  legacy = false;
  await page.getByTestId("goal-tray").getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  await page.getByTestId("goal-objective-input").fill("保留这个目标草稿");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-error")).toContainText("Goal 写入失败");
  await expect(page.getByTestId("goal-objective-input")).toHaveValue("保留这个目标草稿");
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
});

test("Claude 底栏使用原生 Goal，完成检查与清除同步且不显示 Token 预算", async () => {
  const session = await openTask("Claude Goal 完成检查", "claude-mock");
  const { page, app } = studio!;
  const path = `/api/sessions/${session.id}/goal`;
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  await page.getByTestId("switch-goal").click();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  await expect(page.getByTestId("goal-budget")).toHaveCount(0);
  await page.getByTestId("goal-objective-input").fill("检查项目并给出完成证据。");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("已完成", { timeout: 30_000 });
  const state = await studio!.api<SessionGoalState>("GET", path);
  expect(state.capabilities?.tokenBudget).toBe(false);
  expect(state.capabilities).toMatchObject({ tokens: true, elapsed: true });
  expect(state.goal).toMatchObject({ objective: "检查项目并给出完成证据。", status: "complete", tokenBudget: null });
  expect(state.goal?.iterations).toBeGreaterThanOrEqual(1);
  expect(studio!.claudeMock!.requests.some((request) => request.lastUserText.startsWith("Based on the conversation transcript above, has the following stopping condition been satisfied?"))).toBe(true);
  await expect(page.getByTestId("goal-budget")).toHaveCount(0);
  await expect(page.getByTestId("goal-iterations")).toContainText("目标检查");
  await expect(page.locator(".goal-metrics")).toContainText("Token");
  await expect(page.locator(".goal-metrics")).toContainText("累计用时");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(app, "studio", `goal-claude-complete-${theme}`, page);
  }
  await page.reload();
  await expect(page.getByTestId("switch-goal")).toContainText("已完成");
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("goal-clear").click();
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  expect((await studio!.api<SessionGoalState>("GET", path)).goal).toBeNull();
});

test("Claude Goal 原生工作回合可以暂停、继续和清除", async () => {
  const session = await openTask("Claude Goal 暂停", "claude-mock");
  const { page, app } = studio!;
  const workingCalls = () => studio!.claudeMock!.requests.filter((request) => request.tools.length && request.lastUserText.includes("[[goal-slow]]")).length;
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("goal-objective-input").fill("[[goal-slow]] 检查所有实现并报告进展。");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("进行中", { timeout: 15_000 });
  await expect.poll(workingCalls).toBeGreaterThan(0);
  await page.getByTestId("goal-pause").click();
  await expect(page.getByTestId("goal-status")).toHaveText("已暂停", { timeout: 15_000 });
  await expect.poll(async () => (await studio!.api<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === session.id)?.status).toBe("idle");
  await expect(page.getByTestId("goal-budget")).toHaveCount(0);
  await screenshot(app, "studio", "goal-claude-paused", page);
  const before = workingCalls();
  await page.getByTestId("goal-resume").click();
  await expect.poll(workingCalls, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(page.getByTestId("goal-status")).toHaveText("进行中");
  await page.getByTestId("goal-clear").click();
  await expect(page.getByTestId("switch-goal")).toContainText("未开启", { timeout: 15_000 });
  expect((await studio!.api<SessionGoalState>("GET", `/api/sessions/${session.id}/goal`)).goal).toBeNull();
});

test("Claude 原生 Goal 无法完成时显示阻碍原因", async () => {
  await openTask("Claude Goal 阻碍", "claude-mock");
  const { page, app } = studio!;
  await page.getByTestId("switch-goal").click();
  await page.getByTestId("goal-objective-input").fill("[[goal-blocked]] 使用缺失的输入完成验证。");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("遇到阻碍", { timeout: 30_000 });
  await expect(page.getByTestId("goal-reason")).toContainText("required input");
  await expect(page.getByTestId("goal-iterations")).toBeVisible();
  await screenshot(app, "studio", "goal-claude-blocked", page);
});

test("DSH 底栏通过 Goal 桥接创建、暂停、恢复和清除（隔离 ACP bridge mock）", async () => {
  const session = await openTask("DSH Goal 桥接", "dsh-mock");
  const { page, app } = studio!;
  const path = `/api/sessions/${session.id}/goal`;
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  await page.getByTestId("switch-goal").click();
  await expect(page.getByTestId("goal-objective-input")).toBeEnabled();
  await expect(page.getByLabel("Token 预算（可选）")).toHaveCount(0);
  await expect(page.getByLabel("续跑轮数上限（可选）")).toBeVisible();
  await page.getByTestId("goal-budget").fill("3");
  await page.getByTestId("goal-objective-input").fill("检查工作区并逐轮报告完成情况。");
  await page.getByTestId("goal-start").click();
  await expect(page.getByTestId("goal-status")).toHaveText("进行中", { timeout: 15_000 });
  const active = await studio!.api<SessionGoalState>("GET", path);
  expect(active.capabilities).toMatchObject({ tokenBudget: false, tokens: false, elapsed: false, roundBudget: true });
  expect(active.goal).toMatchObject({ objective: "检查工作区并逐轮报告完成情况。", status: "active", roundBudget: 3 });
  await expect(page.getByTestId("goal-iterations")).toContainText("/ 3 轮");
  await expect(page.locator(".goal-metrics").filter({ hasText: "Token" })).toHaveCount(0);
  await page.getByTestId("goal-pause").click();
  await expect(page.getByTestId("goal-status")).toHaveText("已暂停");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(app, "studio", `goal-dsh-paused-${theme}`, page);
  }
  await page.getByTestId("goal-resume").click();
  await expect(page.getByTestId("goal-status")).toHaveText("进行中");
  await page.getByTestId("goal-clear").click();
  await expect(page.getByTestId("switch-goal")).toContainText("未开启");
  expect((await studio!.api<SessionGoalState>("GET", path)).goal).toBeNull();
});
