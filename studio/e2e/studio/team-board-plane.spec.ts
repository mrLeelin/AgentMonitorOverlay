import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { PLANE_WORK_ITEM_DRAG, type PlaneBoardConnection, type Workspace } from "@amo-studio/protocol";
import { launchStudio } from "../support/studio.js";

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

test("Plane replaces the right work area and Studio keeps its title bar and sidebar", async ({}, testInfo) => {
  const projectId = "3af9b331-e9aa-4f1d-ae07-fcbb149ece27";
  const issueId = "6e1afba8-22ae-44c1-b4ad-223fad55ce4a";
  const card = `#issue-${issueId} a`;
  const path = `/taluo/projects/${projectId}/issues/`;
  const originalPath = "/taluo/browse/TALUO-16/";
  const requests: string[] = [];
  const boardLoads = () => requests.filter((url) => url === path).length;
  const remote = createServer((request, response) => {
    requests.push(request.url ?? "");
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
  try {
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
    await expect.poll(guestMenuItems).toEqual(["创建个人任务", "编辑", "复制链接"]);
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
  } finally {
    await close();
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  }
});
