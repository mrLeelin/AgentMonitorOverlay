/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import type { BotLeadOperationReceipt, Session, Topic } from "@amo-studio/protocol";
import { capture, createBot, evidence, firstSession, items, project, resultIn, snapshot, submitMessage, workflow } from "../support/bot-lead-local.js";
import { seedCanvasPerformance } from "../support/canvas-performance.js";
import { launchStudio } from "../support/studio.js";

test("keeps managed dependencies navigable by keyboard in both themes on a narrow canvas", async ({}, info) => {
  const studio = await launchStudio();
  const { app, page } = studio;
  try {
    const fixture = await seedCanvasPerformance(studio, 2);
    await page.getByTestId(`scope-topic-${fixture.topic.title}`).click();
    await page.getByRole("button", { name: "画布", exact: true }).click();
    await expect(page.getByTestId("canvas-management-line")).toHaveCount(18);
    await expect(page.getByTestId("canvas-edge")).toHaveCount(6);

    const management = page.getByRole("checkbox", { name: /管理.*虚线/ });
    const dependency = page.getByRole("checkbox", { name: /依赖.*实线/ });
    await management.press("Space");
    await expect(page.getByTestId("canvas-management-line")).toHaveCount(0);
    await expect(page.getByTestId("canvas-edge")).toHaveCount(6);
    await management.press("Space");
    await dependency.press("Space");
    await expect(page.getByTestId("canvas-management-line")).toHaveCount(18);
    await expect(page.getByTestId("canvas-edge")).toHaveCount(0);
    await dependency.press("Space");
    await expect(page.getByTestId("canvas-edge")).toHaveCount(6);

    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)!.setSize(960, 850), page.url());
    const list = page.getByRole("region", { name: "专题任务列表" });
    await expect(list).toBeVisible();
    const downstream = list.getByRole("button", { name: "性能执行 0-0-1", exact: true });
    const upstream = list.getByRole("button", { name: "性能执行 0-0-0", exact: true });
    const detail = page.getByTestId("canvas-detail");
    const viewports = [];
    for (const theme of ["light", "dark"]) {
      await page.evaluate((next) => document.documentElement.setAttribute("data-theme", next), theme);
      await downstream.press("Enter");
      await expect(downstream).toHaveAttribute("aria-pressed", "true");
      const prerequisite = detail.getByTestId("dependency").getByRole("button", { name: "性能执行 0-0-0", exact: true });
      await expect(prerequisite).toBeVisible();
      await capture(studio, info, `bot-lead-integration-narrow-${theme}`);
      await prerequisite.press("Enter");
      await expect(upstream).toHaveAttribute("aria-pressed", "true");
      const viewport = await list.evaluate((region) => ({
        theme: document.documentElement.getAttribute("data-theme"),
        width: window.innerWidth,
        height: window.innerHeight,
        listHeight: region.clientHeight,
        scrollHeight: region.scrollHeight,
      }));
      expect(viewport.theme).toBe(theme);
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.listHeight);
      viewports.push(viewport);
    }
    expect(await fixture.readCanvas()).toEqual(fixture.saved);
    await evidence(info, "narrow-canvas", { viewports, managementLines: 18, dependencyLines: 6, unchangedVersion: fixture.saved.version });
  } finally {
    await studio.close();
  }
});

test("keeps one Bot's dispatches, decisions and reviews separate after resetting its main chat", async ({}, info) => {
  const studio = await launchStudio();
  try {
    const workspace = await project(studio, "shared-bot-scopes");
    const bot = await createBot(studio, workspace, "两专题共用机器人");
    const homePath = `/api/bots/${bot.id}/home`;
    const oldHome = await studio.api<Session>("POST", homePath, {});
    const command = (tool: string, args: object) => `[[mcp: ${tool} ${JSON.stringify(args)}]]`;
    const roots = [];
    for (const name of ["甲", "乙"]) {
      const topic = await studio.api<Topic>("POST", "/api/topics", { title: `复核专题${name}`, workspaceIds: [workspace.id] });
      const root = await studio.api<BotLeadOperationReceipt>("POST", "/api/bot-leads/appointments", {
        operationId: `scope-root-${name}`, source: { kind: "manual" }, intent: "create", workspaceId: workspace.id,
        title: `复核目标${name}`, topic: { topicId: topic.id }, botId: bot.id, firstMessage: "等待测试派工。",
      });
      roots.push({ name, taskId: root.taskId, session: await firstSession(studio, root.taskId) });
    }
    const newHome = await studio.api<Session>("POST", homePath, { reset: true });
    expect(newHome.id).not.toBe(oldHome.id);

    const pending = [];
    for (const root of roots) {
      expect((await firstSession(studio, root.taskId)).id).toBe(root.session.id);
      const title = `复核执行${root.name}`;
      await submitMessage(studio, root.session.id, command("task_plan_propose", {
        summary: title, operationKey: "dispatch-one", tasks: [{ key: "worker", title, firstMessage: "等待测试验收。", execution: { kind: "project" } }],
      }));
      const children = async () => (await snapshot(studio)).tasks.filter((task) => task.managerTaskId === root.taskId);
      await expect.poll(async () => (await children()).map((task) => task.title), { timeout: 25_000 }).toEqual([title]);
      const child = (await children())[0]!;
      const worker = await firstSession(studio, child.id);
      const question = `是否采纳${root.name}专题的证据？`;
      await submitMessage(studio, worker.id, command("decision_request", { question }));
      await expect.poll(async () => (await workflow(studio, root.taskId)).decisions.map((decision) => decision.question), { timeout: 25_000 }).toEqual([question]);
      const decision = (await workflow(studio, root.taskId)).decisions[0]!;
      expect(decision).toMatchObject({ sessionId: worker.id, routedToTaskId: root.taskId });
      pending.push({ root, title, worker, child, decision });
    }
    for (const { root, decision } of pending) {
      expect((await workflow(studio, root.taskId)).decisions.map((item) => item.id)).toEqual([decision.id]);
    }

    const branches = [];
    for (const { root, title, worker, child, decision } of pending) {
      const answer = `同意${root.name}专题的证据。`;
      await submitMessage(studio, root.session.id, command("task_decision_answer", { decisionId: decision.id, answer }));
      await expect.poll(async () => (await items(studio, worker.id)).filter((item) => item.type === "user" && item.text.includes(answer)).length, { timeout: 25_000 }).toBe(1);
      await submitMessage(studio, worker.id, command("task_submit_result", { summary: title, verification: `${root.name}专题的隔离证据。` }));
      const result = await resultIn(studio, child.id, "submitted", 25_000);
      await submitMessage(studio, root.session.id, command("task_review_result", { resultId: result.id, accept: true, review: `已核对${root.name}专题的证据。` }));
      const accepted = await resultIn(studio, child.id, "accepted", 25_000);
      expect(accepted).toMatchObject({ id: result.id, taskId: child.id, managerTaskId: root.taskId, reviewedBy: "manager" });
      branches.push({ root, decisionId: decision.id, resultId: result.id });
    }

    for (const { root, resultId } of branches) {
      const own = await workflow(studio, root.taskId);
      expect(own.decisions).toEqual([]);
      expect(own.results.map((item) => item.id)).toEqual([resultId]);
    }
    await evidence(info, "reset-scope", { oldHomeId: oldHome.id, newHomeId: newHome.id, branches: branches.map(({ root, decisionId, resultId }) => ({ taskId: root.taskId, leadSessionId: root.session.id, decisionId, resultId })) });
  } finally {
    await studio.close();
  }
});
