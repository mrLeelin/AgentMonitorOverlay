import { expect, test } from "@playwright/test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanvasDoc, SessionItem, TaskPlan, TaskWorkflowSummaryPage, Topic } from "@amo-studio/protocol";
import { appointment, capture, createBot, evidence, firstSession, holdRequest, items, leadState, otherWindow, project, resultIn, snapshot, submitMessage, workflow } from "../support/bot-lead-local.js";
import { launchStudio, type Studio } from "../support/studio.js";

const authFile = process.env.AMO_E2E_CODEX_AUTH_FILE;
const upstreamTitle = "核对临时项目清单";
const downstreamTitle = "验证清单汇总";
const rootTitle = "验收临时项目清单";
const evidenceText = "临时清单包含 lark 和 tern，共两项。";
const childReturn = "请补充每项的字母数，再提交同一个任务。";
const rootReturn = "请在根交付中写明对应的下级交付编号。";
const plan = { summary: "核对两项清单后验证汇总", operationKey: "local-workflow-list", tasks: [
  { key: "list", title: upstreamTitle, firstMessage: "这是隔离验证。先等待核对清单的明确消息，当前回合不用提交。", execution: { kind: "project" } },
  { key: "check", title: downstreamTitle, firstMessage: "这是隔离验证。先等待验证汇总的明确消息，当前回合不用提交。", dependsOn: ["list"], execution: { kind: "project" } },
] };

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

for (const real of [false, true]) {
  const mode = real ? "real Codex" : "mock Codex";
  test(`${mode}: appointed lead dispatches, returns, resubmits and reaches explicit root review`, async ({}, info) => {
    test.skip(real && !authFile, "Set AMO_E2E_CODEX_AUTH_FILE to opt in with an existing Codex CLI login.");
    test.setTimeout(real ? 600_000 : 150_000);
    const timeout = real ? 90_000 : 25_000;
    if (real) {
      const root = mkdtempSync(join(tmpdir(), "amo-lead-real-"));
      const codexHome = join(root, "codex-home");
      const authCopy = join(codexHome, "auth.json");
      mkdirSync(codexHome);
      try {
        copyFileSync(authFile!, authCopy);
        studio = await launchStudio({ root, mockModel: false, env: { CODEX_HOME: codexHome, AMO_STUDIO_TEST_CODEX_HOME: codexHome, AMO_STUDIO_TEST_PROVIDER_URL: "" } });
      } catch (error) {
        rmSync(authCopy, { force: true });
        throw error;
      }
    } else studio = await launchStudio();
    const own = studio;
    const { page, app } = own;
    const ws = await project(own, "list-workflow");
    const topic = await own.api<Topic>("POST", "/api/topics", { title: "临时清单专题", workspaceIds: [ws.id] });
    const bot = await createBot(own, ws, "清单助手", real ? "codex-default" : "codex-mock");
    const command = (tool: string, args: object, instruction: string) => real
      ? `隔离验收。${instruction}\n请在本回合实际调用 AMO 工具 ${tool}，参数为 ${JSON.stringify(args)}。完成后等待下一条明确指示。`
      : `[[mcp: ${tool} ${JSON.stringify(args)}]]`;
    const { receipt, term } = await appointment(own, topic.title, rootTitle, command("task_plan_propose", plan, "一次派工两个直属任务，第二个依赖第一个的验收。"));
    expect(receipt).toMatchObject({ action: "create", topicId: topic.id, state: { kind: "appointed", term: { botId: bot.id, runState: "pending" } } });
    const rootId = receipt.taskId;
    const rootSession = await firstSession(own, rootId, timeout);
    expect(rootSession).toMatchObject({ workspaceId: ws.id, options: { permission: "read-only" }, botLeadTerm: { termId: term.termId } });
    const canvas = () => own.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
    const card = (title: string) => page.getByTestId("canvas-card").and(page.getByRole("button", { name: title, exact: true }));
    const plans = () => own.api<TaskPlan[]>("GET", "/api/task-plans");
    const send = (sessionId: string, tool: string, args: object, instruction: string) => submitMessage(own, sessionId, command(tool, args, instruction));
    const result = (taskId: string, state: "submitted" | "accepted" | "returned", except?: string) => resultIn(own, taskId, state, timeout, except);
    const submit = (sessionId: string, summary: string, verification: string, instruction: string) => send(sessionId, "task_submit_result", { summary, verification }, instruction);
    const review = (resultId: string, accept: boolean, text: string) => send(rootSession.id, "task_review_result", { resultId, accept, review: text }, "核对所指定的直属交付和本条明确的验收结论。");
    const detail = page.getByTestId("canvas-detail");
    const pendingRoot = async () => (await own.api<TaskWorkflowSummaryPage>("GET", `/api/tasks/${rootId}/workflow/summary`)).pendingUserReviewResultId;
    const formalCards = async () => (await canvas()).nodes.filter((node) => node.kind === "task").map((node) => node.taskId);
    const pendingBeforeStart: unknown[] = [];
    type Approval = Extract<SessionItem, { type: "approval" }>;
    let approvedRead: Approval | undefined;
    const settledTurn = async (sessionId: string) => {
      await expect.poll(async () => (await items(own, sessionId)).filter((item) => item.type === "turn").at(-1)?.state, { timeout }).toBe("completed");
    };

    try {
      await expect.poll(async () => (await plans()).find((entry) => entry.fromTaskId === rootId)?.state, { timeout }).toBe("accepted");
      const dispatches = (await plans()).filter((entry) => entry.fromTaskId === rootId);
      expect(dispatches).toHaveLength(1);
      const dispatched = await snapshot(own);
      const upstream = dispatched.tasks.find((task) => task.managerTaskId === rootId && task.title === upstreamTitle)!;
      const downstream = dispatched.tasks.find((task) => task.managerTaskId === rootId && task.title === downstreamTitle)!;
      expect(await formalCards()).toEqual(expect.arrayContaining([rootId, upstream.id, downstream.id]));
      expect(await formalCards()).toHaveLength(3);
      const stillWaiting = async (stage: string) => {
        const state = await snapshot(own);
        expect(state.sessions.filter((session) => session.taskId === downstream.id)).toHaveLength(0);
        await expect(card(downstreamTitle)).toContainText(/等待.*核对临时项目清单/);
        pendingBeforeStart.push({ stage, waitingTaskId: downstream.id, prerequisiteTaskId: upstream.id, downstreamSessions: 0 });
      };
      await stillWaiting("派工后");
      await expect(page.getByTestId("canvas-management-line")).toHaveCount(2);
      await expect(page.getByTestId("canvas-edge")).toHaveCount(1);
      await card(rootTitle).click();
      await detail.getByRole("button", { name: downstreamTitle, exact: true }).click();
      await expect(card(downstreamTitle)).toHaveClass(/selected/);
      await detail.getByTestId("dependency").getByRole("button", { name: upstreamTitle, exact: true }).press("Enter");
      await expect(card(upstreamTitle)).toHaveClass(/selected/);
      if (!real) await capture(own, info, "bot-lead-e2e-dependency");
      const worker = await firstSession(own, upstream.id, timeout);
      await settledTurn(worker.id);
      await submit(worker.id, "临时清单初版", evidenceText, "先用 PowerShell 命令 Get-Content -LiteralPath sample.txt 核对内容，再提交清单。只读这一个文件，不需要其他命令。这个版本不统计字母数。");
      if (real) {
        await expect.poll(async () => {
          approvedRead = (await items(own, worker.id)).find((item): item is Approval => item.type === "approval" && item.state === "pending");
          return !!approvedRead || (await workflow(own, upstream.id)).results.some((entry) => entry.taskId === upstream.id);
        }, { timeout }).toBe(true);
        if (approvedRead) {
          expect(approvedRead).toMatchObject({ kind: "command", sessionId: worker.id, summary: "Get-Content -LiteralPath sample.txt", detail: ws.path });
          await detail.getByRole("button", { name: /^处理原生审批/ }).click();
          const approval = page.getByTestId("approval").filter({ hasText: "Get-Content -LiteralPath sample.txt" });
          await expect(approval).toContainText(ws.path);
          await capture(own, info, "bot-lead-e2e-native-read-approval");
          await approval.getByRole("button", { name: "批准", exact: true }).click();
          await expect.poll(async () => (await items(own, worker.id)).find((item) => item.id === approvedRead!.id), { timeout }).toMatchObject({ type: "approval", state: "accepted", sessionId: worker.id });
          await page.getByTestId(`scope-topic-${topic.title}`).click();
          await page.getByRole("button", { name: "画布", exact: true }).click();
        }
        await expect.poll(async () => (await items(own, worker.id)).some((item) => item.type === "tool" && item.kind === "read" && item.exitCode === 0 && /lark[\s\S]*tern/.test(item.detail ?? "")), { timeout }).toBe(true);
      }
      const childV1 = await result(upstream.id, "submitted");
      await stillWaiting("前置已提交待验收");
      await review(childV1.id, false, childReturn);
      await result(upstream.id, "returned");
      await stillWaiting("前置已退回");
      await submit(worker.id, "临时清单修订版", `${evidenceText}lark 四个字母，tern 四个字母。`, "根据本会话已经读取的两行内容，确认每项字母数后提交修订版。沿用原始工具输出，无需再次执行命令。");
      const childV2 = await result(upstream.id, "submitted", childV1.id);
      await stillWaiting("前置修订版待验收");
      await review(childV2.id, true, "两项及字母数核对通过。");
      await result(upstream.id, "accepted");
      const dependent = await firstSession(own, downstream.id, timeout);
      await expect.poll(async () => (await items(own, dependent.id)).some((item) => item.type === "user" && item.text.includes(childV2.id) && !item.text.includes(childV1.id)), { timeout }).toBe(true);
      await submit(dependent.id, "已验证清单汇总", `采用 ${childV2.id}，两项合计八个字母。`, "根据已验收的前置交付复核汇总，然后提交。");
      const childFinal = await result(downstream.id, "submitted");
      expect(childFinal.prerequisiteResultIds).toEqual([childV2.id]);
      await review(childFinal.id, true, "已核对修订前置和汇总记录。");
      await result(downstream.id, "accepted");
      const unchangedCanvas = await canvas();

      await submit(rootSession.id, "清单根交付初版", "两项清单及汇总已由直属主控验收。", "已验收两个直属任务，请提交根交付，等待用户在界面验收。");
      const rootV1 = await result(rootId, "submitted");
      expect(await pendingRoot()).toBe(rootV1.id);
      await card(rootTitle).click();
      await detail.getByRole("button", { name: "待你验收 · 查看证据", exact: true }).click();
      await expect(detail).toContainText(rootV1.id);
      await detail.getByLabel("验收意见或退回原因").fill(rootReturn);
      await detail.getByRole("button", { name: "退回修改", exact: true }).click();
      expect(await result(rootId, "returned")).toMatchObject({ id: rootV1.id, reviewedBy: "user", review: rootReturn });
      await expect.poll(async () => (await items(own, rootSession.id)).some((item) => item.type === "user" && item.text.includes(rootReturn)), { timeout }).toBe(true);
      await submit(rootSession.id, "清单根交付修订版", `清单交付 ${childV2.id}，汇总交付 ${childFinal.id}。两项合计八个字母。`, "按人工退回意见补充两个已验收实际编号，提交新版根交付。");
      const rootV2 = await result(rootId, "submitted", rootV1.id);
      expect(rootV2.verification).toContain(childV2.id);
      expect(rootV2.verification).toContain(childFinal.id);
      expect(await pendingRoot()).toBe(rootV2.id);
      await expect.poll(async () => (await snapshot(own)).sessions.find((s) => s.id === rootSession.id)?.status, { timeout }).toMatch(/idle|completed/);

      const openingFocus = app.waitForEvent("window");
      await page.getByRole("button", { name: /^Focus/ }).click();
      const focus = await openingFocus;
      await focus.getByTestId("focus-lead-review").getByRole("button").click();
      const accept = () => detail.getByRole("button", { name: "验收通过", exact: true });
      await expect(detail).toContainText(rootV2.id);
      if (real) await accept().press("Enter");
      else {
        await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
        await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)!.setSize(960, 850), page.url());
        await expect(page.getByRole("region", { name: "专题任务列表" })).toBeVisible();
        await detail.getByTestId("workflow-user-review").evaluate((review) => review.scrollIntoView({ block: "center" }));
        await capture(own, info, "bot-lead-e2e-root-review-light");
        const second = await otherWindow(own);
        await second.getByTestId(`scope-topic-${topic.title}`).click();
        await second.getByRole("button", { name: "看板", exact: true }).click();
        await second.getByRole("button", { name: `在专题画布定位 ${rootTitle}`, exact: true }).click();
        const otherDetail = second.getByTestId("canvas-detail");
        await otherDetail.getByRole("button", { name: "待你验收 · 查看证据", exact: true }).click();
        await expect(otherDetail).toContainText(rootV2.id);
        await otherDetail.getByLabel("验收意见或退回原因").fill("另一个窗口尝试退回。");
        const path = `/api/tasks/${rootId}/workflow/user-review`;
        const gate = holdRequest(second, path);
        await gate.installed;
        await otherDetail.getByRole("button", { name: "退回修改", exact: true }).click();
        const held = await gate.arrived;
        expect(held.request().postDataJSON()).toMatchObject({ resultId: rootV2.id, accept: false });
        const acceptResponse = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
        const returnResponse = second.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST");
        try {
          await accept().press("Enter");
          expect((await acceptResponse).status()).toBe(200);
        } finally { await held.continue(); }
        expect((await returnResponse).status()).toBe(409);
      }
      const accepted = await result(rootId, "accepted");
      expect(accepted).toMatchObject({ id: rootV2.id, reviewedBy: "user" });
      expect(await pendingRoot()).toBeNull();
      const final = await snapshot(own);
      expect(final.tasks.filter((task) => [rootId, upstream.id, downstream.id].includes(task.id)).map((task) => task.column)).toEqual(["done", "done", "done"]);
      expect(await canvas()).toEqual(unchangedCanvas);
      expect((await leadState(own, rootId)).state).toMatchObject({ kind: "appointed", term: { sessionId: rootSession.id } });
      await evidence(info, "workflow-evidence", { mode, receipt, rootSession, gate: pendingBeforeStart, plan: dispatches[0], canvas: unchangedCanvas, workflow: (await workflow(own, rootId)).results, nativeApprovalId: approvedRead?.approvalId });
    } finally {
      if (real) {
        const sessions = (await snapshot(own)).sessions.filter((session) => session.workspaceId === ws.id);
        const transcripts = await Promise.all(sessions.map(async (session) => ({ id: session.id, taskId: session.taskId, runtime: session.runtime, profileId: session.profileId, options: session.options, status: session.status, items: await items(own, session.id) })));
        await evidence(info, "real-codex-transcripts", transcripts);
      }
    }
  });
}
