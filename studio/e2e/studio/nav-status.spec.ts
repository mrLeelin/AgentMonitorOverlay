import { expect, test } from "@playwright/test";
import type { Task, TaskColumn, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("scope dots follow live task columns, sit beside names and update without a reload", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const projects: Workspace[] = [];
  const topics: Topic[] = [];
  for (const name of ["JellybeanUnity", "AmoStudio", "没有活跃任务的项目"]) {
    projects.push(await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace(name) }));
    topics.push(await studio.api<Topic>("POST", "/api/topics", { title: `${name}专题` }));
  }
  const add = async (index: number, column: TaskColumn) => {
    const { task } = await studio!.api<{ task: Task }>("POST", "/api/tasks", { title: `${index}-${column}`, workspaceId: projects[index]!.id, topicId: topics[index]!.id });
    await studio!.api("PATCH", `/api/tasks/${task.id}`, { column });
    return task;
  };
  const doing = await add(0, "doing");
  const review = await add(0, "review");
  await add(1, "review");
  await add(2, "todo");
  await add(2, "done");
  const archived = await add(2, "doing");
  await studio.api("POST", `/api/tasks/${archived.id}/archive`);

  const rows = (index: number) => [page.getByTestId(`scope-ws-${projects[index]!.name}`), page.getByTestId(`scope-topic-${topics[index]!.title}`)];
  for (const row of rows(0)) {
    await expect(row.locator('.nav-task-dot[data-status="doing"]')).toBeVisible();
    await expect(row.locator('.nav-task-dot[data-status="review"]')).toBeVisible();
    await expect(row.locator(".count")).toHaveCount(0);
    const gap = await row.evaluate((el) => {
      const name = el.querySelector(".name")!.getBoundingClientRect();
      const dot = el.querySelector(".nav-task-dot")!.getBoundingClientRect();
      return dot.left - name.right;
    });
    expect(gap).toBe(6);
    const alignment = await row.evaluate((el) => {
      const row = el.getBoundingClientRect();
      const name = el.querySelector(".name")!.getBoundingClientRect();
      return [...el.querySelectorAll(".nav-task-dot")].map((dot) => {
        const box = dot.getBoundingClientRect();
        return { width: box.width, height: box.height, rowOffset: box.top + box.height / 2 - row.top - row.height / 2, nameOffset: box.top + box.height / 2 - name.top - name.height / 2 };
      });
    });
    for (const dot of alignment) {
      expect(dot.width).toBe(7);
      expect(dot.height).toBe(7);
      expect(Math.abs(dot.rowOffset)).toBeLessThan(0.5);
      expect(Math.abs(dot.nameOffset)).toBeLessThan(0.5);
    }
  }
  for (const row of rows(1)) {
    await expect(row.locator(".nav-task-dot")).toHaveCount(1);
    await expect(row.locator(".nav-task-dot")).toHaveAttribute("data-status", "review");
  }
  for (const row of rows(2)) await expect(row.locator(".nav-task-dot")).toHaveCount(0);
  await expect(page.getByTestId("scope-all").locator(".count")).toHaveCount(0);
  await expect(page.getByTestId("scope-all").locator(".nav-task-dot")).toHaveCount(0);
  await page.getByTestId("scope-ws-JellybeanUnity").click();
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await screenshot(studio.app, "studio", "nav-status-dark", page);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot(studio.app, "studio", "nav-status-light", page);

  // Pinning and ellipsis must leave room for both dots at the minimum sidebar width.
  const longName = "这是一个需要截断的很长很长的项目名称";
  await studio.api("PATCH", `/api/workspaces/${projects[0]!.id}`, { name: longName });
  const longRow = page.getByTestId(`scope-ws-${longName}`);
  await longRow.locator("..").getByTestId("pin").click();
  const handle = page.getByRole("separator", { name: "调整左栏宽度" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute("aria-valuenow", "180");
  await expect(longRow.locator(".nav-task-dot")).toHaveCount(2);
  expect(await longRow.evaluate((el) => {
    const name = el.querySelector(".name")!;
    const dot = el.querySelector('.nav-task-dot[data-status="review"]')!.getBoundingClientRect();
    return name.scrollWidth > name.clientWidth && dot.right < el.getBoundingClientRect().right - 25;
  })).toBe(true);
  await screenshot(studio.app, "studio", "nav-status-long-name", page);

  await studio.api("PATCH", `/api/tasks/${doing.id}`, { column: "done" });
  await expect(longRow.locator('.nav-task-dot[data-status="doing"]')).toHaveCount(0);
  await expect(rows(0)[1]!.locator('.nav-task-dot[data-status="doing"]')).toHaveCount(0);
  await studio.api("POST", `/api/tasks/${review.id}/archive`);
  await expect(longRow.locator(".nav-task-dot")).toHaveCount(0);
  await expect(rows(0)[1]!.locator(".nav-task-dot")).toHaveCount(0);
  // 全部任务 stays plain even while another project still has a review task.
  await expect(rows(1)[0]!.locator(".nav-task-dot")).toHaveAttribute("data-status", "review");
  await expect(page.getByTestId("scope-all").locator(".nav-task-dot")).toHaveCount(0);
});
