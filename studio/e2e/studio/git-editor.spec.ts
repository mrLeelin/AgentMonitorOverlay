import { selectSettingsPage } from "../support/settings.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { expect, test } from "@playwright/test";
import type { GitEditorState, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("Git 编辑器点击自动检测会重新查找，并显示检测进度和结果", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const exe = join(studio.root, "Fork.exe");
  writeFileSync(exe, "test mode never launches this file");
  let detected: GitEditorState["detected"] = [{ name: "Fork", path: exe }];
  let detectionFails = false;
  let reads = 0;
  let finishDetection: (() => void) | undefined;
  await page.route("**/api/git-editor", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    reads++;
    if (reads === 1) return route.fulfill({ json: { configuredPath: null, detected: [], selected: null } satisfies GitEditorState });
    await new Promise<void>((resolve) => { finishDetection = resolve; });
    if (detectionFails) return route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "检测服务暂不可用" } } });
    await route.fulfill({ json: { configuredPath: null, detected, selected: detected[0] ?? null } satisfies GitEditorState });
  });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "Git 编辑器");
  await expect(dialog.getByRole("radio", { name: "自动检测", exact: true })).toBeEnabled();
  await dialog.getByRole("radio", { name: "自动检测", exact: true }).click();
  await expect.poll(() => reads, { timeout: 2000, message: "点击自动检测应发起新的检测请求" }).toBe(2);
  await expect(dialog.getByRole("status")).toContainText("正在检测 Git 编辑器");
  finishDetection!();
  await expect(dialog.getByRole("status")).toContainText("检测到 Fork");
  await expect(dialog.getByTestId("git-editor-current")).toContainText(exe);
  await screenshot(app, "studio", "git-editor-auto-detected", page);

  // The same selected option must detect again, and stale successful results must disappear after an empty response.
  detected = [];
  await dialog.getByRole("radio", { name: "自动检测", exact: true }).click();
  await expect.poll(() => reads).toBe(3);
  finishDetection!();
  await expect(dialog.getByRole("status")).toContainText("未检测到支持的 Git 编辑器");
  await expect(dialog.getByTestId("git-editor-current")).not.toContainText(exe);
  await screenshot(app, "studio", "git-editor-auto-empty", page);

  detectionFails = true;
  await dialog.getByRole("radio", { name: "自动检测", exact: true }).click();
  await expect.poll(() => reads).toBe(4);
  finishDetection!();
  await expect(dialog.getByRole("alert")).toContainText("检测失败：检测服务暂不可用");
  await expect(dialog.getByRole("radio", { name: "自动检测", exact: true })).toBeEnabled();
});

test("Git 编辑器遇到尚未加载接口的后台，提示会话结束后重启并允许重试", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  let reads = 0;
  await page.route("**/api/git-editor", (route) => {
    reads++;
    return route.fulfill({ status: 404, json: { error: { code: "not_found", message: "no route for GET /api/git-editor" } } });
  });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "Git 编辑器");
  await expect(dialog.getByRole("alert")).toContainText("当前后台尚未加载 Git 编辑器功能");
  await dialog.getByRole("radio", { name: "自动检测", exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(dialog.getByRole("alert")).toContainText("请等会话结束后，退出并重新打开 Studio");
  await screenshot(app, "studio", "git-editor-old-host", page);
});

test("Git 编辑器保存程序、重载保留，分支入口打开对应仓库并显示失效路径错误", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const dir = studio.workspace("JellybeanUnity");
  execFileSync("git", ["init", "-q", "-b", "Project/DarkEvil"], { cwd: dir, windowsHide: true });
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "在 Git 编辑器中打开项目", workspaceId: ws.id });
  const exeDir = join(studio.root, "Git 工具");
  mkdirSync(exeDir);
  const exe = join(exeDir, "Fork.exe");
  writeFileSync(exe, "test mode never launches this file");
  await app.evaluate((_electron, path) => { (globalThis as { __amoPickGitEditor?: string }).__amoPickGitEditor = path; }, exe);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await selectSettingsPage(dialog, "Git 编辑器");
  await expect(dialog.getByRole("radio", { name: "指定程序" })).toBeEnabled();
  await dialog.getByRole("radio", { name: "指定程序" }).click();
  await dialog.getByRole("button", { name: "选择程序…" }).click();
  await expect(dialog.getByLabel("程序路径", { exact: true })).toHaveValue(exe);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已保存");
  await expect(dialog.getByTestId("git-editor-current")).toContainText(exe);
  expect((await studio.api<GitEditorState>("GET", "/api/git-editor")).configuredPath).toBe(exe);
  await screenshot(app, "studio", "git-editor-settings", page);

  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await selectSettingsPage(dialog, "Git 编辑器");
  await expect(dialog.getByLabel("程序路径", { exact: true })).toHaveValue(exe);
  await dialog.getByRole("radio", { name: "自动检测", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(/检测到|未检测到/);
  await expect(dialog.getByLabel("程序路径", { exact: true })).toHaveCount(0);
  // Looking for alternatives must not overwrite a saved manual choice; 保存 makes the automatic choice effective.
  expect((await studio.api<GitEditorState>("GET", "/api/git-editor")).configuredPath).toBe(exe);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已保存");
  expect((await studio.api<GitEditorState>("GET", "/api/git-editor")).configuredPath).toBeNull();
  await dialog.getByRole("radio", { name: "指定程序" }).click();
  await dialog.getByLabel("程序路径", { exact: true }).fill(exe);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("已保存");
  await dialog.getByRole("button", { name: "关闭设置" }).click();
  await page.getByTestId("task-card").filter({ hasText: task.title }).click();
  const branch = page.getByTestId("task-branch");
  await expect(branch).toHaveText("Project/DarkEvil");
  const opened = page.waitForResponse((r) => r.url().endsWith(`/api/workspaces/${ws.id}/git/open`));
  await branch.click();
  const response = await opened;
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ path: normalize(dir), dryRun: true });
  await screenshot(app, "studio", "git-editor-branch", page);

  unlinkSync(exe);
  await branch.click();
  await expect(page.getByTestId("toast")).toContainText(/不存在|找不到|失效/);
});
