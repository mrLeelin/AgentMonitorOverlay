import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PLANE_BOARD_API, type PlaneBotJob } from "@amo-studio/protocol";
import { listenInStudioRange } from "@amo-studio/testkit";
import { capture, createBot, firstSession, items, leadState, project, resultIn, snapshot, submitMessage } from "../support/bot-lead-local.js";
import { launchStudio, type Studio } from "../support/studio.js";

test("keeps a manual Plane job with its Bot through project review, requester rework and the archive reminder", async ({}, info) => {
  test.setTimeout(210_000);
  const projectId = "b56372d1-4e7b-4c84-9f57-825c428ef81f";
  const itemId = "c6426757-f560-49ef-a79a-fe74ab90ed93";
  const viewerId = "studio-reviewer", title = "修订发布说明", number = "DEMO-19";
  const token = "manual-workflow-test-key", api = `${PLANE_BOARD_API}/workspaces/demo/projects/${projectId}`;
  const item = { id: itemId, number, title, stateId: "todo", priority: "none", assigneeIds: [], labelIds: [], startDate: null, dueDate: null, revision: 1, archived: false };
  const states = [{ id: "todo", name: "Todo", group: "unstarted" }, { id: "doing", name: "In Progress", group: "started" }, { id: "done", name: "Done", group: "completed" }];
  const notifications = new Map<string, string>();
  const starts: string[] = [];
  const comments: { id: string; author: string; text: string; at: number; files: never[]; canEdit: boolean; canDelete: boolean }[] = [];
  let remotePort = 0;
  const remote = createServer(async (req, res) => {
    const send = (data: object, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (req.headers["x-api-key"] !== token) return send({}, 401);
    const path = req.url?.split("?")[0];
    if (path === PLANE_BOARD_API + "/catalog/") return send({ identity: { id: viewerId, name: "工程验收人" }, workspaces: [{ slug: "demo", name: "Demo", projects: [{ id: projectId, name: "验证项目", writable: true, missing: [] }] }] });
    if (path === api + "/work-items" && req.method === "GET") return send({ viewerId, writable: true, name: "验证项目", states: states.map((s) => ({ ...s, color: "#777777", default: s.id === "todo" })), members: [], labels: [], items: [item] });
    const detail = { ...item, description: "修订仓库内的发布说明。", creator: "工单发起人", url: `http://127.0.0.1:${remotePort}/demo/browse/${number}/`, files: [], comments };
    const itemPath = api + "/work-items/" + itemId;
    if (path === itemPath && req.method === "GET") return send(detail);
    if (path === itemPath + "/context" && req.method === "GET") return send({ viewerId, readAt: Date.now(), item: detail, comments: { items: [...comments].reverse(), nextOffset: null } });
    if (path !== itemPath || req.method !== "POST") return send({}, 404);
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { action: string; viewerId: string; resultId: string; text: string };
    if (body.viewerId !== viewerId) return send({}, 403);
    if (body.action === "bot-start") {
      starts.push(item.stateId);
      item.stateId = "doing";
      return send({ id: itemId });
    }
    if (body.action === "bot-finish") {
      const id = "delivery-" + body.resultId;
      if (!notifications.has(body.resultId)) {
        item.stateId = "done";
        comments.push({ id, text: body.text, author: "工程验收人", at: Date.now(), files: [], canEdit: false, canDelete: false });
        notifications.set(body.resultId, "工单发起人");
      }
      return send({ id });
    }
    if (body.action === "bot-feedback") {
      const receipt = comments.findIndex((comment) => comment.id === "delivery-" + body.resultId);
      const confirmation = receipt < 0 ? null : comments.slice(receipt + 1).find((comment) => comment.author === "工单发起人" && comment.text === "验收通过");
      return send(confirmation ? { status: "confirmed", commentId: confirmation.id } : { status: "waiting" });
    }
    return send({}, 400);
  });
  remotePort = await listenInStudioRange(remote);
  let studio: Studio | undefined;
  try {
    studio = await launchStudio();
    const own = studio, { page } = studio;
    const workspace = await project(studio, "PlaneManualProject");
    const bot = await createBot(studio, workspace, "发布机器人");
    await studio.api("PUT", "/api/settings", { teamTasksEnabled: true });
    await studio.api("POST", "/api/team-board/plane/connect", { server: `http://127.0.0.1:${remotePort}`, token });
    await studio.api("POST", "/api/team-board/plane/select", { workspace: "demo", project: projectId });
    const getJob = () => own.api<PlaneBotJob>("GET", `/api/team-board/plane/work-items/${itemId}/bot`);
    await page.getByRole("navigation", { name: "范围" }).getByRole("button", { name: "团队任务", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await page.getByRole("button", { name: "交给 Bot", exact: true }).click();
    const intake = page.getByRole("dialog", { name: "交给 Bot" });
    await intake.getByLabel("接单机器人").selectOption(bot.id);
    await intake.getByLabel("本地 Git 项目").selectOption(workspace.id);
    await expect(intake.getByLabel("执行方式")).toHaveCount(0);
    await capture(own, info, "plane-manual-intake");
    await intake.getByRole("button", { name: "开始接单" }).click();
    await expect.poll(async () => {
      const record = await getJob();
      return record?.error || record;
    }, { timeout: 30_000 }).toMatchObject({ mode: "managed", botId: bot.id, rootTaskId: expect.any(String), topicId: expect.any(String) });
    const job = await getJob(), rootId = job.rootTaskId!;
    expect(item.stateId).toBe("doing");
    expect(starts).toEqual(["todo"]);
    expect((await leadState(own, rootId)).state).toMatchObject({ kind: "appointed", term: { botId: bot.id } });
    const botJobs = page.getByTestId("plane-bot-conversation"), card = botJobs.getByTestId("plane-bot-conversation-job").filter({ hasText: number });
    await expect(botJobs).toBeVisible();
    const lead = await firstSession(own, rootId);
    const settled = async (id: string) => {
      await expect.poll(async () => (await snapshot(own)).sessions.find((s) => s.id === id)?.status, { timeout: 30_000 }).toBe("idle");
    };
    const runTool = async (sessionId: string, tool: string, args: object) => {
      await settled(sessionId);
      await submitMessage(own, sessionId, `[[mcp: ${tool} ${JSON.stringify(args)}]]`);
    };
    await runTool(lead.id, "task_plan_propose", { summary: "修订发布说明", tasks: [{ key: "release-notes", title: "修订文案", firstMessage: "核对发布文案" }] });
    const workerTask = async () => (await snapshot(own)).tasks.find((t) => t.managerTaskId === rootId);
    await expect.poll(workerTask).toBeTruthy();
    const worker = await firstSession(own, (await workerTask())!.id);
    const dialog = page.getByRole("dialog", { name: "Bot 工单" });
    await settled(worker.id);
    await submitMessage(own, worker.id, "[[ask-async]] [[slow]]");
    await card.getByRole("button", { name: "答复 Bot" }).click();
    await dialog.getByRole("button", { name: "答复「你最喜欢哪个季节？」" }).click();
    const question = dialog.getByTestId("question-card");
    await question.getByRole("radio", { name: /夏天/ }).click();
    await question.getByRole("button", { name: "提交" }).click();
    await expect.poll(async () => (await items(own, worker.id)).some((i) => i.type === "question" && i.state === "answered")).toBe(true);
    await settled(worker.id);
    await submitMessage(own, worker.id, "[[shell: cmd /c echo plane-managed-permission]]");
    const approval = dialog.getByTestId("approval");
    await expect(approval).toContainText("plane-managed-permission");
    await approval.getByRole("button", { name: "拒绝", exact: true }).click();
    await expect.poll(async () => (await items(own, worker.id)).some((i) => i.type === "approval" && i.state === "declined")).toBe(true);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    let previousLeaf: string | undefined, previousRoot: string | undefined;
    async function deliver(round: number) {
      await settled(worker.id);
      await writeFile(join(worker.cwd!, "sample.txt"), `Release notes, revision ${round}\n`);
      await runTool(worker.id, "task_submit_result", { summary: `已改文案第 ${round} 版`, verification: "已逐行检查 sample.txt" });
      const leaf = await resultIn(own, worker.taskId!, "submitted", 25_000, previousLeaf);
      await settled(worker.id);
      await runTool(lead.id, "task_review_result", { resultId: leaf.id, accept: true, review: "已核对执行工作树" });
      await resultIn(own, worker.taskId!, "accepted", 25_000, previousLeaf);
      previousLeaf = leaf.id;
      await runTool(lead.id, "task_submit_result", { summary: `交付第 ${round} 版发布说明`, verification: "请打开执行工程，检查 sample.txt。" });
      const result = await resultIn(own, rootId, "submitted", 25_000, previousRoot);
      previousRoot = result.id;
      await settled(lead.id);
      await expect.poll(getJob).toMatchObject({ state: "review", delivery: { resultId: result.id } });
      return result.id;
    }
    await deliver(1);
    await card.getByRole("button", { name: "验收交付" }).click();
    await expect(dialog.getByText(worker.cwd!, { exact: true }).first()).toBeVisible();
    await capture(own, info, "plane-manual-project-review");
    await dialog.getByLabel("验收意见或退回原因").fill("补充回滚步骤");
    await dialog.getByRole("button", { name: "退回修改", exact: true }).click();
    await expect.poll(async () => (await items(own, lead.id)).some((i) => i.type === "user" && i.text.includes("补充回滚步骤"))).toBe(true);
    expect(notifications.size).toBe(0);
    const firstAccepted = await deliver(2);
    await dialog.getByRole("button", { name: "验收通过", exact: true }).click();
    await expect.poll(getJob).toMatchObject({ requesterReview: "waiting", writeback: { resultId: firstAccepted } });
    const archiveRoute = `/api/team-board/plane/bots/${bot.id}/jobs/${job.jobId}/archive`;
    await expect(own.api("POST", archiveRoute, { resultId: firstAccepted })).rejects.toThrow(/发起人确认/);
    expect(item.stateId).toBe("done");
    expect(notifications.get(firstAccepted)).toBe("工单发起人");
    const rejection = "恢复步骤缺少目录";
    comments.push({ id: "requester-rejection", text: rejection, author: "工单发起人", at: Date.now(), files: [], canEdit: false, canDelete: false });
    await dialog.getByRole("textbox", { name: "给机器人留言" }).fill("看工单发起人的最新评论");
    await dialog.getByRole("button", { name: "交给机器人处理" }).click();
    await expect.poll(async () => (await items(own, lead.id)).some((i) => i.type === "user" && i.text.includes(rejection)), { timeout: 30_000 }).toBe(true);
    expect(item.stateId).toBe("doing");
    const lastAccepted = await deliver(3);
    await dialog.getByRole("button", { name: "验收通过", exact: true }).click();
    await expect.poll(getJob).toMatchObject({ requesterReview: "waiting", writeback: { resultId: lastAccepted } });
    expect([...notifications.keys()]).toEqual([firstAccepted, lastAccepted]);
    expect(item.stateId).toBe("done");
    comments.push({ id: "requester-confirmation", text: "验收通过", author: "工单发起人", at: Date.now(), files: [], canEdit: false, canDelete: false });
    await expect(dialog.getByText(/可以归档/).first()).toBeVisible({ timeout: 75_000 });
    expect(await getJob()).toMatchObject({ jobId: job.jobId, botId: bot.id, rootTaskId: rootId, topicId: job.topicId, requesterReview: "confirmed" });
    await capture(own, info, "plane-manual-archive-reminder");
    const unrelated = await own.api<{ task: { id: string } }>("POST", "/api/tasks", { title: "独立事项", workspaceId: workspace.id, topicId: job.topicId, column: "todo" });
    await expect(dialog.getByRole("button", { name: "归档工单专题" })).toHaveCount(0);
    await expect(own.api("POST", archiveRoute, { resultId: lastAccepted })).rejects.toThrow(/范围已变化/);
    await own.api("PATCH", `/api/tasks/${unrelated.task.id}`, { topicId: null });
    await dialog.getByRole("button", { name: "归档工单专题" }).click();
    const confirmArchive = page.getByRole("alertdialog", { name: `归档 ${number} 的工单专题？` });
    await expect(confirmArchive.getByText(/其中 2 个任务/)).toBeVisible();
    await confirmArchive.getByRole("button", { name: "归档专题", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await snapshot(own)).topics.find((topic) => topic.id === job.topicId)?.archivedAt).toBeTruthy();
    await expect.poll(async () => (await own.api<Array<{ id: string }>>("GET", "/api/team-board/plane/bot-attention")).some((notice) => notice.id === job.jobId)).toBe(false);
    expect(item.stateId).toBe("done");
  } finally {
    await studio?.close();
    await new Promise<void>((done) => remote.close(() => done()));
  }
});
