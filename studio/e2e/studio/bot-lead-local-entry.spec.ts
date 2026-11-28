import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { BotLeadOperationReceipt, BotLeadTerm, CanvasDoc, Session, Task, Topic } from "@amo-studio/protocol";
import { capture, createBot, evidence, firstSession, holdRequest, items, leadState, otherWindow, project, requestById, snapshot, workbench } from "../support/bot-lead-local.js";
import { launchStudio, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const requestId = "stage-one-completed-request";
const requestText = "核对临时仓库的示例清单";
const leadTitle = "带队核对示例清单";
const requestRow = (page: Page) => page.getByTestId("bot-request").filter({ hasText: requestText });
const canvasCard = (page: Page, title: string) => page.getByTestId("canvas-card").filter({ hasText: title });
const originalLink = (page: Page) => requestRow(page).getByRole("button", { name: "打开专题画布", exact: true });

async function reopenOriginalRequest(own: Studio) {
  const goBack = own.page.getByRole("button", { name: "返回 Bots", exact: true });
  if (await goBack.isVisible()) await goBack.click();
  else if (!await originalLink(own.page).isVisible()) await workbench(own.page);
  await expect(originalLink(own.page)).toBeVisible();
}

async function completedRequest(own: Studio) {
  const ws = await project(own, "source-repository");
  const bot = await createBot(own, ws, "清单机器人");
  await own.api("POST", `/api/bots/${bot.id}/requests`, { id: requestId, text: requestText });
  await expect.poll(async () => (await requestById(own, requestId))?.status, { timeout: 25_000 }).toBe("completed");
  return { ws, bot };
}

async function prepareAppointment(page: Page) {
  await requestRow(page).getByRole("button", { name: "让清单机器人带队", exact: true }).click();
  const form = page.getByTestId("lead-appointment");
  await form.getByLabel("交付目标", { exact: true }).fill(leadTitle);
  await form.getByLabel("新专题名称", { exact: true }).fill("清单验收专题");
  return form.getByRole("button", { name: "任命机器人", exact: true });
}

for (const winner of ["create", "worker"] as const) {
  test(`two renderers contend for one completed Bot request, ${winner} wins`, async ({}, info) => {
    studio = await launchStudio();
    const own = studio;
    const { ws } = await completedRequest(own);
    const main = own.page;
    const second = await otherWindow(own);
    await Promise.all([workbench(main), workbench(second)]);
    const starting = await prepareAppointment(main);
    const workerButton = requestRow(second).getByRole("button", { name: "在独立工作树开始执行", exact: true });
    const before = await snapshot(own);
    const leadPath = "/api/bot-leads/appointments";
    const workerPath = `/api/bot-requests/${requestId}/worker`;
    const leadGate = holdRequest(main, leadPath);
    const workerGate = holdRequest(second, workerPath);
    await Promise.all([leadGate.installed, workerGate.installed]);
    second.once("dialog", (dialog) => void dialog.accept());
    const leadResponse = main.waitForResponse((response) => new URL(response.url()).pathname === leadPath && response.request().method() === "POST");
    const workerResponse = second.waitForResponse((response) => new URL(response.url()).pathname === workerPath && response.request().method() === "POST");
    await Promise.all([starting.dblclick(), workerButton.click()]);
    const [lead, worker] = await Promise.all([leadGate.arrived, workerGate.arrived]);
    const leadInput = lead.request().postDataJSON();
    const workerInput = worker.request().postDataJSON();
    expect(leadInput.source).toEqual({ kind: "bot-request", requestId });
    expect(leadInput.operationId).not.toBe(workerInput.operationId);
    expect((await requestById(own, requestId))?.acceptance).toBeFalsy();
    // Both clicks occurred against stale, unclaimed UI state. Control arrival order, keeping each Host response real.
    if (winner === "create") {
      await lead.continue();
      try { expect((await leadResponse).ok()).toBe(true); }
      finally { await worker.continue(); }
      expect((await workerResponse).status()).toBe(409);
    } else {
      await worker.continue();
      try { expect((await workerResponse).ok()).toBe(true); }
      finally { await lead.continue(); }
      expect((await leadResponse).ok()).toBe(true);
    }
    const accepted = (await requestById(own, requestId))!.acceptance!;
    expect(accepted.action).toBe(winner);
    const after = await snapshot(own);
    expect(after.tasks.filter((task) => !before.tasks.some((entry) => entry.id === task.id)).map((task) => task.id)).toEqual([accepted.taskId]);
    if (winner === "create") {
      expect(after.topics.filter((topic) => !before.topics.some((entry) => entry.id === topic.id)).map((topic) => topic.id)).toEqual([accepted.topicId]);
      const doc = await own.api<CanvasDoc>("GET", `/api/topics/${accepted.topicId}/canvas`);
      expect(doc.nodes.filter((node) => node.kind === "task").map((node) => node.taskId)).toEqual([accepted.taskId]);
      await expect(canvasCard(second, leadTitle)).toHaveClass(/selected/);
      await requestRow(main).getByRole("button", { name: "打开专题画布", exact: true }).click();
      await expect(canvasCard(main, leadTitle)).toHaveClass(/selected/);
      expect(await own.api("GET", `/api/topics/${accepted.topicId}/canvas`)).toEqual(doc);
    } else {
      expect(after.topics).toEqual(before.topics);
      await expect(main.getByTestId("task-title")).toContainText(requestText);
      await expect(second.getByTestId("task-title")).toContainText(requestText);
      await expect.poll(async () => (await snapshot(own)).sessions.find((session) => session.taskId === accepted.taskId)?.cwd).toBeTruthy();
      const session = await firstSession(own, accepted.taskId);
      expect(session.cwd).not.toBe(ws.path);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: session.cwd, windowsHide: true, encoding: "utf8" }).trim();
      expect(git("show", "HEAD:sample.txt")).toBe("lark\ntern");
      expect(git("rev-parse", "--git-dir")).toContain("/worktrees/");
    }
    await evidence(info, "same-source-receipt", { winner, accepted, leadInput, workerInput, leadStatus: (await leadResponse).status(), workerStatus: (await workerResponse).status() });
  });
}

test("a missing Codex executable retains the first appointment and original Bot link across isolated restarts", async ({}, info) => {
  studio = await launchStudio();
  await completedRequest(studio);
  const root = studio.root;
  await studio.close({ keepData: true });
  studio = undefined;
  studio = await launchStudio({ root, env: { AMO_STUDIO_CODEX: join(root, "absent-codex.exe") } });
  const { page } = studio;
  await workbench(page);
  const confirm = await prepareAppointment(page);
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/bot-leads/appointments" && value.request().method() === "POST");
  const requestedAt = performance.now();
  await confirm.dblclick();
  const receipt = await (await response).json() as BotLeadOperationReceipt;
  expect(receipt).toMatchObject({ action: "create", state: { kind: "appointed", term: { runState: "pending" } } });
  if (receipt.action !== "create" || receipt.state.kind !== "appointed") throw new Error("Expected a new appointment receipt");
  const termId = receipt.state.term.termId;
  const view = () => leadState(studio!, receipt.taskId);
  const path = `/api/topics/${receipt.topicId}/canvas`;
  await originalLink(page).click();
  await expect(canvasCard(page, leadTitle)).toHaveClass(/selected/);
  const doc = await studio.api<CanvasDoc>("GET", path);
  expect(doc.nodes.filter((node) => node.kind === "task").map((node) => node.taskId)).toEqual([receipt.taskId]);
  await expect(page.getByTestId("canvas-detail")).toContainText("主控启动失败", { timeout: 12_000 });
  const failureVisibleMs = Math.round(performance.now() - requestedAt);
  const failed = (await view()).state;
  expect(failed).toMatchObject({ kind: "appointed", term: { termId, runState: "failed", reason: expect.stringMatching(/ENOENT.*找不到可执行文件/) } });
  const attempted = (await snapshot(studio)).sessions.filter((session) => session.taskId === receipt.taskId);
  for (const session of attempted) expect((await items(studio, session.id)).filter((item) => item.type === "turn")).toHaveLength(0);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await capture(studio, info, "bot-lead-e2e-start-failure-dark");
  const startupLog = readFileSync(join(studio.dataDir, "host.log"), "utf8").split(/\r?\n/).filter((line) => /ENOENT|during startup|became ready/.test(line));
  expect(startupLog.join("\n")).not.toMatch(/uncaught exception.*ENOENT/);
  await studio.close({ keepData: true });
  studio = undefined;

  studio = await launchStudio({ root });
  const reopened = studio.page;
  await reopenOriginalRequest(studio);
  expect((await requestById(studio, requestId))?.acceptance).toEqual(receipt);
  await originalLink(reopened).click();
  await expect(canvasCard(reopened, leadTitle)).toHaveClass(/selected/);
  await reopened.getByRole("button", { name: "重试启动", exact: true }).dblclick();
  const session = await firstSession(studio, receipt.taskId);
  const own = studio;
  await expect.poll(async () => (await items(own, session.id)).some((item) => item.type === "turn" && item.state === "completed"), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => (await view()).state).toMatchObject({ kind: "appointed", term: { termId, sessionId: session.id, runState: "idle" } });
  expect((await items(own, session.id)).filter((item) => item.type === "turn")).toHaveLength(1);
  expect(await own.api("GET", path)).toEqual(doc);
  await evidence(info, "startup-receipt", { receipt, failed, failureVisibleMs, attempted, resumed: (await view()).state, canvas: doc, startupLog });
});

test("closing the isolated app before its first model turn preserves the Bot receipt and formal card", async ({}, info) => {
  studio = await launchStudio();
  await completedRequest(studio);
  const root = studio.root;
  const startingProgram = join(root, "hold-codex-start.js");
  const marker = join(root, "codex-launch-attempted");
  // Stay alive without opening the app-server socket. Studio ends this isolated child with its Host.
  writeFileSync(startingProgram, `if (process.argv[2] === "app-server") { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "starting"); setInterval(() => {}, 60000); }\n`, "utf8");
  await studio.close({ keepData: true });
  studio = undefined;
  studio = await launchStudio({ root, env: { AMO_STUDIO_CODEX: startingProgram } });
  const { page } = studio;
  await workbench(page);
  const confirm = await prepareAppointment(page);
  await confirm.click();
  await expect(originalLink(page)).toBeVisible();
  const receipt = (await requestById(studio, requestId))!.acceptance!;
  if (receipt.action !== "create" || receipt.state.kind !== "appointed") throw new Error("Expected a new appointment receipt");
  const termId = receipt.state.term.termId;
  await originalLink(page).click();
  await expect(canvasCard(page, leadTitle)).toHaveClass(/selected/);
  await expect.poll(() => existsSync(marker)).toBe(true);
  await expect(page.getByTestId("canvas-detail")).toContainText("等待主控启动");
  expect((await snapshot(studio)).sessions.filter((session) => session.taskId === receipt.taskId)).toHaveLength(0);
  const path = `/api/topics/${receipt.topicId}/canvas`;
  const initial = await studio.api<CanvasDoc>("GET", path);
  expect(initial.nodes.filter((node) => node.kind === "task").map((node) => node.taskId)).toEqual([receipt.taskId]);
  await capture(studio, info, "bot-lead-e2e-pending-start");
  await studio.close({ keepData: true });
  studio = undefined;

  studio = await launchStudio({ root });
  const own = studio;
  await reopenOriginalRequest(own);
  await originalLink(own.page).click();
  await expect(canvasCard(own.page, leadTitle)).toHaveClass(/selected/);
  const recovered = (await leadState(own, receipt.taskId)).state;
  const retry = own.page.getByRole("button", { name: "重试启动", exact: true });
  if (recovered?.kind === "appointed" && (recovered.term.runState === "failed" || recovered.term.runState === "needs-reconciliation")) await retry.click();
  const session = await firstSession(own, receipt.taskId);
  await expect.poll(async () => (await items(own, session.id)).filter((item) => item.type === "turn").map((item) => item.state), { timeout: 30_000 }).toEqual(["completed"]);
  expect((await requestById(own, requestId))?.acceptance).toEqual(receipt);
  await expect.poll(async () => (await leadState(own, receipt.taskId)).state).toMatchObject({ kind: "appointed", term: { termId, sessionId: session.id, runState: "idle" } });
  expect((await snapshot(own)).sessions.filter((item) => item.taskId === receipt.taskId).map((item) => item.id)).toEqual([session.id]);
  expect(await own.api("GET", path)).toEqual(initial);
  await evidence(info, "interrupted-startup", { receipt, beforeLaunch: { sessions: 0, canvas: initial }, reopenedState: recovered, sessionId: session.id, afterLaunch: (await leadState(own, receipt.taskId)).state });
});

test("a running ordinary task waits for its turn before upgrading the same formal card", async ({}, info) => {
  studio = await launchStudio();
  const own = studio;
  const { page } = own;
  const ws = await project(own, "upgrade-project");
  const topic = await own.api<Topic>("POST", "/api/topics", { title: "原清单专题", workspaceIds: [ws.id] });
  const bot = await createBot(own, ws, "验收机器人");
  const parentBot = await createBot(own, ws, "原直属主控机器人");
  const parent = await own.api<BotLeadOperationReceipt>("POST", "/api/bot-leads/appointments", { operationId: "upgrade-original-parent", source: { kind: "manual" }, intent: "create", workspaceId: ws.id, title: "原直属主控", topic: { topicId: topic.id }, botId: parentBot.id });
  const title = "原执行任务";
  const initial = await own.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, description: "保留原清单与改动。", workspaceId: ws.id, topicId: topic.id, managerTaskId: parent.taskId, worktree: {},
    firstSession: { profileId: "codex-mock", text: "[[slow]] 保留执行上下文，完成后等待人工升级。" } });
  const originalCwd = initial.session.cwd;
  if (!originalCwd) throw new Error("Expected an independent worktree in the original session");
  const withinFixture = relative(own.root, originalCwd);
  if (!withinFixture || withinFixture.startsWith("..") || isAbsolute(withinFixture) || originalCwd === ws.path) throw new Error("Expected an independent worktree inside the test directory");
  writeFileSync(join(originalCwd, "draft.txt"), "uncommitted fixture", "utf8");
  await page.getByTestId(`scope-topic-${topic.title}`).click();
  await page.getByTestId("task-card").filter({ hasText: title }).click();
  await page.getByTestId("task-more").click();
  await page.getByRole("menuitem", { name: "请机器人带队…", exact: true }).click();
  const form = page.getByTestId("lead-appointment");
  await expect(form.getByLabel("交接说明、未决问题与证据")).toHaveValue(/保留原清单与改动/);
  await form.getByRole("combobox", { name: "负责机器人", exact: true }).selectOption(bot.id);
  await form.getByRole("button", { name: "任命机器人", exact: true }).click();
  const trace = (await leadState(own, initial.task.id)).state;
  expect(trace).toMatchObject({ kind: "pending-upgrade", botId: bot.id, blockers: [{ kind: "turn", sessionId: initial.session.id }] });
  await expect(page.getByRole("button", { name: /等待当前回合结束/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消此次切换", exact: true })).toBeVisible();
  await expect.poll(async () => (await leadState(own, initial.task.id)).state, { timeout: 30_000 }).toMatchObject({ kind: "appointed", term: { botId: bot.id } });
  const after = await snapshot(own);
  const upgraded = after.tasks.find((task) => task.id === initial.task.id)!;
  expect(upgraded).toMatchObject({ id: initial.task.id, topicId: topic.id, workspaceId: ws.id, lead: true });
  expect(upgraded.managerTaskId).toBe(parent.taskId);
  const historical = after.sessions.find((session) => session.id === initial.session.id)!;
  expect(historical.archivedAt).toBeTruthy();
  expect(historical.cwd).toBe(originalCwd);
  const active = await firstSession(own, upgraded.id);
  expect(active.id).not.toBe(initial.session.id);
  expect(active.options.permission).toBe("read-only");
  const state = (await leadState(own, upgraded.id)).state;
  if (state?.kind !== "appointed") throw new Error("Expected upgrade to create a stable term");
  const term = await own.api<BotLeadTerm>("GET", `/api/tasks/${upgraded.id}/bot-lead/terms/${state.term.termId}`);
  expect(term.handoff).toContain(originalCwd);
  expect(term.handoff).toContain(initial.session.id);
  expect(term.handoff).toContain("?? draft.txt");
  await page.getByRole("button", { name: "在专题画布定位", exact: true }).click();
  await expect(canvasCard(page, title)).toHaveClass(/selected/);
  const canvas = await own.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  expect(canvas.nodes.filter((node) => node.kind === "task").map((node) => node.taskId)).toEqual([parent.taskId, upgraded.id]);
  await evidence(info, "upgrade-handoff", { trace, original: initial.task, historical, upgraded, active, term, canvas });
});
