import { expect, test, type Page } from "@playwright/test";
import type { CanvasDoc, Session, StateSnapshot, Task, TaskPlan, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

async function expectVisibleManagement(page: Page, canvas: CanvasDoc, root: Task, workers: Task[]) {
  const card = (task: Task) => {
    const node = canvas.nodes.find((n) => n.kind === "task" && n.taskId === task.id)!;
    return page.locator(`[data-testid="canvas-card"][data-node-id="${node.id}"]`);
  };
  const rootBox = (await card(root).boundingBox())!;
  const workerBoxes = await Promise.all(workers.map(async (task) => (await card(task).boundingBox())!));
  expect(Math.abs(workerBoxes[0]!.y - workerBoxes[1]!.y)).toBeLessThanOrEqual(1);
  const [left, right] = [...workerBoxes].sort((a, b) => a.x - b.x);
  expect(right!.x - (left!.x + left!.width)).toBeGreaterThan(8);
  expect(Math.min(...workerBoxes.map((box) => box.y)) - (rootBox.y + rootBox.height)).toBeGreaterThanOrEqual(24);
  for (const worker of workers) {
    const line = page.locator(`[data-flow-task-id="${worker.id}"]`).getByTestId("canvas-management-line");
    await expect(line).toHaveAttribute("d", /^M/);
    // A path can exist while being hidden beneath cards. Require an on-screen uncovered run, not just SVG data.
    const visibleRun = await line.evaluate((element) => {
      const path = element as SVGPathElement;
      const matrix = path.getScreenCTM()!;
      const cards = Array.from(document.querySelectorAll('[data-testid="canvas-card"]'), (card) => card.getBoundingClientRect());
      const viewport = document.querySelector('[data-testid="canvas-viewport"]')!.getBoundingClientRect();
      const length = path.getTotalLength();
      let longest = 0;
      let run = 0;
      let previous: { x: number; y: number; visible: boolean } | undefined;
      for (let i = 0; i <= 100; i++) {
        const point = path.getPointAtLength(length * i / 100);
        const x = point.x * matrix.a + point.y * matrix.c + matrix.e;
        const y = point.x * matrix.b + point.y * matrix.d + matrix.f;
        const visible = x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom && cards.every((box) => x < box.left - 1 || x > box.right + 1 || y < box.top - 1 || y > box.bottom + 1);
        run = visible && previous?.visible ? run + Math.hypot(x - previous.x, y - previous.y) : 0;
        longest = Math.max(longest, run);
        previous = { x, y, visible };
      }
      return longest;
    });
    expect(visibleRun).toBeGreaterThan(8);
  }
}

test("self promotion and task splitting automatically show the lead, two workers and both management lines", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("lead-initialization") });
  const topicTitle = "DarkEvil-Story分支交叉检查：定位缺陷并交付合并风险报告";
  const promote = { summary: "组织两名执行者交叉检查 DarkEvil-Story 分支，定位代码和资源缺陷，交付合并风险报告。", topicTitle };
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "DarkEvil-Story 分支交叉检查",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: `[[mcp: task_set_lead ${JSON.stringify(promote)}]]` },
  });
  const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
  await expect.poll(async () => (await state()).tasks.find((t) => t.id === root.task.id), { timeout: 60_000 }).toMatchObject({ lead: true, topicId: expect.any(String) });
  const promoted = await state();
  const leadTask = promoted.tasks.find((t) => t.id === root.task.id)!;
  expect(promoted.topics.find((t) => t.id === leadTask.topicId)?.title).toBe(topicTitle);
  expect(promoted.sessions.find((s) => s.id === root.session.id)?.archivedAt).toBeTruthy();
  await expect.poll(async () => (await state()).sessions.find((s) => s.taskId === root.task.id && s.id !== root.session.id && !s.archivedAt)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
  const lead = (await state()).sessions.find((s) => s.taskId === root.task.id && s.id !== root.session.id && !s.archivedAt)!;
  expect(lead.options?.permission).toBe("read-only");
  const split = {
    summary: "交叉检查代码与资源，汇总为合并风险报告。",
    tasks: [
      { key: "code", title: "检查代码缺陷", firstMessage: "检查 DarkEvil-Story 分支代码，交付缺陷清单。" },
      { key: "resources", title: "检查资源缺陷", firstMessage: "检查 DarkEvil-Story 分支资源，交付缺陷清单。" },
    ],
  };
  await studio.api("POST", `/api/sessions/${lead.id}/messages`, { text: `[[mcp: task_plan_propose ${JSON.stringify(split)}]]` });
  await expect.poll(async () => (await state()).tasks.filter((t) => t.managerTaskId === root.task.id).length, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => (await studio!.api<TaskPlan[]>("GET", "/api/task-plans")).filter((p) => p.fromTaskId === root.task.id && p.state === "accepted").length, { timeout: 60_000 }).toBe(1);
  const workers = (await state()).tasks.filter((t) => t.managerTaskId === root.task.id);
  expect(workers.map((t) => t.topicId)).toEqual([leadTask.topicId, leadTask.topicId]);
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${leadTask.topicId}/canvas`);
  expect(canvas.nodes.filter((n) => n.kind === "task").map((n) => n.taskId).sort()).toEqual([root.task.id, ...workers.map((t) => t.id)].sort());
  expect(canvas.edges).toEqual([]);
  expect(canvas.links ?? []).toEqual([]);

  // Exercise the actual renderer: management lines are derived from ownership and need both task-card endpoints.
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(3);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("canvas-management-line")).toHaveCount(2);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(0);
  await expectVisibleManagement(page, canvas, leadTask, workers);
  for (const colorScheme of ["dark", "light"] as const) {
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), colorScheme);
    await screenshot(app, "studio", `lead-initialization-${colorScheme}`, page);
  }
  // Merely viewing/fitting the canvas must leave the automatically created layout unchanged.
  expect(await studio.api<CanvasDoc>("GET", `/api/topics/${leadTask.topicId}/canvas`)).toEqual(canvas);
});

test("splitting from an existing unplaced lead repairs endpoints without renaming the user's topic", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("lead-existing-topic") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "审查" });
  const root = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "DarkEvil-Story 分支交叉检查", workspaceId: ws.id, topicId: topic.id, lead: true,
    firstSession: { profileId: "codex-mock", text: "等待安排代码和资源交叉检查。" },
  });
  const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
  await expect.poll(async () => (await state()).sessions.find((s) => s.id === root.session.id)?.status, { timeout: 60_000 }).toMatch(/idle|completed/);
  expect((await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).nodes).toEqual([]);
  const split = {
    summary: "交叉检查 DarkEvil-Story 分支的代码和资源，给出合并风险报告。",
    tasks: [
      { key: "code", title: "检查代码缺陷", firstMessage: "独立检查代码缺陷并交付清单。" },
      { key: "resources", title: "检查资源缺陷", firstMessage: "独立检查资源缺陷并交付清单。" },
    ],
  };
  await studio.api("POST", `/api/sessions/${root.session.id}/messages`, { text: `[[mcp: task_plan_propose ${JSON.stringify(split)}]]` });
  await expect.poll(async () => (await studio!.api<TaskPlan[]>("GET", "/api/task-plans")).filter((p) => p.fromTaskId === root.task.id && p.state === "accepted").length, { timeout: 60_000 }).toBe(1);
  const after = await state();
  expect(after.topics).toHaveLength(1);
  expect(after.topics[0]).toMatchObject({ id: topic.id, title: "审查" });
  const workers = after.tasks.filter((t) => t.managerTaskId === root.task.id);
  expect(workers).toHaveLength(2);
  expect(workers.map((t) => t.topicId)).toEqual([topic.id, topic.id]);
  const canvas = await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`);
  expect(canvas.nodes.filter((n) => n.kind === "task").map((n) => n.taskId).sort()).toEqual([root.task.id, ...workers.map((t) => t.id)].sort());
  expect(canvas.edges).toEqual([]);
  expect(canvas.links ?? []).toEqual([]);
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await expect(page.getByTestId("canvas-card")).toHaveCount(3);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByTestId("canvas-management-line")).toHaveCount(2);
  await expect(page.getByTestId("canvas-edge")).toHaveCount(0);
  await expectVisibleManagement(page, canvas, root.task, workers);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await screenshot(app, "studio", "lead-initialization-existing-topic", page);
  expect(await studio.api<CanvasDoc>("GET", `/api/topics/${topic.id}/canvas`)).toEqual(canvas);
});
