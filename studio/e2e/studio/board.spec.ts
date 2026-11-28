import { expect, test } from "@playwright/test";
import type { Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, windowState, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("registers a sandbox workspace and shows tasks on the board", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await expect(page.getByTestId("host-status")).toHaveText("Host 运行中");

  // Register through the UI (path input; the native folder picker is not driven in tests).
  const alpha = studio.workspace("alpha");
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByLabel("项目路径").fill(alpha);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByTestId("scope-ws-alpha")).toBeVisible();
  // The common space is a project nobody picks: never listed.
  await expect(page.locator('[data-testid^="scope-ws-"]')).toHaveCount(1);
  await expect(page.locator(".brand")).toContainText("alpha");

  // Tasks are created through the API here; the new-task page arrives in S1-10.
  const ws = (await studio.api<{ workspaces: Workspace[] }>("GET", "/api/state")).workspaces.find((w) => !w.builtin)!;
  const waiting = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "校验掉落表",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "[[shell: cmd /c echo check]]" },
  });
  const quiet = await studio.api<{ task: Task }>("POST", "/api/tasks", {
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "整理一下配置项命名" },
  });
  await studio.api("PATCH", `/api/tasks/${quiet.task.id}`, { column: "review" });

  await page.getByTestId("scope-all").click();
  const doing = page.getByTestId("column-doing");
  const review = page.getByTestId("column-review");
  await expect(doing.getByTestId("task-card")).toHaveCount(1);
  await expect(doing).toContainText("校验掉落表");
  await expect(doing).toContainText("待批准", { timeout: 30_000 });
  await expect(review).toContainText("整理一下配置项命名");
  await expect(review).toContainText("空闲", { timeout: 30_000 });
  await expect(page.getByTestId("needs-you")).toHaveText(/需要你 1/);
  await expect(page.getByTestId("column-todo")).toContainText("空");

  // Scope filter: a topic holds only its own tasks.
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  await page.getByTestId("scope-topic-掉落表重构").click();
  await expect(page.getByTestId("task-card")).toHaveCount(0);
  await studio.api("PATCH", `/api/tasks/${quiet.task.id}`, { topicId: topic.id });
  await expect(page.getByTestId("task-card")).toHaveCount(1);
  await page.getByTestId("scope-all").click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);
  // 按专题分组 (on by default, 2026-10-19): the card sits under its topic; the one in none under 未归专题, last.
  await expect(page.getByTestId("board-group-topics")).toBeChecked();
  const reviewGroup = page.getByTestId("column-review").getByTestId("topic-group");
  await expect(reviewGroup).toHaveAttribute("data-topic", "掉落表重构");
  await expect(reviewGroup.getByTestId("task-card").getByTestId("card-where")).toHaveText("alpha");
  await expect(page.getByTestId("column-doing").getByTestId("topic-group")).toHaveAttribute("data-topic", "");
  await expect(page.getByTestId("column-doing").getByTestId("topic-group")).toContainText("未归专题");
  await screenshot(studio.app, "stage-18", "S18-board-groups", page);
  // Off: no groups; each card says 「专题 › 项目」 above its title.
  await page.getByTestId("board-group-topics").uncheck();
  await expect(page.getByTestId("topic-group")).toHaveCount(0);
  await expect(page.getByTestId("column-review").getByTestId("card-where")).toHaveText("掉落表重构›alpha");
  await expect(page.getByTestId("column-doing").getByTestId("card-where")).toHaveText("未归专题›alpha");
  await screenshot(studio.app, "stage-18", "S18-board-where", page);
  // A topic's own board names neither its topic nor offers the toggle.
  await page.getByTestId("scope-topic-掉落表重构").click();
  await expect(page.getByTestId("board-group-topics")).toHaveCount(0);
  await expect(page.getByTestId("card-where")).toHaveText("alpha");
  await page.getByTestId("scope-all").click();
  await page.getByTestId("board-group-topics").check();

  // Drag a card onto another column: the person moves cards. The whole column takes it, down to the page's bottom
  // (2026-10-17), not only the height of its cards.
  const done = page.getByTestId("column-done");
  const box = (await done.boundingBox())!;
  expect(box.height).toBeGreaterThan(300);
  await page.getByTestId("column-review").getByTestId("task-card").dragTo(done, { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  await expect(page.getByTestId("column-done").getByTestId("task-card")).toContainText("整理一下配置项命名");
  await expect.poll(async () => (await studio!.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === quiet.task.id)?.column).toBe("done");

  expect(waiting.session.kind).toBe("main");
  expect(await windowState(studio.app)).toMatchObject({ focused: false, anyFocused: false, onScreen: false });
  await screenshot(studio.app, "stage-1", "S1-09-board", page);
});

test("rejects a path that is not a directory", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page } = studio;
  await page.getByRole("button", { name: "+ 添加项目" }).click();
  await page.getByLabel("项目路径").fill(`${studio.root}\\does-not-exist`);
  await page.getByRole("button", { name: "登记", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not a directory");
});

test("topic groups fold per column, remember their state and exclude folded cards from a drag", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page, app, api } = studio;
  const ws = await api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const title = "机器人主控接单与专题画布：实现派工、换任和逐层验收";
  const topic = await api<Topic>("POST", "/api/topics", { title });
  await api("POST", "/api/tasks", { title: "全方案集成复核", workspaceId: ws.id, topicId: topic.id });
  await api("POST", "/api/tasks", { title: "接入 Plane 新旧模式", workspaceId: ws.id, topicId: topic.id });
  for (const taskTitle of ["实现 Host 接单任命", "实现本地接单入口", "实现派工与逐层验收"]) {
    const { task } = await api<{ task: Task }>("POST", "/api/tasks", { title: taskTitle, workspaceId: ws.id, topicId: topic.id });
    await api("PATCH", `/api/tasks/${task.id}`, { column: "doing" });
  }
  await api("POST", "/api/tasks", { title: "整理笔记", workspaceId: ws.id });
  await page.getByTestId("scope-all").click();

  const todo = page.getByTestId("column-todo");
  const doing = page.getByTestId("column-doing");
  const review = page.getByTestId("column-review");
  const group = (column: typeof todo) => column.locator(`[data-testid="topic-group"][data-topic="${title}"]`);
  const toggle = group(todo).getByRole("button", { name: `${title} 2`, exact: true });
  const toggleDoing = group(doing).getByRole("button", { name: `${title} 3`, exact: true });
  const foldedCard = group(todo).getByTestId("task-card").filter({ hasText: "全方案集成复核" });
  const movingCard = doing.getByTestId("task-card").filter({ hasText: "实现 Host 接单任命" });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await foldedCard.click({ modifiers: ["Control"] });
  await movingCard.click({ modifiers: ["Control"] });
  await expect(page.locator('.card[aria-pressed="true"]')).toHaveCount(2);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group(todo).getByTestId("task-card")).toHaveCount(0);
  await expect(todo.locator(".column-count")).toHaveText("3");
  await expect(toggleDoing).toHaveAttribute("aria-expanded", "true");
  await expect(todo.getByTestId("task-card")).toContainText("整理笔记");
  await movingCard.dragTo(review);
  await expect(review.getByTestId("task-card")).toHaveCount(1);
  await expect(review.getByTestId("task-card")).toContainText("实现 Host 接单任命");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await page.getByTestId("board-group-topics").uncheck();
  await expect(todo.getByTestId("task-card")).toHaveCount(3);
  await expect(todo.getByTestId("task-card").filter({ hasText: "全方案集成复核" })).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("board-group-topics").check();
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(group(todo).getByTestId("task-card")).toHaveCount(0);
  await expect(group(doing).getByTestId("task-card")).toHaveCount(2);
  await screenshot(app, "studio", "board-topic-folded-light", page);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await screenshot(app, "studio", "board-topic-folded-dark", page);
  await toggle.press("Space");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(group(todo).getByTestId("task-card")).toHaveCount(2);
});

test("dropping a task out of review updates the board before the Host responds and rolls back a rejected move", async () => {
  studio = await launchStudio({ mockModel: false });
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "待审阅的任务", workspaceId: ws.id });
  const path = `/api/tasks/${task.id}`;
  const savedColumn = async () => (await studio!.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === task.id)?.column;
  await studio.api("PATCH", path, { column: "review" });
  await page.getByTestId("scope-all").click();
  const review = page.getByTestId("column-review");
  const done = page.getByTestId("column-done");
  const card = page.locator(`[data-task-id="${task.id}"]`);
  const drop = async () => {
    const box = (await done.boundingBox())!;
    await card.dragTo(done, { targetPosition: { x: box.width / 2, y: box.height - 20 } });
  };

  let allowHost!: () => void;
  const paused = new Promise<void>((resolve) => { allowHost = resolve; });
  await page.route(`**${path}`, async (route) => {
    await paused;
    await route.continue();
  }, { times: 1 });
  try {
    await expect(review.locator(card)).toBeVisible();
    const request = page.waitForRequest((r) => r.method() === "PATCH" && r.url().endsWith(path));
    await drop();
    await request;
    await expect(done.locator(card)).toBeVisible({ timeout: 1000 });
    await expect(done.getByTestId("archive-done-all")).toBeDisabled();
    expect(await savedColumn()).toBe("review");
  } finally {
    allowHost();
  }
  await expect.poll(savedColumn).toBe("done");
  await expect(done.locator(card)).toHaveAttribute("draggable", "true");
  await expect(done.getByTestId("archive-done-all")).toBeEnabled();
  await screenshot(app, "studio", "board-review-drop", page);

  await studio.api("PATCH", path, { column: "review" });
  await expect(review.locator(card)).toBeVisible();
  const message = "最终交付尚未通过用户验收，请在「交付与验收」中明确验收或退回。";
  await page.route(`**${path}`, (route) => route.fulfill({ status: 409, json: { error: { code: "conflict", message } } }), { times: 1 });
  await drop();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(review.locator(card)).toBeVisible();
  expect(await savedColumn()).toBe("review");
});

test("archived tasks leave the board; the 完成 column lists them, they open read-only and come back", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "旧的导入任务", workspaceId: ws.id });
  await studio.api("POST", "/api/tasks", { title: "还在做的", workspaceId: ws.id });
  await expect(page.getByTestId("archived-open")).toHaveCount(0);
  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await expect(page.getByTestId("task-card")).toHaveCount(1);

  await page.getByTestId("archived-open").click();
  await expect(page.getByTestId("archived-open")).toHaveText("已归档 1");
  const row = page.getByTestId("archived-list").getByTestId("archived-task");
  await expect(row).toContainText("旧的导入任务");
  await expect(row).toContainText("alpha");
  await screenshot(app, "stage-12", "S12-L-archived-tasks", page);
  await row.click();
  await expect(page.getByTestId("task-archived-banner")).toContainText("已归档 · 只读");
  await page.getByRole("button", { name: "恢复任务" }).click();
  await page.getByRole("button", { name: "返回看板" }).click();
  await expect(page.getByTestId("task-card")).toHaveCount(2);
  await expect(page.getByTestId("archived-open")).toHaveCount(0);
});

test("归档 on the 完成 column's head archives every finished task, the one on a topic group's head that group (2026-10-28)", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "掉落表重构" });
  const make = async (title: string, column: string, topicId?: string) => {
    const { task } = await studio!.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id });
    await studio!.api("PATCH", `/api/tasks/${task.id}`, { column, ...(topicId ? { topicId } : {}) });
    return task;
  };
  await make("拆掉旧的掉落表", "done", topic.id);
  await make("补掉落表测试", "done", topic.id);
  await make("改日志格式", "done");
  await make("还在做的", "doing", topic.id);
  await page.getByTestId("scope-all").click();
  const done = page.getByTestId("column-done");
  await expect(done.getByTestId("task-card")).toHaveCount(3);

  // No right-click menu any more; 全部归档 sits at the right of the head, like 归档 on the session bar (red glyph).
  await done.locator(".column-head").click({ button: "right" });
  await expect(page.getByTestId("done-menu")).toHaveCount(0);
  const all = done.getByTestId("archive-done-all");
  await expect(all).toHaveText("全部归档");
  await expect(all).toHaveClass(/soft-danger/);
  await expect(page.getByTestId("column-doing").getByTestId("archive-done-all")).toHaveCount(0);
  // A topic group's own 归档 shows with the pointer on the group.
  const group = done.locator('[data-testid="topic-group"][data-topic="掉落表重构"]');
  await expect(group.getByTestId("archive-done-group")).toBeHidden();
  await group.hover();
  await expect(group.getByTestId("archive-done-group")).toBeVisible();
  await screenshot(app, "stage-18", "S18-board-archive-done", page);
  const toggle = group.getByRole("button", { name: "掉落表重构 2", exact: true });
  await toggle.click();
  await expect(group.getByTestId("task-card")).toHaveCount(0);
  await group.getByTestId("archive-done-group").click();
  await expect(done.getByTestId("task-card")).toHaveCount(1);
  await expect(done.getByTestId("task-card")).toContainText("改日志格式");
  await expect(page.getByTestId("column-doing").getByTestId("task-card")).toContainText("还在做的");

  await all.click();
  await expect(done.getByTestId("task-card")).toHaveCount(0);
  // An empty 完成 has nothing to archive.
  await expect(all).toHaveCount(0);
  await expect(page.getByTestId("archived-open")).toHaveText("已归档 3");
  const state = await studio.api<{ tasks: Task[] }>("GET", "/api/state");
  expect(state.tasks.filter((t) => t.archivedAt).map((t) => t.title).sort()).toEqual(["拆掉旧的掉落表", "改日志格式", "补掉落表测试"].sort());
});

test("a card title with a long unbroken word (a path) wraps inside its card (2026-10-16)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  await studio.api("POST", "/api/tasks", {
    title: "Message: …UIWidgets/Blizzard_UIWidgetTemplateTextWithStateAndSomeMoreWordsGluedTogether",
    workspaceId: ws.id,
    firstSession: { profileId: "codex-mock", text: "看看这个报错" },
  });
  await page.getByTestId("scope-all").click();
  const card = page.getByTestId("task-card");
  await expect(card).toContainText("Blizzard_UIWidgetTemplate");
  const fits = await card.evaluate((el) => {
    const title = el.querySelector<HTMLElement>(".card-title")!;
    return { cardRight: el.getBoundingClientRect().right, titleRight: title.getBoundingClientRect().right, overflow: title.scrollWidth - title.clientWidth };
  });
  expect(fits.overflow).toBeLessThanOrEqual(0);
  expect(fits.titleRight).toBeLessThanOrEqual(fits.cardRight);
});
