import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

function repository(studio: Studio) {
  const repo = studio.workspace("repo");
  const dir = join(repo, "Game");
  mkdirSync(dir);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "AMO test");
  git(repo, "config", "user.email", "amo@example.test");
  writeFileSync(join(dir, "marker.txt"), "main");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "main");
  git(repo, "switch", "-qc", "feature/alternate");
  writeFileSync(join(dir, "marker.txt"), "alternate");
  git(repo, "commit", "-qam", "alternate");
  git(repo, "switch", "-q", "main");
  writeFileSync(join(dir, "marker.txt"), "main with edits");
  writeFileSync(join(dir, "untracked.txt"), "keep me");
  return { repo, dir };
}

test("历史回复分支接口从指定轮次在当前目录或新工作树继续", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page } = studio;
  const { repo, dir } = repository(studio);
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const { session: source } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "核对分支会话",
    workspaceId: workspace.id,
    firstSession: { profileId: "codex-mock", text: "分支起点", options: { permission: "full-auto" } },
  });
  await page.getByTestId("task-card").filter({ hasText: "核对分支会话" }).click();
  await expect(page.getByTestId("msg-agent")).toHaveText("MOCK: 分支起点");
  const items = () => studio!.api<SessionItem[]>("GET", `/api/sessions/${source.id}/items`);
  const completedTurns = async () => (await items()).filter((i) => i.type === "turn" && i.state === "completed").length;
  await expect.poll(completedTurns).toBe(1);
  await studio.api("POST", `/api/sessions/${source.id}/messages`, { text: "原会话中的后续内容" });
  await expect(page.getByTestId("msg-agent").last()).toHaveText("MOCK: 原会话中的后续内容");
  await expect.poll(completedTurns).toBe(2);
  const turnItemId = (await items()).find((i) => i.type === "turn")!.id;
  const forkUrl = `/api/sessions/${source.id}/fork`;
  const local = await studio.api<Session>("POST", forkUrl, { turnItemId });
  expect(local.cwd).toBeUndefined();
  expect(local.workspaceId).toBe(workspace.id);

  const fork = await studio.api<Session>("POST", forkUrl, { turnItemId, newWorktree: true, branch: "feature/alternate" });
  const cwd = fork.cwd!;
  await page.getByTestId("session-row").last().click();
  await expect(page.getByTestId("session-worktree")).toHaveAttribute("title", cwd);
  expect(fork.workspaceId).toBe(workspace.id);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature/alternate"));
  expect(git(cwd, "branch", "--show-current")).toBe("");
  expect(readFileSync(join(cwd, "marker.txt"), "utf8")).toBe("alternate");
  expect(existsSync(join(cwd, "untracked.txt"))).toBe(false);
  expect(git(repo, "branch", "--show-current")).toBe("main");
  expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("main with edits");
  expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("keep me");

  await studio.api("POST", `/api/sessions/${fork.id}/messages`, { text: "继续查看 `marker.txt`" });
  await expect(page.getByTestId("msg-agent")).toContainText("继续查看");
  await expect(page.getByTestId("msg-agent").getByTestId("file-link")).toHaveAttribute("data-path", join(cwd, "marker.txt"));
  const sent = studio.mock!.requests.findLast((r) => r.lastUserText === "继续查看 `marker.txt`");
  expect(JSON.stringify(sent?.body.input)).toContain("分支起点");
  expect(JSON.stringify(sent?.body.input)).not.toContain("原会话中的后续内容");
  const original = await studio.api<SessionItem[]>("GET", `/api/sessions/${source.id}/items`);
  expect(original.filter((i) => i.type === "turn")).toHaveLength(2);

  const readMarker = "[[shell: cmd /c type marker.txt]]";
  await studio.api("POST", `/api/sessions/${fork.id}/messages`, { text: readMarker });
  await expect(page.getByTestId("msg-agent").last()).toHaveText("MOCK-DONE");
  const ran = studio.mock!.requests.findLast((r) => r.lastUserText === readMarker && r.lastTool);
  expect(ran?.lastTool?.output).toContain("alternate");
  expect(ran?.lastTool?.output).not.toContain("main with edits");
});

test("新建任务从附件旁设置分支，并在所选分支的工作树启动", async () => {
  studio = await launchStudio({ taskSidebar: false });
  const { page, app } = studio;
  const { repo, dir } = repository(studio);
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await page.evaluate(() => {
    localStorage.setItem("amo.taskDraft", JSON.stringify({ pick: { profileId: "codex-mock", model: null }, options: { permission: "full-auto" } }));
    document.documentElement.dataset.theme = "dark";
  });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  const trigger = page.getByRole("button", { name: "分支与工作树", exact: true });
  await expect(trigger).toBeDisabled();
  await page.getByRole("group", { name: "项目", exact: true }).getByRole("button", { name: workspace.name, exact: true }).click();
  await expect(trigger).toBeEnabled();
  const attach = (await page.getByRole("button", { name: "添加图片或文件", exact: true }).boundingBox())!;
  const icon = (await trigger.boundingBox())!;
  expect(icon.x).toBeGreaterThan(attach.x);
  expect(icon.y).toBe(attach.y);
  await screenshot(app, "studio", "newtask-worktree-entry", page);

  await trigger.click();
  const dialog = page.getByTestId("draft-worktree-dialog");
  const branch = dialog.getByRole("combobox", { name: "分支" });
  const worktree = dialog.getByRole("switch", { name: "新建工作树" });
  const expectAnchored = async () => {
    await expect.poll(async () => {
      const button = (await trigger.boundingBox())!;
      const panel = (await dialog.boundingBox())!;
      return { left: Math.round(panel.x - button.x), gap: Math.round(button.y - panel.y - panel.height) };
    }).toEqual({ left: 0, gap: 6 });
  };
  await expect(branch).toHaveValue("main");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expectAnchored();
  await screenshot(app, "studio", "newtask-worktree-anchored", page);
  await expect(worktree).not.toBeChecked();
  await branch.selectOption("feature/alternate");
  await expect(worktree).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toHaveAttribute("aria-pressed", "false");
  await trigger.click();
  await expect(branch).toHaveValue("main");
  await branch.selectOption("feature/alternate");
  await screenshot(app, "studio", "newtask-worktree-options", page);
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)!.setSize(960, 600);
  }, page.url());
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThan(1000);
  await expectAnchored();
  await screenshot(app, "studio", "newtask-worktree-narrow", page);
  await page.locator(".draft-wrap").evaluate((draft) => { draft.scrollTop = 80; });
  await expect.poll(async () => (await trigger.boundingBox())!.y).toBeLessThan(icon.y - 40);
  await expectAnchored();
  await dialog.getByRole("button", { name: "应用" }).click();
  await expect(trigger).toHaveAttribute("title", "新建工作树 · feature/alternate");
  await expect(page.getByTestId("draft-file")).toBeDisabled();
  expect(git(repo, "worktree", "list", "--porcelain").split("worktree ")).toHaveLength(2);

  await page.getByRole("textbox", { name: "第一句话" }).fill("[[shell: cmd /c type marker.txt]]");
  await page.getByTestId("draft-start").click();
  await expect(page.getByTestId("msg-agent").last()).toHaveText("MOCK-DONE");
  await expect(page.getByTestId("turn-foot").last().getByRole("button", { name: "复制回复" })).toHaveCount(1);
  await expect(page.getByTestId("turn-fork")).toHaveCount(0);
  await screenshot(app, "studio", "newtask-worktree-reply", page);

  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const session = state.sessions.find((s) => s.workspaceId === workspace.id)!;
  expect(session.kind).toBe("main");
  expect(session.parentId).toBeNull();
  expect(git(session.cwd!, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature/alternate"));
  expect(git(session.cwd!, "branch", "--show-current")).toBe("");
  expect(studio.mock!.requests.findLast((r) => r.lastTool)?.lastTool?.output).toContain("alternate");
  expect(git(repo, "branch", "--show-current")).toBe("main");
  expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("main with edits");
  expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("keep me");
});

test("Claude、DSH 和 Pi 从所选 Git 工作树启动，重开后仍在同一目录", async () => {
  const piAgent = fileURLToPath(new URL("../../packages/testkit/scripts/mock-pi.mjs", import.meta.url));
  const launch = { taskSidebar: false, dsh: true, env: { AMO_STUDIO_TEST_PI_AGENT: piAgent } };
  studio = await launchStudio(launch);
  const { page, app, root } = studio;
  const { repo, dir } = repository(studio);
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const cases = [
    { runtime: "claude", profileId: "claude-mock", start: "[[shell: cat marker.txt > launch-check.txt]]", next: "[[shell: cat marker.txt > resume-check.txt]]", firstReply: "MOCK-DONE", nextReply: null },
    { runtime: "dsh", profileId: "dsh-mock", start: "[[worktree-marker]]", next: "[[worktree-marker]]", firstReply: "alternate / alternate", nextReply: "alternate / alternate" },
    { runtime: "pi", profileId: "pi", start: "[[worktree-marker]]", next: "[[worktree-marker]]", firstReply: "MOCK-PI 1: alternate", nextReply: "MOCK-PI 2: alternate" },
  ];
  const sessions: Session[] = [];
  const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
  const expectCompletedTurns = async (id: string, count: number) => {
    await expect.poll(async () => {
      const items = await studio!.api<SessionItem[]>("GET", `/api/sessions/${id}/items`);
      return items.filter((item) => item.type === "turn" && item.state === "completed").length;
    }, { timeout: 20_000 }).toBe(count);
  };
  for (const entry of cases) {
    await page.evaluate((profileId) => {
      localStorage.setItem("amo.taskDraft", JSON.stringify({ pick: { profileId, model: null }, options: { permission: "full-access" } }));
    }, entry.profileId);
    await page.getByRole("button", { name: "+ 新任务" }).click();
    await page.getByRole("textbox", { name: "任务名" }).fill(`工作树 ${entry.runtime}`);
    await page.getByRole("group", { name: "项目", exact: true }).getByRole("button", { name: workspace.name, exact: true }).click();
    await page.getByTestId("draft-worktree-open").click();
    const dialog = page.getByTestId("draft-worktree-dialog");
    await dialog.getByRole("combobox", { name: "分支" }).selectOption("feature/alternate");
    if (entry.runtime === "claude") await screenshot(app, "studio", "newtask-worktree-claude", page);
    await dialog.getByRole("button", { name: "应用" }).click();
    await page.getByRole("textbox", { name: "第一句话" }).fill(entry.start);
    await page.getByTestId("draft-start").click();
    if (entry.runtime === "claude") await page.getByRole("button", { name: "批准", exact: true }).click({ timeout: 20_000 });
    await expect(page.getByTestId("msg-agent").last()).toHaveText(entry.firstReply, { timeout: 30_000 });
    const session = (await state()).sessions.find((s) => s.profileId === entry.profileId)!;
    expect(session.runtime).toBe(entry.runtime);
    expect(session.workspaceId).toBe(workspace.id);
    expect(session.cwd).toBeTruthy();
    await expect(page.getByTestId("session-worktree")).toHaveAttribute("title", session.cwd!);
    expect(git(session.cwd!, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature/alternate"));
    await expectCompletedTurns(session.id, 1);
    sessions.push(session);
  }
  expect(readFileSync(join(sessions[0]!.cwd!, "launch-check.txt"), "utf8").trim()).toBe("alternate");

  const hostPid = () => JSON.parse(readFileSync(join(studio!.dataDir, "host.json"), "utf8")).pid as number;
  const firstPid = hostPid();
  await studio.close({ keepData: true });
  studio = await launchStudio({ ...launch, root });
  expect(hostPid()).not.toBe(firstPid);
  for (const [index, entry] of cases.entries()) {
    const { id, cwd } = sessions[index]!;
    await studio.page.getByRole("navigation", { name: "视图" }).getByRole("button", { name: "看板", exact: true }).click();
    await studio.page.getByTestId("task-card").filter({ hasText: `工作树 ${entry.runtime}` }).click();
    await expect(studio.page.getByTestId("session-worktree")).toHaveAttribute("title", cwd!);
    await studio.api("POST", `/api/sessions/${id}/messages`, { text: entry.next });
    if (entry.runtime === "claude") await studio.page.getByRole("button", { name: "批准", exact: true }).click({ timeout: 20_000 });
    await expectCompletedTurns(id, 2);
    await expect(studio.page.getByTestId("msg-agent")).toHaveCount(2);
    if (entry.nextReply) await expect(studio.page.getByTestId("msg-agent").last()).toHaveText(entry.nextReply);
  }
  expect(readFileSync(join(sessions[0]!.cwd!, "resume-check.txt"), "utf8").trim()).toBe("alternate");
  expect(git(repo, "branch", "--show-current")).toBe("main");
  expect(readFileSync(join(dir, "marker.txt"), "utf8")).toBe("main with edits");
  expect(readFileSync(join(dir, "untracked.txt"), "utf8")).toBe("keep me");
  expect(existsSync(join(dir, "launch-check.txt"))).toBe(false);
  expect(existsSync(join(dir, "resume-check.txt"))).toBe(false);
});
