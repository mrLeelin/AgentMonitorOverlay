import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PLANE_BOARD_API, PLANE_WORK_ITEM_DRAG, type BotRequest, type PlaneBoardConnection, type PlaneBotJob, type SessionItem, type StateSnapshot, type StudioBot, type Task, type Workspace } from "@amo-studio/protocol";
import { defaultScript, listenInStudioRange } from "@amo-studio/testkit";
import { launchStudio, screenshot } from "../support/studio.js";

const icon = (path: string) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const plus = icon("M8 4v8M4 8h8");
const person = icon("M10 12v-1.5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2V12m10 0v-1.5a2 2 0 0 0-1.5-2M8.6 5.4a2.1 2.1 0 1 1-4.2 0 2.1 2.1 0 0 1 4.2 0Zm2-2a2.1 2.1 0 0 1 0 4");

function boardFixture(mainIssueId: string) {
  const columns = [
    { title: "待定", color: "var(--txt-tertiary)", cards: [["TALUO-14", "补充策划任务的交付说明"]] },
    { title: "待办", color: "var(--txt-tertiary)", cards: [] },
    { title: "进行中", color: "var(--state-started)", cards: [["TALUO-16", "780"], ["TALUO-12", "核对 Windows 缩放下的交互和提示文字"]] },
    { title: "审查", color: "var(--state-review)", cards: [["TALUO-15", "整理交互演练的回归记录"], ["TALUO-10", "测试 3"]] },
    { title: "完成", color: "var(--state-done)", cards: [["TALUO-08", "通过团队任务的权限验证"]] },
  ];
  const actionIcons = [
    ["列表", "M3 4h10M3 8h10M3 12h10"], ["看板", "M3 3h10v10H3zM6 3v10m4-10v10"],
    ["日历", "M2.5 5h11v8h-11zM5 3v4m6-4v4"], ["表格", "M3 3h10v10H3zM3 6h10M7 6v7"], ["时间线", "M3 4h6m-4 4h7m-4 4h5"],
  ] as const;
  return `<!doctype html><html lang="zh" data-theme="light"><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    :root { --bg-canvas: #fff; --bg-surface-1: #fff; --bg-layer-1: #f6f6f6; --bg-layer-2: #fff;
      --txt-primary: #18191a; --txt-secondary: #43464b; --txt-tertiary: #62666a; --border-subtle: #ddd;
      --border-strong: #a7a9aa; --bg-accent-primary: #00669a; --txt-inverse: white;
      --state-started: #1d65ac; --state-review: #925711; --state-done: #336b41; }
    :root[data-theme="dark"] { --txt-primary: #f4f2ed; --txt-secondary: #c7c5bd; --txt-tertiary: #a8a79d; --border-strong: #737367;
      --state-started: #93c6ff; --state-review: #f0ba76; --state-done: #94c5a0; }
    body { margin: 0; font: 14px/1.45 "Segoe UI", "Microsoft YaHei UI", sans-serif; background: var(--bg-canvas); color: var(--txt-primary); }
    main { min-width: 0; height: 100vh; display: flex; flex-direction: column; }
    header { background: var(--bg-surface-1); border-bottom: 1px solid var(--border-subtle); }
    .fixture-toolbar { display: flex; align-items: center; justify-content: space-between; height: 49px; }
    .fixture-toolbar > div:first-child { flex: 1; white-space: nowrap; }
    .justify-end, .fixture-filters, .fixture-views { display: flex; align-items: center; gap: 8px; }
    .fixture-views { gap: 1px; background: var(--bg-layer-1); border-radius: 7px; padding: 2px; }
    button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--txt-secondary); min-height: 26px; padding: 3px 8px; background: var(--bg-layer-2); font: inherit; white-space: nowrap; }
    .fixture-views button, .fixture-column-header button, .fixture-add { border-color: transparent; background: transparent; }
    .fixture-views button { padding: 3px 5px; }
    .fixture-views [aria-pressed="true"] { background: var(--bg-layer-2); border-color: var(--border-subtle); }
    .fixture-create { background: var(--bg-accent-primary); color: var(--txt-inverse); border-color: transparent; font-weight: 600; }
    @media (max-width: 767px) { .fixture-filters { display: none; } }
    .horizontal-scrollbar { overflow: auto hidden; flex: 1; }
    .fixture-columns { display: flex; gap: 16px; width: max-content; min-width: 100%; height: 100%; padding: 16px; }
    .fixture-column { width: 336px; flex: none; padding: 8px; border-radius: 8px; background: var(--bg-layer-1); }
    .fixture-column-header { display: flex; align-items: center; gap: 7px; min-height: 35px; padding: 0 4px 4px; margin-bottom: 5px; font-weight: 600; }
    .fixture-count { color: var(--txt-tertiary); font-weight: 500; font-size: 12px; }
    .fixture-column-header button { margin-left: auto; padding: 3px; min-height: 24px; }
    .fixture-state { display: inline-block; width: 12px; height: 12px; flex: none; border: 1.5px solid currentColor; border-radius: 50%; }
    .fixture-issue { display: block; border: 1px solid var(--border-subtle-1, var(--border-subtle)); border-radius: 8px; padding: 12px; background: var(--bg-layer-2); color: inherit; text-decoration: none; margin-bottom: 8px; }
    .fixture-issue .gap-3 { display: flex; flex-direction: column; gap: 12px; }
    .fixture-issue .break-words { font-weight: 600; }
    .fixture-id { font-size: 11px; color: var(--txt-tertiary); font-variant-numeric: tabular-nums; }
    .fixture-meta { display: flex; gap: 5px; font-size: 11px; color: var(--txt-secondary); }
    .fixture-meta > span { display: inline-flex; align-items: center; gap: 4px; padding: 1px 5px; border: 1px solid var(--border-subtle); border-radius: 5px; }
    .fixture-meta .fixture-state { width: 9px; height: 9px; }
    .fixture-add { color: var(--txt-secondary); font-size: 12px; }
    article:not([hidden]) { position: absolute; z-index: 2; right: 0; top: 49px; bottom: 0; width: 360px; padding: 20px; background: var(--bg-layer-2); border-left: 1px solid var(--border-subtle); }
    [role="menu"] { position: fixed; z-index: 3; left: 38%; top: 180px; padding: 4px; background: var(--bg-layer-2); border: 1px solid var(--border-subtle); border-radius: 6px; }
    [role="menuitem"] { display: flex; width: 100%; padding: 4px 8px; border: 0; }
  </style>
  <div class="desktop-header">Plane 工作区导航</div>
  <div><div id="main-sidebar">Plane 侧栏</div></div>
  <main><header class="z-[18]"><div class="fixture-toolbar">
    <div class="max-w-[80%]"><span>Taluo › 工作项</span></div><div class="justify-end">
      <div class="fixture-filters md:flex"><div class="fixture-views">
        ${actionIcons.map(([label, path]) => `<button type="button" aria-label="${label}" aria-pressed="${label === "看板"}">${icon(path)}</button>`).join("")}
        </div><button type="button" aria-label="筛选">${icon("M2 4h12M4 8h8m-6 4h4")}</button><button type="button">显示</button><button type="button">分析</button>
      </div><button type="button" class="fixture-create" data-variant="primary">添加工作项</button>
    </div>
  </div></header>
  <div class="horizontal-scrollbar scrollbar-sm"><div class="fixture-columns flex-row gap-4 !p-4">
    ${columns.map(({ title, color, cards }) => {
      const state = `<span class="fixture-state" style="color:${color}" aria-hidden="true"></span>`;
      return `<section class="fixture-column bg-layer-1 w-[336px]"><div class="fixture-column-header sticky">
        ${state}<span>${title}</span><span class="fixture-count text-body-xs-medium text-tertiary">${cards.length}</span><button type="button" aria-label="新建工作项">${plus}</button>
      </div>${cards.map(([number, titleText]) => `<div class="group/kanban-block"${number === "TALUO-16" ? ` id="issue-${mainIssueId}"` : ""}>
        <a class="fixture-issue" href="#${number}" onclick="event.preventDefault(); document.querySelector('article').hidden=false"><span class="flex-col gap-3">
          <span class="fixture-id">${number}</span><span class="break-words">${titleText}</span>
          <span class="fixture-meta"><span>${state}${title}</span><span>${person}</span></span>
        </span></a></div>`).join("")}<button class="fixture-add" type="button">${plus}新建工作项</button></section>`;
    }).join("")}
  </div></div><article hidden><h1>780</h1><textarea aria-label="工作项说明"></textarea></article></main>`;
}

test("connects and reopens the Plane board without web sign-in", async () => {
  const projectId = "3af9b331-e9aa-4f1d-ae07-fcbb149ece27";
  const itemId = "6e1afba8-22ae-44c1-b4ad-223fad55ce4a";
  const states = [
    { id: "066d5cd0-4f23-4dab-a314-cc270916d04a", name: "待办", color: "#6B7280", group: "unstarted" },
    { id: "2d5324ba-00c5-41eb-8606-c32c9245240e", name: "进行中", color: "#3B82F6", group: "started" },
    { id: "8ee6b0f8-ade5-4a14-be8e-9d16ed51ddb7", name: "完成", color: "#22C55E", group: "completed" },
  ];
  const projectApi = `${PLANE_BOARD_API}/workspaces/taluo/projects/${projectId}`;
  const item = { id: itemId, number: "TALUO-16", title: "令牌看板上的工作项", stateId: states[0]!.id, priority: "none", assigneeIds: [], labelIds: [], startDate: null, dueDate: null, revision: 1, archived: false };
  const token = "fixture-plane-token-123";
  let webLoads = 0;
  let apiKeyUsedForWebSession = false;
  let webIdentity: string | null = null;
  const remote = createServer((request, response) => {
    const json = (body: object, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/api/users/me/") {
      apiKeyUsedForWebSession ||= !!request.headers["x-api-key"];
      return webIdentity ? json({ id: webIdentity }) : json({}, 401);
    }
    if (request.url === `${PLANE_BOARD_API}/catalog/` && request.headers["x-api-key"] === token) {
      return json({
        identity: { id: "plane-member", name: "Plane 成员" },
        workspaces: [{ slug: "taluo", name: "Taluo", projects: [{ id: projectId, name: "团队项目", writable: true, missing: [] }] }],
      });
    }
    if (request.url === `${projectApi}/work-items` && request.headers["x-api-key"] === token) {
      return json({ name: "团队项目", viewerId: "plane-member", writable: true, states, members: [], labels: [], items: [item] });
    }
    if (request.url === `${projectApi}/work-items/${itemId}` && request.headers["x-api-key"] === token) {
      return json({ ...item, description: "通过令牌读取的团队工作项说明", creator: "Plane 成员", files: [], comments: [], canDelete: true });
    }
    if (request.url === `${PLANE_BOARD_API}/workspaces/taluo/resolve/TALUO/16` && request.headers["x-api-key"] === token) return json({ project: projectId, ticketId: itemId });
    if (request.url === `/taluo/projects/${projectId}/issues/`) {
      webLoads++;
      return response.writeHead(200, { "content-type": "text/html" }).end('<form><input type="email"><input type="password"></form>');
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address();
  if (!address || typeof address === "string") throw new Error("Invalid Plane fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  let studio = await launchStudio();
  const teamButton = () => studio.page.getByRole("navigation", { name: "范围" }).getByRole("button", { name: "团队任务", exact: true });
  try {
    await studio.api("PUT", "/api/settings", { teamTasksEnabled: true });
    await teamButton().click();
    const { page } = studio;
    await expect(page.getByRole("button", { name: "连接 Plane" })).toBeVisible();
    await screenshot(studio.app, "studio", "plane-connect-without-amo", page);
    await page.getByLabel("Plane 地址或项目链接").fill(`${origin}/taluo/`);
    await page.getByLabel("Plane 个人访问令牌").fill(token);
    await page.getByRole("button", { name: "连接 Plane" }).click();
    await page.getByLabel("Plane 项目").selectOption(projectId);
    const card = page.getByRole("button", { name: /令牌看板上的工作项/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByText("通过令牌读取的团队工作项说明")).toBeVisible();
    await page.keyboard.press("Escape");
    await screenshot(studio.app, "studio", "plane-board-without-web-sign-in", page);
    const local = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("PlaneLocal") });
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "已关联的个人任务", workspaceId: local.id });
    await studio.api("POST", `/api/team-board/local/${task.id}/link`, { url: `${origin}/taluo/projects/${projectId}/issues/${itemId}/` });
    await page.getByTestId("scope-ws-PlaneLocal").click();
    await page.getByTestId("column-todo").getByText("已关联的个人任务", { exact: true }).click();
    await page.getByRole("button", { name: "打开 Plane 原单", exact: true }).click();
    await expect(page.getByText("通过令牌读取的团队工作项说明")).toBeVisible();
    await studio.close({ keepData: true });
    webIdentity = "another-plane-member";
    studio = await launchStudio({ root: studio.root });
    await teamButton().click();
    await expect(studio.page.getByRole("button", { name: /令牌看板上的工作项/ })).toBeVisible();
    expect(webLoads).toBe(0);
    expect(apiKeyUsedForWebSession).toBe(false);
  } finally {
    await studio.close();
    remote.close();
  }
});

const planeBotPlan = [
  "## 核对发布说明的计划",
  "",
  "- **结论** 检查项目发布说明。",
  "- **拟改范围** `release.md`。",
  "- **完成标准** 发布说明和变更记录一致。",
  "- **验证方法** 核对内容和链接。",
  "- **需要确认的缺失信息** 无。",
].join("\n");

const planeBotScenarios = [
  { name: "hands a Plane item to a Bot and retries comment writeback without repeating acceptance", approve: true, botOnly: false },
  { name: "abandons a Plane Bot plan and analyzes again without starting a worker", approve: false, botOnly: false },
  { name: "handles the Plane plan, question and acceptance from the Bot conversation", approve: true, botOnly: true },
];
for (const { name, approve, botOnly } of planeBotScenarios) test(name, async () => {
  test.setTimeout(90_000);
  const projectId = "8af9b331-e9aa-4f1d-ae07-fcbb149ece27";
  const itemId = "9e1afba8-22ae-44c1-b4ad-223fad55ce4a";
  const projectPath = `/workspaces/demo/projects/${projectId}`;
  const api = PLANE_BOARD_API + projectPath;
  const token = "fixture-plane-bot-key";
  const viewer = "plane-bot-account";
  const item = { id: itemId, number: "DEMO-5", title: "核对发布说明", stateId: "todo", priority: "none", assigneeIds: [], labelIds: [], startDate: null, dueDate: null, revision: 1, archived: false };
  const comments: Array<{ id: string; actor: string; external_id: string; external_source: string; comment_html: string }> = [];
  let rejectNative = true;
  const commentPath = `/api/v1${projectPath}/work-items/${itemId}/comments/`;
  const methods: string[] = [];
  const remote = createServer((request, response) => {
    const json = (body: object, status = 200) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.headers["x-api-key"] !== token) return json({}, 401);
    if (request.method !== "GET") methods.push(`${request.method} ${request.url}`);
    if (request.url === `${PLANE_BOARD_API}/catalog/`) return json({ identity: { id: viewer, name: "团队成员" },
      workspaces: [{ slug: "demo", name: "Demo", projects: [{ id: projectId, name: "试点项目", writable: true, missing: [] }] }] });
    if (request.url === `${api}/work-items`) return json({ name: "试点项目", viewerId: viewer, writable: true,
      states: [{ id: "todo", name: "待办", color: "#777777", group: "unstarted" }], members: [], labels: [], items: [item] });
    if (request.url === `${api}/work-items/${itemId}` && request.method === "GET") return json({ ...item, description: "检查项目发布说明。", url: `http://127.0.0.1:${remotePort}/demo/browse/DEMO-5/`, creator: "团队成员", files: [], comments: [] });
    if (request.url === `${api}/work-items/${itemId}` && request.method === "POST") return json({ message: "不支持的工作项操作" }, 400);
    if (request.url?.startsWith(commentPath) && request.method === "GET") return json({ results: comments, next_page_results: false, next_cursor: null });
    if (request.url === commentPath && request.method === "POST") {
      if (rejectNative) return json({ error: "Plane 暂时拒绝评论" }, 403);
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const comment = { ...JSON.parse(body), id: "confirmed-comment", actor: viewer };
        comments.push(comment);
        json(comment, 201);
      });
      return;
    }
    return json({}, 404);
  });
  const remotePort = await listenInStudioRange(remote);
  let studio: Awaited<ReturnType<typeof launchStudio>> | undefined;
  const checkOpinion = "建议验收：发布说明与变更记录一致，已核对内容和链接。";
  try {
    studio = await launchStudio({ mockScript: (request) => {
      const { lastUserText } = request;
      if (lastUserText.startsWith("[[mcp:") || lastUserText.startsWith("[[ask-async]]") || lastUserText.startsWith("[[shell:")) return defaultScript(request);
      return { kind: "text", text: approve && lastUserText.includes("对照检查 Plane 工作项") ? checkOpinion : lastUserText.includes("独立工作树执行") ? "已核对发布说明。" : planeBotPlan };
    } });
    const { page, app } = studio;
    const repo = studio.workspace("PlaneBotRepo");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { windowsHide: true });
    git("init", "--quiet", "-b", "main");
    await writeFile(join(repo, "release.md"), "Fixture release notes\n");
    git("add", "release.md");
    git("-c", "user.name=Test fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const baseCommit = git("rev-parse", "HEAD").toString().trim();
    if (!approve) await studio.api("POST", "/api/workspaces", { path: studio.workspace("PlaneBotOtherProject") });
    const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: repo });
    const bot = await studio.api<StudioBot>("POST", "/api/bots", { name: "试点审核员", purpose: "检查发布内容", memory: "", profileId: "codex-mock", workspaceId: null, enabled: true });
    await studio.api("PUT", "/api/settings", { teamTasksEnabled: true });
    const server = `http://127.0.0.1:${remotePort}`;
    await studio.api("POST", "/api/team-board/plane/connect", { server, token });
    await studio.api("POST", "/api/team-board/plane/select", { workspace: "demo", project: projectId });
    await page.getByRole("navigation", { name: "范围" }).getByRole("button", { name: "团队任务", exact: true }).click();
    await page.getByRole("button", { name: /核对发布说明/ }).click();
    const delegate = page.getByRole("button", { name: "交给 Bot", exact: true });
    await delegate.click();
    const dialog = page.getByRole("dialog", { name: "交给 Bot" });
    const botSelect = dialog.getByLabel("只读 Bot");
    const projectSelect = dialog.getByLabel("本地 Git 项目");
    if (!approve) {
      await expect(projectSelect.locator("option")).toHaveCount(3);
      await expect(projectSelect).toHaveValue("");
    }
    await botSelect.selectOption(bot.id);
    await projectSelect.selectOption(workspace.id);
    if (approve) await screenshot(app, "studio", "plane-bot-intake", page);
    await dialog.getByRole("button", { name: "开始接单" }).click();
    await expect(dialog.getByRole("status")).toHaveText("计划待确认", { timeout: 45_000 });
    await expect(dialog.locator("strong").filter({ hasText: "完成标准" })).toBeVisible();
    await expect(dialog.getByText(baseCommit.slice(0, 7))).toBeVisible();
    await expect(dialog.getByRole("button", { name: "打开 Bot 对话" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "打开执行任务" })).toHaveCount(0);

    const getJob = () => studio!.api<PlaneBotJob>("GET", `/api/team-board/plane/work-items/${itemId}/bot`);
    const state = () => studio!.api<StateSnapshot>("GET", "/api/state");
    const pending = await getJob();
    expect(pending).toMatchObject({ state: "awaiting-approval", taskId: null, baseCommit });
    expect(methods).toEqual([]);

    if (!approve) {
      await dialog.getByRole("button", { name: "放弃", exact: true }).click();
      await expect(dialog.getByRole("status")).toHaveText("已放弃");
      expect(await getJob()).toMatchObject({ state: "declined", taskId: null });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await delegate.click();
      await expect(dialog.getByRole("status")).toHaveText("已放弃");
      await expect(botSelect).toHaveValue(bot.id);
      await expect(projectSelect).toHaveValue(workspace.id);
      await screenshot(app, "studio", "plane-bot-declined", page);
      await dialog.getByRole("button", { name: "重新交给 Bot" }).click();
      await expect(dialog.getByRole("status")).toHaveText("计划待确认", { timeout: 45_000 });
      const renewed = await getJob();
      expect(renewed).toMatchObject({ state: "awaiting-approval", taskId: null, botId: bot.id, workspaceId: workspace.id });
      expect(renewed.botSessionId).toBeTruthy();
      expect(renewed.botSessionId).not.toBe(pending.botSessionId);
      expect((await state()).tasks.filter((task) => task.title.includes(item.number))).toEqual([]);
      expect(methods).toEqual([]);
      expect(comments).toEqual([]);
      return;
    }

    if (botOnly) {
      // The person opens the owner Bot once. The worker never needs to become the workbench's active task.
      await dialog.getByRole("button", { name: "打开 Bot 对话" }).click();
      const jobCard = page.getByTestId("plane-bot-conversation-job").filter({ hasText: item.number });
      await expect(jobCard.getByRole("status")).toHaveText("计划待确认");
      await page.getByRole("button", { name: "试点审核员 主聊天", exact: true }).click();
      await expect(jobCard.getByRole("status")).toHaveText("计划待确认");
      await jobCard.getByRole("button", { name: "查看计划" }).click();
      const botDialog = page.getByRole("dialog", { name: "Bot 工单" });
      await expect(botDialog.getByRole("heading", { name: `试点审核员 · ${item.number}` })).toBeVisible();
      await expect(botDialog.getByText(baseCommit.slice(0, 7))).toBeVisible();
      await screenshot(app, "studio", "plane-bot-conversation-plan", page);
      await botDialog.getByRole("button", { name: "开工" }).click();
      await expect.poll(async () => (await getJob()).state, { timeout: 45_000 }).toBe("failed");
      await expect(botDialog.getByRole("alert")).toContainText("还没有提交交付");
      const job = await getJob();
      const worker = (await state()).sessions.find((s) => s.taskId === job.taskId)!;
      expect(worker.cwd).toBeTruthy();
      const workerItems = () => studio!.api<SessionItem[]>("GET", `/api/sessions/${worker.id}/items`);
      expect((await workerItems()).filter((row) => row.type === "turn")).toHaveLength(2);

      // The fixture asks a genuine business question through the worker's own MCP scope.
      await studio.api("POST", `/api/sessions/${worker.id}/messages`, { text: '[[mcp: decision_request {"question":"发布说明写给谁？","options":["内测成员","所有用户"]}]]' });
      await expect(botDialog.getByTestId("decision-card")).toContainText("发布说明写给谁？");
      await screenshot(app, "studio", "plane-bot-conversation-question", page);
      await botDialog.getByRole("button", { name: "关闭", exact: true }).click();
      const focusOpened = app.waitForEvent("window");
      const focusToggle = page.getByRole("button", { name: /^Focus/ });
      await focusToggle.click();
      const focus = await focusOpened;
      await expect(focus.getByTestId("focus-needs")).toHaveText("需要你 1");
      const focusJob = focus.getByTestId("focus-plane-bot");
      await expect(focusJob).toContainText("试点审核员 · DEMO-5");
      await screenshot(app, "studio", "plane-bot-conversation-focus", focus, "focus");
      await focusJob.getByRole("button").click();
      await expect(jobCard.getByRole("button", { name: "答复 Bot" })).toBeVisible();
      await focusToggle.click();
      await page.getByRole("button", { name: "待你处理", exact: true }).click();
      await page.getByRole("region", { name: "待你处理" }).getByRole("button", { name: /试点审核员 · DEMO-5/ }).click();
      await jobCard.getByRole("button", { name: "答复 Bot" }).click();
      await botDialog.getByRole("button", { name: "内测成员", exact: true }).click();
      await expect(botDialog.getByTestId("decision-card")).toHaveCount(0);
      await expect.poll(async () => (await workerItems()).some((row) => row.type === "user" && row.text.includes("我的决定：内测成员"))).toBe(true);
      await expect.poll(async () => (await state()).sessions.find((s) => s.id === worker.id)?.status).toBe("idle");

      // An asynchronous runtime question should appear in the Bot before its worker turn ends.
      await studio.api("POST", `/api/sessions/${worker.id}/messages`, { text: "[[ask-async]] [[slow]]" });
      await botDialog.getByRole("button", { name: "答复「你最喜欢哪个季节？」" }).click();
      expect((await workerItems()).some((row) => row.type === "turn" && row.state === "running")).toBe(true);
      const runtimeQuestion = botDialog.getByTestId("question-card");
      await expect(runtimeQuestion.getByRole("heading")).toHaveText("你最喜欢哪个季节？");
      await runtimeQuestion.getByRole("radio", { name: /夏天/ }).click();
      await runtimeQuestion.getByRole("button", { name: "提交" }).click();
      await expect.poll(async () => (await workerItems()).some((row) => row.type === "question" && row.state === "answered")).toBe(true);
      await expect.poll(async () => (await state()).sessions.find((s) => s.id === worker.id)?.status).toBe("idle");

      await studio.api("POST", `/api/sessions/${worker.id}/messages`, { text: "[[shell: cmd /c echo plane-bot-permission]]" });
      const approval = botDialog.getByTestId("approval");
      await expect(approval).toContainText("plane-bot-permission");
      await screenshot(app, "studio", "plane-bot-conversation-permission", page);
      await approval.getByRole("button", { name: "拒绝", exact: true }).click();
      await expect.poll(async () => (await workerItems()).some((row) => row.type === "approval" && row.state === "declined")).toBe(true);
      await expect.poll(async () => (await state()).sessions.find((s) => s.id === worker.id)?.status).toBe("idle");

      await writeFile(join(worker.cwd!, "release.md"), "Notes for internal testers.\n");
      await studio.api("POST", `/api/tasks/${job.taskId}/workflow/submit`, { sessionId: worker.id, summary: "已更新内测公告", verification: "核对 release.md 的发布受众" });
      await expect(botDialog.getByText("等待人工验收", { exact: true })).toBeVisible();
      await expect(botDialog.getByRole("button", { name: "查看改动" })).toBeVisible();
      expect(comments).toEqual([]);
      await screenshot(app, "studio", "plane-bot-conversation-review", page);
      await botDialog.getByLabel("验收意见或退回原因").fill("补充回滚步骤。");
      await botDialog.getByRole("button", { name: "退回修改", exact: true }).click();
      await expect.poll(async () => (await workerItems()).some((row) => row.type === "user" && row.text.includes("补充回滚步骤"))).toBe(true);
      await expect.poll(async () => (await getJob()).state, { timeout: 30_000 }).toBe("failed");
      expect(comments).toEqual([]);
      await writeFile(join(worker.cwd!, "release.md"), "Notes for internal testers.\nRollback using the previous release.\n");
      await studio.api("POST", `/api/tasks/${job.taskId}/workflow/submit`, { sessionId: worker.id, summary: "已补充回滚步骤", verification: "核对最新工作树的发布受众和回滚指引" });
      await expect(botDialog.getByText("已补充回滚步骤").first()).toBeVisible();
      rejectNative = false;
      await botDialog.getByRole("button", { name: "验收通过", exact: true }).click();
      await expect(botDialog.getByText("已回写 Plane 评论", { exact: true })).toBeVisible();
      expect(comments).toHaveLength(1);
      expect(comments[0]?.comment_html).toContain("已补充回滚步骤");
      expect(git("status", "--short").toString().trim()).toBe("");
      return;
    }

    git("-c", "user.name=Test fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "after analysis");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await delegate.click();
    await expect(dialog.getByRole("status")).toHaveText("计划待确认");
    await expect(dialog.getByText("分析后项目有 1 个新提交。开工会从分析时的提交开始改；想用最新代码，请放弃后重新交给 Bot。", { exact: true })).toBeVisible();
    await screenshot(app, "studio", "plane-bot-plan", page);
    await dialog.getByRole("button", { name: "开工", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "打开执行任务" })).toBeVisible({ timeout: 45_000 });
    await dialog.getByRole("button", { name: "打开执行任务" }).click();
    const job = await getJob();
    await expect.poll(async () => (await state()).sessions.some((entry) => entry.taskId === job.taskId)).toBe(true);
    const worker = (await state()).sessions.find((entry) => entry.taskId === job.taskId)!;
    await expect.poll(async () => (await getJob()).state, { timeout: 30_000 }).toBe("failed");
    await expect.poll(async () => (await studio!.api<SessionItem[]>("GET", `/api/sessions/${worker.id}/items`)).filter((item) => item.type === "turn").at(-1)?.state, { timeout: 30_000 }).toBe("completed");
    await expect.poll(async () => (await state()).sessions.find((entry) => entry.id === worker.id)?.status).toBe("idle");
    expect(worker.cwd).toBeTruthy();
    expect(worker.cwd).not.toBe(repo);
    await page.getByTestId("new-session-toggle").click();
    await page.getByRole("button", { name: "开始新会话", exact: true }).click();
    const followup = async () => (await state()).sessions.find((entry) => entry.taskId === job.taskId && entry.id !== worker.id);
    await expect.poll(followup).toMatchObject({ cwd: worker.cwd });
    const session = (await followup())!;
    expect(execFileSync("git", ["-C", session.cwd!, "rev-parse", "HEAD"], { windowsHide: true, encoding: "utf8" }).trim()).toBe(baseCommit);
    await writeFile(join(session.cwd!, "release.md"), "Fixture release notes\nVerified release links in the worker worktree.\n");
    expect(execFileSync("git", ["-C", repo, "status", "--short"], { windowsHide: true, encoding: "utf8" }).trim()).toBe("");
    const verification = ["检查工作树中的 release.md", ...Array.from({ length: 24 }, (_, index) => `验证项 ${index + 1}：检查内容、链接及变更记录。`)].join("\n");
    await studio.api("POST", `/api/tasks/${job.taskId}/workflow/submit`, { sessionId: session.id, summary: "已核对发布说明", verification });

    await page.getByRole("navigation", { name: "范围" }).getByRole("button", { name: "团队任务", exact: true }).click();
    if (!await dialog.isVisible()) {
      await page.locator(`[data-team-ticket="${itemId}"]`).click();
      await expect(dialog.or(delegate).first()).toBeVisible();
      if (!await dialog.isVisible()) await delegate.click();
    }
    await expect(dialog.getByRole("status")).toHaveText("等待人工验收");
    await expect(dialog.getByText("已核对发布说明", { exact: true })).toBeVisible();
    const reviewOpened = app.waitForEvent("window");
    await dialog.getByRole("button", { name: "查看改动", exact: true }).click();
    const gitReview = await reviewOpened;
    await expect(gitReview).toHaveURL(/#review\?/);
    const reviewHash = new URL(gitReview.url()).hash;
    const reviewParams = new URLSearchParams(reviewHash.slice("#review?".length));
    expect(reviewParams.get("worktree")).toBe(session.id);
    expect(reviewParams.get("base")).toBe(baseCommit);
    await expect(gitReview.getByTestId("review-file").filter({ hasText: "release.md" })).toBeVisible();
    await gitReview.close();

    const analysisRequests = await studio.api<BotRequest[]>("GET", "/api/bot-requests");
    expect(analysisRequests).toHaveLength(1);
    await dialog.getByRole("button", { name: "让 Bot 对照检查", exact: true }).click();
    await expect(dialog.getByText(checkOpinion, { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(dialog.getByRole("status")).toHaveText("等待人工验收");
    expect(await getJob()).toMatchObject({ state: "review", check: { status: "completed", opinion: checkOpinion } });
    expect((await state()).tasks.find((task) => task.id === job.taskId)?.column).toBe("review");
    const allRequests = await studio.api<BotRequest[]>("GET", "/api/bot-requests");
    expect(allRequests).toHaveLength(2);
    const checkRequest = allRequests.find((request) => request.id !== analysisRequests[0]!.id);
    const checkTitle = "对照检查 Plane 工作项 DEMO-5 的交付。";
    expect(checkRequest?.text.split("\n", 1)[0]).toBe(checkTitle);
    expect(checkRequest?.text.split("【改动文件】\n", 2)[1]?.split("\n\n", 1)[0]).toContain("release.md");
    expect(methods).toEqual([]);
    await screenshot(app, "studio", "plane-bot-delivery", page);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "关闭工作项", exact: true }).click();

    await page.getByRole("button", { name: "Bot 选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "打开 Bots 工作台" }).click();
    const workbench = page.getByRole("region", { name: "Bots 工作台" });
    const planeJobs = workbench.getByRole("region", { name: "Plane 工单" });
    await expect(planeJobs.getByText("DEMO-5 · 核对发布说明", { exact: true })).toBeVisible();
    await expect(planeJobs.getByText("等待人工验收", { exact: true })).toBeVisible();
    await expect(planeJobs.getByText(checkOpinion, { exact: true })).toBeVisible();
    const record = workbench.getByTestId("bot-request").filter({ has: page.getByText(checkTitle, { exact: true }) });
    const requestText = record.locator("details").filter({ has: page.locator("summary").filter({ hasText: checkTitle }) });
    await expect(requestText.locator("summary")).toHaveText(checkTitle);
    await expect(requestText).not.toHaveAttribute("open");
    await expect(requestText.locator(".bot-request-result")).toContainText("【改动文件】");
    await expect(requestText.locator(".bot-request-result")).toBeHidden();
    await screenshot(app, "studio", "plane-bot-workbench", page);
    await planeJobs.getByRole("button", { name: "打开执行任务", exact: true }).click();

    const original = page.getByRole("region", { name: "关联的团队原单" });
    const reviewButton = original.getByRole("button", { name: "验收交付" });
    await expect(original.getByText("等待人工验收")).toBeVisible();
    await expect(page.getByTestId("workflow-result")).toHaveCount(0);
    await expect(page.getByTestId("task-description")).toHaveCount(0);
    await original.getByRole("button", { name: "原单与任务说明" }).click();
    await page.getByRole("menuitem", { name: "任务说明…" }).click();
    await expect(page.getByRole("dialog", { name: "任务说明" }).getByLabel("说明内容")).toHaveValue(/已批准的计划/);
    await page.keyboard.press("Escape");

    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await screenshot(app, "studio", "plane-bot-task-compact", page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 680));
    const conversationHeight = () => page.locator(".task-body").evaluate((element) => element.getBoundingClientRect().height);
    await expect.poll(conversationHeight).toBeGreaterThan(300);
    const beforeReview = await conversationHeight();
    await reviewButton.click();
    const review = page.getByRole("dialog", { name: "交付与验收" });
    await expect(review.getByText(checkOpinion, { exact: true })).toBeVisible();
    const result = review.getByTestId("workflow-result");
    await expect(result).toHaveAttribute("data-state", "submitted");
    await expect(result).toHaveAttribute("open", "");
    await expect(review.getByRole("button", { name: "关闭" })).toBeInViewport();
    expect(await conversationHeight()).toBe(beforeReview);
    expect(await review.locator(".plane-bot-review-body").evaluate((body) => body.scrollHeight > body.clientHeight)).toBe(true);
    await screenshot(app, "studio", "plane-bot-review", page);
    await page.keyboard.press("Escape");
    await expect(review).toHaveCount(0);
    await expect(reviewButton).toBeFocused();
    await reviewButton.click();
    const accept = result.getByRole("button", { name: "验收通过" });
    await accept.scrollIntoViewIfNeeded();
    await screenshot(app, "studio", "plane-bot-review-actions", page);
    expect(comments).toEqual([]);
    await accept.click();
    await expect(original.getByText("交付已验收，Plane 回写失败")).toBeVisible();
    await expect(result).toHaveAttribute("data-state", "accepted");
    expect(comments).toEqual([]);
    await review.getByRole("button", { name: "关闭" }).click();
    await screenshot(app, "studio", "plane-bot-writeback-failed", page);
    rejectNative = false;
    await original.getByRole("button", { name: "重试回写" }).click();
    await expect(original.getByText("已回写 Plane 评论", { exact: true })).toBeVisible();
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ actor: viewer, external_source: "AMO Studio", access: "INTERNAL", comment_html: expect.stringContaining("检查工作树中的 release.md") });
    expect(methods).toEqual([ `POST ${api}/work-items/${itemId}`, `POST ${commentPath}`, `POST ${api}/work-items/${itemId}`, `POST ${commentPath}` ]);
  } finally {
    await studio?.close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});

test("Plane replaces the right work area and Studio keeps its title bar and sidebar", async ({}, testInfo) => {
  const projectId = "3af9b331-e9aa-4f1d-ae07-fcbb149ece27";
  const issueId = "6e1afba8-22ae-44c1-b4ad-223fad55ce4a";
  const card = `#issue-${issueId} a`;
  const path = `/taluo/projects/${projectId}/issues/`;
  const originalPath = "/taluo/browse/TALUO-16/";
  const requests: string[] = [];
  let webSessionExpired = false;
  const boardLoads = () => requests.filter((url) => url === path).length;
  const remote = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/api/users/me/") {
      const id = /(?:^|;\s*)fixture-session=(fixture-(?:worker|other))(?:;|$)/.exec(request.headers.cookie ?? "")?.[1];
      return response.writeHead(id && !webSessionExpired ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify({ id }));
    }
    if (request.url === "/creator.gif") {
      return response.writeHead(200, { "content-type": "image/gif" }).end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
    }
    if (request.url !== path && request.url !== originalPath) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(boardFixture(issueId) + `
      <script>
        const renderLocation = () => {
          const isOriginal = location.pathname === ${JSON.stringify(originalPath)};
          const detail = document.querySelector('article');
          detail.hidden = !isOriginal;
          detail.querySelector('h1').textContent = isOriginal ? 'TALUO-16 · 780' : '780';
        };
        window.__reactRouterDataRouter = { navigate(path) { history.pushState({}, '', path); renderLocation(); } };
        renderLocation();
        document.querySelector('${card}').addEventListener('contextmenu', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const menu = document.createElement('div');
          menu.setAttribute('role', 'menu');
          menu.setAttribute('data-open', '');
          menu.setAttribute('data-rootownerid', 'fixture');
          Object.assign(menu.style, { position: 'fixed', left: event.clientX + 'px', top: event.clientY + 'px', zIndex: '20', background: 'var(--bg-layer-2)' });
          menu.innerHTML = '<div role="menuitem">编辑</div><div role="menuitem">复制链接</div>';
          menu.addEventListener('keydown', (key) => { if (key.key === 'Escape') menu.remove(); });
          document.body.append(menu);
        });
      </script>`);
  });
  await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address();
  if (!address || typeof address === "string") throw new Error("Invalid Plane fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const { app, page, api, workspace, close } = await launchStudio();
  const catalog: PlaneBoardConnection = {
    available: true, legacy: false, server: origin, selected: { workspace: "taluo", project: projectId },
    catalog: { identity: { id: "fixture-worker", name: "测试成员" }, workspaces: [
      { slug: "taluo", name: "Taluo", projects: [{ id: projectId, name: "Plane 演练工程", writable: true, missing: [] }] },
    ] },
  };
  let connection = catalog;
  const sidebarTeam = page.getByRole("navigation", { name: "范围" }).getByRole("button", { name: "团队任务", exact: true });
  const features = async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const advanced = dialog.getByRole("button", { name: "高级设置", exact: true });
    if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
    await dialog.getByRole("tab", { name: "功能开关", exact: true }).click();
    return dialog.getByTestId("feature-teamtasks");
  };
  try {
    const identities = ["fixture-worker", "fixture-other"].map((id) => ({ id, partition: `persist:amo-plane-${createHash("sha256").update(JSON.stringify([origin, id])).digest("hex").slice(0, 32)}` }));
    await app.evaluate(async ({ session }, { origin, identities }) => {
      for (const { id, partition } of identities) await session.fromPartition(partition).cookies.set({ url: origin, name: "fixture-session", value: id });
    }, { origin, identities });
    const local = await api<Workspace>("POST", "/api/workspaces", { path: workspace("LocalWorkspace") });
    const second = await api<Workspace>("POST", "/api/workspaces", { path: workspace("TopicWorkspace") });
    await api("POST", "/api/topics", { title: "拖入专题", workspaceIds: [second.id] });
    await api("POST", "/api/tasks", { title: "本地任务详情", workspaceId: local.id });
    await page.route("**/api/team-board/plane", (route) => route.fulfill({ json: connection }));
    await page.route(`**/api/team-board/plane/work-items/${issueId}`, (route) => route.fulfill({ json: { id: issueId, number: "TALUO-16", title: "780" } }));
    const originalUrl = origin + originalPath;
    await page.route("**/api/team-board/local/*/reference", (route) => route.fulfill({
      json: { url: originalUrl, number: "TALUO-16", title: "780", creator: "测试成员", creatorAvatarUrl: origin + "/creator.gif" },
    }));
    const initialSwitch = await features();
    await expect(initialSwitch).not.toBeChecked();
    await expect(sidebarTeam).toHaveCount(0);
    await initialSwitch.click();
    await expect(sidebarTeam).toHaveCount(1);
    await page.keyboard.press("Escape");
    const scope = page.getByTestId("scope-ws-LocalWorkspace");
    await scope.click();
    await page.getByTestId("column-todo").getByText("本地任务详情", { exact: true }).click();
    await expect(page.getByTestId("task-title")).toHaveText("本地任务详情");
    const source = page.getByRole("region", { name: "关联的团队原单" });
    const creator = source.getByRole("img", { name: "提出人 测试成员" });
    const original = source.getByRole("button", { name: "打开 Plane 原单" });
    await expect.poll(() => creator.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    const centers = await source.locator(".tb-source-row").evaluate((row) => Array.from(row.children, (child) => {
      const bounds = child.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    }));
    expect(centers).toHaveLength(4);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    const planePage = (url: string) => app.evaluate(async ({ BrowserWindow, WebContentsView }, url) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const view = win.contentView.children.find((child) => child instanceof WebContentsView && child.webContents.getURL() === url);
      if (!(view instanceof WebContentsView) || !view.getVisible()) return null;
      return await view.webContents.executeJavaScript("({ title: document.querySelector('article:not([hidden]) h1')?.textContent, documentStart: performance.timeOrigin })");
    }, url);
    await original.click();
    await expect(page.getByRole("region", { name: "Plane 团队任务", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "团队任务", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => planePage(originalUrl)).toMatchObject({ title: "TALUO-16 · 780" });
    const openedOriginal = await planePage(originalUrl);
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { __amoOpenedUrls?: string[] }).__amoOpenedUrls ?? [])).toEqual([]);
    await page.getByTestId("nav-back").click();
    await expect(page.getByTestId("task-title")).toHaveText("本地任务详情");
    const sidebar = await page.locator(".scope-nav").elementHandle();
    const titleBar = await page.locator(".topbar").elementHandle();
    const nav = page.getByRole("navigation", { name: "范围" });
    const open = nav.getByRole("button", { name: "团队任务", exact: true });
    await expect(nav.locator(".wb-nav-team + [data-testid='scope-all']")).toHaveCount(1);
    await expect(page.locator(".topbar").getByRole("button", { name: /团队任务|团队连接设置/ })).toHaveCount(0);
    const documentRequests = () => requests.filter((url) => url === path || url === originalPath).length;
    expect(documentRequests()).toBe(1);
    await open.click();
    await expect.poll(() => planePage(origin + path)).toMatchObject({ documentStart: openedOriginal.documentStart });
    await open.click();
    await original.click();
    await expect.poll(() => planePage(originalUrl)).toEqual(openedOriginal);
    expect(documentRequests()).toBe(1);
    await page.getByTestId("nav-back").click();
    await expect(page.getByTestId("task-title")).toHaveText("本地任务详情");
    await open.click();
    await expect(page.getByRole("region", { name: "Plane 团队任务", exact: true })).toBeVisible();
    expect(await sidebar.evaluate((node) => node.isConnected)).toBe(true);
    expect(await titleBar.evaluate((node) => node.isConnected)).toBe(true);
    await expect(open).toHaveAttribute("aria-pressed", "true");
    await expect(scope).toHaveAttribute("aria-current", "false");
    await expect(page.locator(".topbar .brand-scope")).toHaveText("LocalWorkspace");
    await expect(page.getByTestId("topbar-marks")).toBeVisible();
    await expect(page.getByTestId("open-scratchpad")).toBeVisible();
    await expect(page.getByTestId("focus-toggle")).toBeVisible();
    await expect(page.locator(".viewbar, .board, .tt-board-row, [data-testid='task-title']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "并排显示" })).toHaveCount(0);

    await expect.poll(async () => app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      return child?.executeJavaScript(`(() => {
        const breadcrumb = document.querySelector('main header .fixture-toolbar > div > span:not([id])');
        const title = document.querySelector('#amo-studio-team-project');
        const gear = document.querySelector('#amo-studio-team-settings');
        const chromeHidden = getComputedStyle(document.querySelector('.desktop-header')).display === 'none';
        return breadcrumb && gear && chromeHidden ? {
          breadcrumbHidden: getComputedStyle(breadcrumb).display === 'none',
          projectTitle: title?.textContent,
          gearInToolbar: gear.parentElement?.classList.contains('justify-end'),
          previous: gear.previousElementSibling?.textContent,
          label: gear.getAttribute('aria-label'),
        } : null;
      })()`);
    }, origin + path)).toEqual({ breadcrumbHidden: true, projectTitle: "Plane 演练工程", gearInToolbar: true, previous: "添加工作项", label: "团队连接设置" });
    const check = await app.evaluate(async ({ webContents }, { url, cardSelector }) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return child.executeJavaScript(`(() => {
        document.querySelector(${JSON.stringify(cardSelector)}).click();
        return { title: document.querySelector('article:not([hidden]) h1').textContent, bridge: typeof window.amo,
          sidebarHidden: Array.from(document.querySelectorAll('#main-sidebar')).every((node) => node.getClientRects().length === 0) };
      })()`);
    }, { url: origin + path, cardSelector: card });
    expect(check).toEqual({ title: "780", bridge: "undefined", sidebarHidden: true });
    const nativeView = () => app.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      const guest = win.contentView.children.find((view) => view instanceof WebContentsView && view.webContents.getURL() === url);
      return guest instanceof WebContentsView ? { id: guest.webContents.id, visible: guest.getVisible(), bounds: guest.getBounds(), zoom: win.webContents.getZoomFactor() } : null;
    }, origin + path);
    const matchRightPane = async () => {
      const pane = await page.locator(".main-col").boundingBox();
      const left = await page.locator(".scope-nav").boundingBox();
      const top = await page.locator(".topbar").boundingBox();
      const guest = await nativeView();
      if (!guest?.visible || !pane || !left || !top) return false;
      const { bounds, zoom } = guest;
      return pane.x === left.x + left.width && pane.y >= top.y + top.height && bounds.x === Math.ceil(pane.x * zoom) &&
        bounds.y === Math.ceil(pane.y * zoom) && Math.abs(bounds.width - pane.width * zoom) <= 1 &&
        Math.abs(bounds.height - pane.height * zoom) <= 1;
    };
    await expect.poll(matchRightPane).toBe(true);
    const layout = () => app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return child.executeJavaScript(`(() => {
        const board = document.querySelector('.horizontal-scrollbar');
        const create = getComputedStyle(document.querySelector('.fixture-create'));
        return { theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme,
          column: document.querySelector('.fixture-column').offsetWidth, scrolls: board.scrollWidth > board.clientWidth,
          filters: getComputedStyle(document.querySelector('.fixture-filters')).display, createFill: create.backgroundColor, createText: create.color };
      })()`);
    }, origin + path);
    const capture = async (name: string) => {
      await page.evaluate(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await Promise.race([
          Promise.allSettled(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
            .map((animation) => animation.finished)),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      });
      const images = await app.evaluate(async ({ BrowserWindow, WebContentsView }, url) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const guest = win.contentView.children.find((view) => view instanceof WebContentsView && view.webContents.getURL() === url) as import("electron").WebContentsView;
        await guest.webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))`);
        const [shell, plane] = await Promise.all([win.webContents.capturePage(), guest.webContents.capturePage()]);
        return { shell: shell.toPNG().toString("base64"), plane: plane.toPNG().toString("base64"), bounds: guest.getBounds() };
      }, origin + path);
      await mkdir(testInfo.outputDir, { recursive: true });
      await writeFile(testInfo.outputPath(`${name}-shell.png`), Buffer.from(images.shell, "base64"));
      await writeFile(testInfo.outputPath(`${name}-board.png`), Buffer.from(images.plane, "base64"));
      await writeFile(testInfo.outputPath(`${name}-bounds.json`), JSON.stringify(images.bounds));
    };
    const guestDetail = (hidden: boolean) => app.evaluate(async ({ webContents }, { url, hidden }) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return child.executeJavaScript(`document.querySelector('article').hidden = ${hidden}`);
    }, { url: origin + path, hidden });
    const setTheme = (theme: "dark" | "light") => page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await expect.poll(layout).toMatchObject({ theme: "light", scheme: "light", scrolls: false, filters: "flex" });
    expect((await layout()).column).toBeGreaterThan(216);
    const boardRequests = requests.length;
    await setTheme("dark");
    await expect.poll(layout).toMatchObject({ theme: "dark", scheme: "dark", createFill: "rgb(201, 238, 151)", createText: "rgb(26, 36, 20)" });
    const darkColumnWidth = (await layout()).column;
    await app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      // Plane clears the root attributes during hydration, then applies its own saved appearance.
      await child.executeJavaScript(`(() => {
        const root = document.documentElement;
        delete root.dataset.amoStudioTeamTheme;
        delete root.dataset.theme;
        root.dataset.theme = "light";
      })()`);
    }, origin + path);
    await expect.poll(layout).toMatchObject({ theme: "dark", scheme: "dark", column: darkColumnWidth });
    expect(requests).toHaveLength(boardRequests);
    await guestDetail(true);
    await capture("team-tasks-dark");
    await guestDetail(false);
    const clickGuest = (selector: string, button: "left" | "right") => app.evaluate(async ({ webContents }, { url, selector, button }) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      const point = await child.executeJavaScript(`(() => {
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      child.debugger.attach("1.3");
      try {
        await child.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...point });
        await child.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...point });
      } finally { child.debugger.detach(); }
    }, { url: origin + path, selector, button });
    await clickGuest(card, "right");
    const guestMenuItems = () => app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return child.executeJavaScript("Array.from(document.querySelectorAll('[role=menuitem]'), (item) => item.textContent)");
    }, origin + path);
    await expect.poll(guestMenuItems).toEqual(["创建个人任务", "交给 Bot", "编辑", "复制链接"]);
    await page.route(`**/api/team-board/plane/work-items/${issueId}/bot`, (route) => route.fulfill({ json: null }));
    await clickGuest("#amo-studio-delegate-to-bot", "left");
    const botIntake = page.getByRole("dialog", { name: "交给 Bot" });
    await expect(botIntake).toContainText("TALUO-16 · 780");
    await botIntake.getByRole("button", { name: "取消" }).click();
    await expect.poll(matchRightPane).toBe(true);
    await clickGuest(card, "right");
    await expect.poll(guestMenuItems).toEqual(["创建个人任务", "交给 Bot", "编辑", "复制链接"]);
    await clickGuest("#amo-studio-create-personal-task", "left");
    const personal = page.getByRole("dialog", { name: "创建个人任务" });
    await expect(personal).toContainText("TALUO-16 · 780");
    await expect(personal.getByRole("textbox", { name: "任务名" })).toHaveValue("780");
    await expect(personal.getByTestId("draft-file")).toBeEnabled();
    await expect(personal.getByTestId("draft-start")).toBeEnabled();
    await personal.getByRole("button", { name: "取消" }).click();
    await expect.poll(guestMenuItems).toEqual([]);
    await expect.poll(matchRightPane).toBe(true);
    const guestPayload = await app.evaluate(async ({ webContents }, { url, card, type }) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      return child.executeJavaScript(`(() => {
        const transfer = new DataTransfer();
        document.querySelector(${JSON.stringify(card)}).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
        return transfer.getData(${JSON.stringify(type)});
      })()`) as Promise<string>;
    }, { url: origin + path, card, type: PLANE_WORK_ITEM_DRAG });
    expect(guestPayload).toMatch(new RegExp(`^[0-9a-f-]{36}:${issueId}$`));
    const transfer = await page.evaluateHandle(({ type, text }) => {
      const data = new DataTransfer();
      data.setData(type, text);
      return data;
    }, { type: PLANE_WORK_ITEM_DRAG, text: guestPayload });
    const dropOn = async (target: ReturnType<typeof page.getByTestId>) => {
      await target.dispatchEvent("dragover", { dataTransfer: transfer });
      await expect(target.locator("..")).toHaveAttribute("data-plane-drag-over", "");
      await target.dispatchEvent("drop", { dataTransfer: transfer });
      await expect(personal).toContainText("TALUO-16 · 780");
      await expect(personal.getByRole("group", { name: "项目", exact: true }).getByRole("button", { name: /TopicWorkspace/ })).toHaveAttribute("aria-pressed", "true");
    };
    await dropOn(page.getByTestId("scope-ws-TopicWorkspace"));
    const topicChip = personal.getByRole("group", { name: "专题", exact: true }).getByRole("button", { name: "拖入专题" });
    await expect(topicChip).toHaveAttribute("aria-pressed", "false");
    await personal.getByRole("button", { name: "取消" }).click();
    await dropOn(page.getByTestId("scope-topic-拖入专题"));
    await expect(topicChip).toHaveAttribute("aria-pressed", "true");
    await personal.getByRole("button", { name: "取消" }).click();
    await transfer.dispose();
    await expect.poll(matchRightPane).toBe(true);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(960, 740));
    await expect.poll(matchRightPane).toBe(true);
    await setTheme("light");
    await expect.poll(layout).toMatchObject({ theme: "light", scheme: "light", column: 216, scrolls: true, filters: "flex" });
    await guestDetail(true);
    await capture("team-tasks-light-narrow");
    await guestDetail(false);
    const paneX = (await nativeView())!.bounds.x;
    await page.getByTestId("nav-collapse").click();
    await expect.poll(async () => (await nativeView())!.bounds.x).toBeLessThan(paneX);
    await expect(open).toBeVisible();
    await expect.poll(matchRightPane).toBe(true);
    await page.getByTestId("nav-expand").click();
    await expect.poll(matchRightPane).toBe(true);

    await page.getByRole("button", { name: "最近会话" }).click();
    await expect(page.getByRole("region", { name: "最近会话" })).toBeVisible();
    await expect.poll(async () => (await nativeView())?.visible).toBe(false);
    await page.getByRole("button", { name: "最近会话" }).click();
    await expect.poll(matchRightPane).toBe(true);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings).toBeVisible();
    await expect.poll(async () => (await nativeView())?.visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect.poll(matchRightPane).toBe(true);
    await expect.poll(() => app.evaluate(async ({ webContents }, url) => {
      return webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)?.executeJavaScript("!!document.querySelector('article:not([hidden])')");
    }, origin + path)).toBe(true);
    const originalView = (await nativeView())!.id;
    const originalLoads = boardLoads();
    await app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      await child.executeJavaScript(`(() => {
        document.querySelector('textarea').value = '未保存的说明';
        document.querySelector('.horizontal-scrollbar').scrollLeft = 100;
      })()`);
      await child.executeJavaScript("document.getElementById('amo-studio-team-settings').click()").catch(() => {});
    }, origin + path);
    await expect(page.getByLabel("Plane 工作区")).toHaveValue("taluo");
    await expect.poll(nativeView).toMatchObject({ id: originalView, visible: false });

    await page.getByRole("button", { name: "返回工作项" }).click();
    await expect(page.getByRole("region", { name: "Plane 团队任务" })).toBeVisible();
    await expect.poll(matchRightPane).toBe(true);
    expect(requests.some((request) => request.startsWith("/.amo-studio/"))).toBe(false);
    await open.click();
    await expect(page.locator(".viewbar")).toBeVisible();
    await expect(page.getByTestId("task-title")).toHaveText("本地任务详情");
    await expect(scope).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#studio-team-board")).toHaveCount(0);
    await expect.poll(nativeView).toMatchObject({ id: originalView, visible: false });
    await open.click();
    await expect.poll(matchRightPane).toBe(true);
    expect((await nativeView())!.id).toBe(originalView);
    const retained = () => app.evaluate(async ({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
      return child?.executeJavaScript(`({
        details: !!document.querySelector('article:not([hidden])'),
        draft: document.querySelector('textarea').value,
        scroll: document.querySelector('.horizontal-scrollbar').scrollLeft,
      })`).catch(() => null);
    }, origin + path);
    expect(await retained()).toEqual({ details: true, draft: "未保存的说明", scroll: 100 });
    expect(boardLoads()).toBe(originalLoads);

    await app.evaluate(({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      child.emit("before-input-event", { preventDefault() {} }, { type: "keyDown", key: "F5" });
    }, origin + path);
    await expect.poll(boardLoads).toBe(originalLoads + 1);
    await expect.poll(retained).toEqual({ details: false, draft: "", scroll: 0 });

    await scope.click();
    await expect(page.getByTestId("column-todo")).toBeVisible();
    connection = { ...catalog, catalog: { ...catalog.catalog!, identity: { id: "fixture-other", name: "另一个账号" } } };
    await open.click();
    await expect.poll(boardLoads).toBe(originalLoads + 2);
    await expect.poll(matchRightPane).toBe(true);
    expect((await nativeView())!.id).not.toBe(originalView);

    await page.route("**/api/team-board/plane/work-items", (route) => route.fulfill({
      json: { name: "Plane 演练工程", viewerId: "fixture-other", writable: true, states: [], members: [], labels: [], items: [] },
    }));
    webSessionExpired = true;
    await app.evaluate(({ webContents }, url) => {
      const child = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
      void child.executeJavaScript("fetch('/api/users/me/', {cache: 'no-store'})").catch(() => {});
    }, origin + path);
    await expect(page.getByText("这个项目还没有工作项。", { exact: true })).toBeVisible();
    await expect.poll(nativeView).toBeNull();

    const activeSwitch = await features();
    await expect(activeSwitch).toBeChecked();
    await activeSwitch.click();
    await expect(sidebarTeam).toHaveCount(0);
    await expect.poll(nativeView).toBeNull();
    await expect(page.getByTestId("column-todo")).toBeVisible();
    await screenshot(app, "studio", "team-tasks-disabled", page);
    await page.keyboard.press("Escape");
    await page.getByTestId("column-todo").getByText("本地任务详情", { exact: true }).click();
    await expect(source).toHaveCount(0);
    await page.getByTestId("task-more").click();
    await expect(page.getByRole("menuitem", { name: "添加 Plane 原单链接…" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const restoreSwitch = await features();
    await expect(restoreSwitch).not.toBeChecked();
    await restoreSwitch.click();
    await expect(sidebarTeam).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("task-title")).toHaveText("本地任务详情");
    await expect(original).toBeVisible();
  } finally {
    await close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});
