import { expect, test } from "@playwright/test";
import type { StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { selectSettingsPage } from "../support/settings.js";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

for (const legacy of [false, true]) test(`全部删除确认覆盖所有类型，取消保留数据，确认后保留未归档任务（旧 Host：${legacy}）`, async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  if (legacy) await page.route("**/api/data/purge-*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: `no route for POST ${new URL(route.request().url()).pathname}` } }) }));
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "已归档专题" });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "已归档任务", workspaceId: ws.id });
  const { task: live } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "保留的任务", workspaceId: ws.id });
  await studio.api("POST", `/api/topics/${topic.id}/archive`);
  await studio.api("POST", `/api/tasks/${task.id}/archive`);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "数据管理");
  await expect(settings.getByTestId("data-row")).toHaveCount(2);
  await settings.getByRole("radio", { name: "任务 1", exact: true }).click();
  await expect(settings.getByTestId("data-row")).toHaveCount(1);
  for (const theme of legacy ? [] : ["dark", "light"]) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await screenshot(app, "studio", `data-delete-all-${theme}`, page);
  }
  await settings.getByTestId("data-delete-all").click();
  const confirm = page.getByTestId("data-delete-all-confirm");
  await expect(confirm).toContainText("1 个专题、1 个任务");
  await expect(confirm).toContainText("不受当前类型筛选影响");
  if (legacy) await expect(confirm).toContainText("删除其他条目后重试");
  await screenshot(app, "studio", legacy ? "data-delete-all-legacy-confirm" : "data-delete-all-confirm", page);
  await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await expect(settings.getByTestId("data-row")).toHaveCount(1);
  await settings.getByTestId("data-delete-all").click();
  await confirm.getByTestId("confirm-action").click();
  await expect(settings.getByTestId("data-empty")).toBeVisible();
  await expect(settings.getByTestId("data-delete-all")).toBeDisabled();
  await expect(settings.getByTestId("data-message")).toContainText("已彻底删除：1 个专题、1 个任务");
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  expect(state.tasks.map((t) => t.id)).toEqual([live.id]);
  expect(state.topics).toHaveLength(0);
});

test("旧 Host 逐项删除遇到保护错误时停止并显示部分成功数量", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  for (const title of ["归档任务甲", "归档任务乙"]) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id });
    await studio.api("POST", `/api/tasks/${task.id}/archive`);
  }
  await page.route("**/api/data/purge-*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: `no route for POST ${new URL(route.request().url()).pathname}` } }) }));
  let requests = 0;
  await page.route("**/api/data/purge", (route) => {
    if (route.request().method() !== "POST" || ++requests === 1) return route.continue();
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { code: "conflict", message: "会话还没归档，先归档它" } }) });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "数据管理");
  await expect(settings.getByTestId("data-row")).toHaveCount(2);
  await settings.getByTestId("data-delete-all").click();
  await page.getByTestId("data-delete-all-confirm").getByTestId("confirm-action").click();
  await expect(settings.getByTestId("data-message")).toContainText("已删除 1 项，剩余 1 项未处理");
  await expect(settings.getByTestId("data-message")).toContainText("会话还没归档");
  await expect(settings.getByTestId("data-row")).toHaveCount(1);
  expect(requests).toBe(3);
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).tasks).toHaveLength(1);
});

test("旧 Host 在主控先出现时先删归档下级，再重试主控直到清空", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const { task: manager } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "归档主控", workspaceId: ws.id, lead: true });
  const { task: child } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "归档下级", workspaceId: ws.id, managerTaskId: manager.id, lead: true });
  const { task: worker } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "归档执行", workspaceId: ws.id, managerTaskId: child.id });
  for (const t of [worker, child, manager]) await studio.api("POST", `/api/tasks/${t.id}/archive`);
  await page.route("**/api/data/purge-*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "not_found", message: `no route for POST ${new URL(route.request().url()).pathname}` } }) }));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await selectSettingsPage(settings, "数据管理");
  await expect(settings.getByTestId("data-row").first()).toContainText("归档主控");
  await settings.getByTestId("data-delete-all").click();
  await page.getByTestId("data-delete-all-confirm").getByTestId("confirm-action").click();
  await expect(settings.getByTestId("data-empty")).toBeVisible();
  await expect(settings.getByTestId("data-message")).toContainText("已彻底删除：3 个任务");
  expect((await studio.api<StateSnapshot>("GET", "/api/state")).tasks).toHaveLength(0);
});
