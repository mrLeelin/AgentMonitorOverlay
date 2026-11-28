import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, type Page } from "@playwright/test";
import type { BotLeadOperationReceipt, CanvasDoc, Session, Task, TaskPlan, Topic, Workspace } from "@amo-studio/protocol";
import { capture, createBot, evidence, leadState, project, snapshot } from "../support/bot-lead-local.js";
import { launchStudio, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function openCanvas(page: Page, title: string) {
  await page.getByTestId(`scope-topic-${title}`).click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-viewport")).toBeVisible();
}

const card = (page: Page, title: string) => page.getByRole("button", { name: title, exact: true }).and(page.getByTestId("canvas-card"));
const phase = (id: string) => leadState(studio!, id).then((view) => view.state?.kind === "appointed" ? view.state.term.runState : view.state?.kind);
const owner = (id: string) => leadState(studio!, id).then((view) => view.state?.kind === "appointed" ? view.state.term.name : null);
const newTask = (studio: Studio, workspace: Workspace, topic: Topic, title: string) =>
  studio.api<{ task: Task; session: Session | null }>("POST", "/api/tasks", { title, workspaceId: workspace.id, topicId: topic.id });

test("binds an existing root and middle, then replaces the owner and resumes after Bots is hidden", async ({}, info) => {
  studio = await launchStudio();
  const ws = await project(studio, "legacy-lead-project");
  const rootBot = await createBot(studio, ws, "原树负责人");
  const middleBot = await createBot(studio, ws, "界面负责人");
  const successor = await createBot(studio, ws, "接任负责人");
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "旧版项目协调", workspaceIds: [ws.id] });
  const { task: root } = await newTask(studio, ws, topic, "旧任务总协调");
  const { task: middle } = await newTask(studio, ws, topic, "旧任务界面验收");
  const { task: child } = await newTask(studio, ws, topic, "原树执行任务");
  await studio.api("PUT", `/api/tasks/${root.id}/canvas`, { onCanvas: true });
  const original = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  const keep = original.nodes.find((node) => node.kind === "task" && node.taskId === root.id)!;
  const runRoot = studio.root, dataDir = studio.dataDir;
  await studio.close({ keepData: true });
  studio = undefined;
  const db = new DatabaseSync(join(dataDir, "studio.db"));
  try {
    db.prepare("UPDATE tasks SET lead = 1 WHERE id IN (?, ?)").run(root.id, middle.id);
    db.prepare("UPDATE tasks SET manager_task_id = ? WHERE id = ?").run(root.id, middle.id);
    db.prepare("UPDATE tasks SET manager_task_id = ? WHERE id = ?").run(middle.id, child.id);
  } finally { db.close(); }
  studio = await launchStudio({ root: runRoot });
  const { page } = studio;
  await openCanvas(page, topic.title);
  await card(page, root.title).click();
  const runPanel = page.getByRole("region", { name: "主控运行状态" });
  await expect(runPanel).toContainText("待绑定机器人");
  await expect(card(page, middle.title)).toBeVisible();
  await runPanel.getByRole("button", { name: "绑定机器人" }).click();
  const binding = page.getByRole("dialog", { name: "绑定旧主控树" });
  await binding.getByLabel(`总主控 · ${root.title}`).selectOption(rootBot.id);
  await binding.getByLabel(`中控 · ${middle.title}`).selectOption(middleBot.id);
  await capture(studio, info, "bot-lead-stage2-bind-old-tree");
  await binding.getByRole("button", { name: "绑定并交接" }).click();
  await expect(binding).toHaveCount(0);
  await expect.poll(() => phase(root.id), { timeout: 25_000 }).toBe("idle");
  await expect.poll(() => phase(middle.id), { timeout: 25_000 }).toBe("idle");
  const theme = page.getByRole("button", { name: "深色模式", exact: true });
  if (await theme.getAttribute("aria-pressed") !== "true") await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await runPanel.getByRole("button", { name: "更换机器人" }).click();
  const replace = page.getByRole("dialog", { name: "更换负责机器人" });
  await replace.getByLabel("接任机器人").selectOption(successor.id);
  await replace.getByLabel("交接备注（可选）").fill("接续原树工作并核对在途任务");
  await capture(studio, info, "bot-lead-stage2-replace");
  await replace.getByRole("button", { name: "确认换任" }).click();
  await expect(replace).toHaveCount(0);
  await expect.poll(() => owner(root.id), { timeout: 25_000 }).toBe(successor.name);
  await expect.poll(() => phase(root.id), { timeout: 25_000 }).toBe("idle");
  await theme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await runPanel.getByRole("button", { name: "暂停主控" }).click();
  await expect(runPanel).toContainText("主控暂停");
  await studio.api("PUT", "/api/settings", { botsEnabled: false });
  await expect(runPanel).toContainText("在「设置 → 工具与自动化 → Bots」启用后可继续");
  await capture(studio, info, "bot-lead-stage2-disabled");
  await studio.api("PUT", "/api/settings", { botsEnabled: true });
  await expect(runPanel).toContainText("主控暂停");
  await runPanel.getByRole("button", { name: "恢复主控" }).click();
  await expect.poll(() => phase(root.id), { timeout: 25_000 }).toBe("idle");
  const after = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  expect(after.nodes.find((node) => node.id === keep.id)).toEqual(keep);
  const state = await snapshot(studio);
  expect(state.tasks.find((task) => task.id === middle.id)?.managerTaskId).toBe(root.id);
  expect(state.tasks.find((task) => task.id === child.id)?.managerTaskId).toBe(middle.id);
  const history = await leadState(studio, root.id);
  expect(history.terms?.map((term) => ({ name: term.name, generation: term.generation, state: term.state }))).toEqual([
    { name: successor.name, generation: 2, state: "active" }, { name: rootBot.name, generation: 1, state: "ended" },
  ]);
  await evidence(info, "legacy-tree-lifecycle", { rootId: root.id, middleId: middle.id, childId: child.id, topicId: topic.id, preservedCard: keep, history });
});

test("routes the full draft, QuickStart and canvas menu to real appointments", async ({}, info) => {
  studio = await launchStudio();
  const ws = await project(studio, "entry-lead-project");
  const bot = await createBot(studio, ws, "入口负责人");
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "入口验证专题", workspaceIds: [ws.id] });
  const { page } = studio;

  async function receive() {
    const form = page.getByTestId("lead-appointment");
    await form.getByLabel("负责机器人").selectOption(bot.id);
    if (await form.getByLabel("项目", { exact: true }).isVisible()) await form.getByLabel("项目", { exact: true }).selectOption(ws.id);
    const pending = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/bot-leads/appointments" && res.request().method() === "POST");
    await form.getByRole("button", { name: "任命机器人", exact: true }).click();
    const response = await pending;
    expect(response.ok(), await response.text()).toBe(true);
    return await response.json() as BotLeadOperationReceipt;
  }
  await page.getByRole("button", { name: "+ 新任务", exact: true }).click();
  await page.getByLabel("第一句话").fill("新建页负责人交付");
  await page.getByTestId("draft-lead").check();
  await page.getByTestId("draft-file").click();
  const filed = await receive();
  await expect(card(page, "新建页负责人交付")).toHaveClass(/selected/);
  expect(await phase(filed.taskId)).toBe("paused");
  expect((await snapshot(studio)).sessions.filter((session) => session.taskId === filed.taskId)).toEqual([]);

  await page.keyboard.press("Control+N");
  const quick = page.getByRole("dialog", { name: "快速新任务" });
  await quick.getByLabel("快速新任务").fill("快速开始负责人交付");
  await quick.getByRole("button", { name: "机器人带队", exact: true }).click();
  await capture(studio, info, "bot-lead-stage2-quick-start");
  const quickLead = await receive();
  await expect(card(page, "快速开始负责人交付")).toHaveClass(/selected/);

  await openCanvas(page, topic.title);
  await page.getByTestId("canvas-viewport").click({ button: "right" });
  await page.getByRole("menuitem", { name: "请机器人带队…", exact: true }).click();
  await page.getByTestId("lead-appointment").getByLabel("交付目标").fill("画布菜单负责人交付");
  const menu = await receive();
  expect(menu.topicId).toBe(topic.id);
  await expect(card(page, "画布菜单负责人交付")).toHaveClass(/selected/);
  await evidence(info, "lead-entry-receipts", { filed, quickLead, menu });
});

test("keeps a pending topic proposal and lets the person pick a Bot before adopting it", async ({}, info) => {
  studio = await launchStudio();
  const workspace = await project(studio, "legacy-topic-proposal");
  const bot = await createBot(studio, workspace, "专题提案负责人");
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "旧专题提案", workspaceIds: [workspace.id] });
  const source = await studio.api<Session>("POST", `/api/topics/${topic.id}/sessions`, { profileId: "codex-mock", workspaceId: workspace.id });
  const plan: TaskPlan = {
    id: "old-topic-plan", topicId: topic.id, fromTaskId: null, fromSessionId: source.id,
    summary: "旧专题留存的提案目标", state: "open", createdAt: new Date().toISOString(), decidedAt: null,
    tasks: [{ key: "lead", title: "旧提案总协调", workspaceId: workspace.id, lead: true, firstMessage: "保留原提案的原话", dependsOn: [] }],
  };
  const root = studio.root, dataDir = studio.dataDir;
  await studio.close({ keepData: true });
  studio = undefined;
  const db = new DatabaseSync(join(dataDir, "studio.db"));
  try { db.prepare("INSERT INTO task_plans VALUES (?, ?, ?, ?)").run(plan.id, plan.state, plan.createdAt, JSON.stringify(plan)); }
  finally { db.close(); }
  studio = await launchStudio({ root });
  const { page } = studio;
  await openCanvas(page, topic.title);
  await expect(page.getByTestId("plan-banner")).toContainText("待选机器人");
  await page.getByTestId("plan-open").click();
  const form = page.getByTestId("plan-dialog");
  await expect(form.getByLabel("第一句话")).toHaveValue("保留原提案的原话");
  await expect(form.getByTestId("plan-accept-run")).toBeDisabled();
  await form.getByLabel("负责机器人").selectOption(bot.id);
  await capture(studio, info, "bot-lead-stage2-topic-proposal");
  await form.getByTestId("plan-accept-todo").click();
  await expect(form).toHaveCount(0);
  const accepted = (await studio.api<TaskPlan[]>("GET", "/api/task-plans")).find((item) => item.id === plan.id)!;
  const taskId = accepted.created?.[0]?.taskId;
  expect(accepted).toMatchObject({ state: "accepted", tasks: [{ key: "lead", leadBotId: bot.id, firstMessage: plan.tasks[0]!.firstMessage }] });
  expect(taskId).toBeTruthy();
  await expect(card(page, plan.tasks[0]!.title)).toBeVisible();
  expect(await phase(taskId!)).toBe("paused");
  await evidence(info, "topic-proposal-appointment", { accepted, task: await leadState(studio, taskId!) });
});
