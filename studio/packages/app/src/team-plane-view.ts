import { createHash } from "node:crypto";
import { app, ipcMain, Menu, session, WebContentsView, type BrowserWindow, type Rectangle } from "electron";
import { PLANE_WORK_ITEM_DRAG } from "@amo-studio/protocol";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const settingsButton = "amo-studio-team-settings";
const personalMenuItem = "amo-studio-create-personal-task";
const projectTitle = "amo-studio-team-project";
// Plane CE 1.5 renders the issue toolbar as Header.LeftItem followed by Header.RightItem inside AppHeader.
const header = '[class~="z-[18]"]';
const projectBreadcrumbs = '[class~="max-w-[80%]"]';
const projectActions = `${header} ${projectBreadcrumbs} + .justify-end`;
const projectToolbar = `${header} :has(> ${projectBreadcrumbs} + .justify-end > #${settingsButton})`;
const kanban = '.horizontal-scrollbar.scrollbar-sm';
const kanbanColumn = '[class~="w-[336px]"].bg-layer-1';

// Keep Plane's controls and layouts in place. The embedded work area uses Studio's surfaces over Propel's semantic colors.
const PROJECT_CHROME = `
  :root[data-amo-studio-team-theme] {
    --bg-canvas: light-dark(#fafbf6, #131313);
    --bg-surface-1: var(--bg-canvas);
    --bg-layer-1: light-dark(#eff2e9, #1e1f1c);
    --bg-layer-2: light-dark(#fff, #252622);
    --border-subtle: light-dark(#d4dacb, #383834);
    --border-subtle-1: var(--border-subtle);
    --amo-team-focus: light-dark(#466827, #c9ee97);
    --amo-team-column: clamp(216px, calc((100vw - 88px) / 5), 300px);
  }
  :root[data-amo-studio-team-theme="light"] { color-scheme: light !important; }
  :root[data-amo-studio-team-theme="dark"] { color-scheme: dark !important; }
  .desktop-header, [class~="z-[26]"]:has(a[href$="/settings"]),
  #main-sidebar, #main-sidebar + [role="complementary"] { display: none !important; }
  .desktop-header + div > div:has(> div > #full-screen-portal) { padding: 0 !important; }
  ${projectToolbar} { gap: 12px; padding-inline: 18px; }
  ${projectToolbar} > ${projectBreadcrumbs} { min-width: 0; flex-wrap: nowrap; }
  ${projectToolbar} > ${projectBreadcrumbs} > :not(#${projectTitle}) { display: none !important; }
  #${projectTitle} {
    display: block; overflow: hidden; text-overflow: ellipsis;
    font: 650 15px/1.4 "Segoe UI", "Microsoft YaHei UI", sans-serif; color: var(--txt-primary);
  }
  ${projectActions}:has(> #${settingsButton}) { margin-inline-start: auto; flex: none; }
  /* Plane hides these desktop filters at 768px, even when only Studio's sidebar uses the remaining window width. */
  @media (min-width: 600px) {
    ${projectActions}:has(> #${settingsButton}) > [class~="md:flex"] { display: flex; }
  }
  ${projectActions}:has(> #${settingsButton}) > button[data-variant="primary"] {
    --bg-accent-primary: #c9ee97;
    --bg-accent-primary-hover: light-dark(#b5df7a, #ddf8bc);
    --bg-accent-primary-active: var(--bg-accent-primary-hover);
    --txt-inverse: #1a2414;
    --border-accent-strong: var(--amo-team-focus);
  }
  #${settingsButton} {
    display: inline-grid; flex: none; place-items: center; width: 28px; height: 28px; padding: 0;
    border: 1px solid var(--border-subtle, currentColor); border-radius: 6px;
    color: var(--txt-secondary, inherit); background: transparent; cursor: pointer;
  }
  #${settingsButton}:hover { background: var(--bg-layer-1); color: var(--txt-primary); }
  #${settingsButton}:focus-visible { outline: 2px solid var(--amo-team-focus, currentColor); outline-offset: 2px; }
  body > #${settingsButton} { position: fixed; inset-block-start: 10px; inset-inline-end: 16px; z-index: 27; }
  :root[data-amo-studio-team-theme] ${kanban}:has(${kanbanColumn}) { background: var(--bg-canvas); }
  ${kanban} [class~="flex-row"].gap-4:has(> ${kanbanColumn}),
  ${kanban} .gap-4:has(> ${kanbanColumn}.rounded-t-lg, > ${kanbanColumn}.rounded-b-lg) { gap: 12px; }
  ${kanban} [class~="!p-4"]:has(> ${kanbanColumn}) { padding: 14px 18px !important; }
  ${kanban} ${kanbanColumn} { width: var(--amo-team-column, 336px); }
  ${kanban} ${kanbanColumn} > .sticky [class~="text-body-xs-medium"].text-tertiary { font-variant-numeric: tabular-nums; }
  ${kanban} [class~="group/kanban-block"] > a {
    padding: 10px; border-radius: 8px; box-shadow: none; transition-property: background-color, border-color;
  }
  ${kanban} [class~="group/kanban-block"] > a:hover { border-color: var(--border-strong); box-shadow: none; }
  ${kanban} [class~="group/kanban-block"] > a:focus-visible { outline: 2px solid var(--amo-team-focus); outline-offset: -2px; }
  ${kanban} [class~="group/kanban-block"] > a .break-words { overflow-wrap: anywhere; }
  ${kanban} [class~="group/kanban-block"] > a .flex-col.gap-3 { gap: 8px; }
  @media (prefers-reduced-motion: reduce) {
    ${kanban} [class~="group/kanban-block"] > a { transition: none; }
  }
  #${personalMenuItem} { text-align: start; }
  #${personalMenuItem}:is(:hover, :focus-visible) { background: color-mix(in srgb, currentColor 8%, transparent); }
`;

function projectControlsScript(projectPath: string, name: string, settingsUrl: string, personalTaskPrefix: string, viewId: string): string {
  return TEAM_THEME_SYNC + `(() => {
    if (document.getElementById(${JSON.stringify(settingsButton)})) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = ${JSON.stringify(settingsButton)};
    button.title = "团队连接设置";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M6.9 1.5h2.2l.4 1.8 1.2.5 1.6-1 1.5 1.5-1 1.6.5 1.2 1.8.4v2.2l-1.8.4-.5 1.2 1 1.6-1.5 1.5-1.6-1-1.2.5-.4 1.8H6.9l-.4-1.8-1.2-.5-1.6 1-1.5-1.5 1-1.6-.5-1.2-1.8-.4V6.9l1.8-.4.5-1.2-1-1.6 1.5-1.5 1.6 1 1.2-.5Z"/><circle cx="8" cy="8" r="2.2"/></svg>';
    button.addEventListener("click", () => location.assign(${JSON.stringify(settingsUrl)}));
    const title = document.createElement("span");
    title.id = ${JSON.stringify(projectTitle)};
    title.textContent = ${JSON.stringify(name)};
    title.title = title.textContent;
    const update = () => {
      const atBoard = location.pathname.replace(/\\/$/, "") === ${JSON.stringify(projectPath)};
      const toolbar = atBoard && document.querySelector(${JSON.stringify(projectActions)});
      const login = document.querySelector('form input[type="email"], form input[type="password"]');
      const container = toolbar || ((atBoard || login) ? document.body : null);
      if (!container) button.remove();
      else if (button.parentElement !== container) container.append(button);
      const left = toolbar && toolbar.previousElementSibling;
      if (!left) title.remove();
      else if (title.parentElement !== left) left.prepend(title);
    };
    // Plane handles contextmenu itself, so Chromium never asks Electron for the card menu.
    const openMenus = () => [...document.querySelectorAll('[role="menu"][data-open][data-rootownerid]')];
    const copy = document.createElement("button");
    copy.type = "button";
    copy.id = ${JSON.stringify(personalMenuItem)};
    copy.tabIndex = -1;
    copy.setAttribute("role", "menuitem");
    copy.innerHTML = '<svg class="shrink-0" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8"/><rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3"/></svg><span>创建个人任务</span>';
    let pending = null;
    let itemId = null;
    const insert = () => {
      if (!pending) return;
      const menu = openMenus().find((element) => !pending.prior.has(element));
      const first = menu?.querySelector(':scope > [role="menuitem"]:not([data-disabled])');
      if (!menu || !first) return;
      itemId = pending.id;
      pending = null;
      copy.className = first.className;
      menu.prepend(copy);
    };
    const itemOf = (element) => {
      const card = element instanceof Element && element.closest('[id^="issue-"],[data-entity-id]');
      const id = card && (card.getAttribute("data-entity-id") ?? card.id.slice(6));
      return id && ${uuid}.test(id) ? id : null;
    };
    window.addEventListener("dragstart", (event) => {
      const id = itemOf(event.target);
      if (!id || !event.dataTransfer) return;
      event.dataTransfer.setData(${JSON.stringify(PLANE_WORK_ITEM_DRAG)}, ${JSON.stringify(viewId + ":")} + id);
      event.dataTransfer.effectAllowed = "copyMove";
    }, true);
    window.addEventListener("contextmenu", (event) => {
      pending = null;
      itemId = null;
      copy.remove();
      const id = itemOf(event.target);
      if (!id) return;
      const opening = { id, prior: new Set(openMenus()) };
      pending = opening;
      setTimeout(() => { if (pending === opening) pending = null; }, 1000);
    }, true);
    window.addEventListener("pointerdown", () => { pending = null; }, true);
    copy.addEventListener("click", (event) => {
      if (!itemId) return;
      event.preventDefault();
      event.stopPropagation();
      const url = ${JSON.stringify(personalTaskPrefix)} + itemId;
      copy.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      window.open(url, "_blank", "noopener");
    });
    window.addEventListener("keydown", (event) => {
      const menu = copy.parentElement;
      if (!menu?.hasAttribute("data-open") || !menu.contains(document.activeElement)) return;
      const first = copy.nextElementSibling;
      const focused = document.activeElement;
      if (event.key === "Home" || (event.key === "ArrowUp" && focused === first) || (event.key === "ArrowDown" && focused === menu)) {
        event.preventDefault();
        event.stopPropagation();
        copy.focus();
      } else if (event.key === "ArrowDown" && focused === copy && first instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    }, true);
    new MutationObserver(() => { update(); insert(); }).observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["data-open"],
    });
    update();
  })();`;
}

type Target = { url: URL; originalUrl?: URL; identity: string; name: string };
type TeamTheme = "light" | "dark";
type PlaneView = { target: Target; owner: BrowserWindow; view: WebContentsView; id: string; ready: boolean; visible: boolean; theme: TeamTheme };
const controlsWorld = 1001;

// Plane can clear both attributes during hydration. Keep the selected theme in the isolated world so the
// observer can restore the display without modifying Plane's stored preference.
const TEAM_THEME_SYNC = `(() => {
  if (globalThis.__amoStudioSetTeamTheme) return;
  const root = document.documentElement;
  let theme;
  const sync = () => {
    if (!theme) return;
    if (root.dataset.amoStudioTeamTheme !== theme) root.dataset.amoStudioTeamTheme = theme;
    if (root.dataset.theme !== theme) root.dataset.theme = theme;
  };
  globalThis.__amoStudioSetTeamTheme = (next) => { theme = next; sync(); };
  new MutationObserver(sync).observe(root, {
    attributes: true, attributeFilter: ["data-theme", "data-amo-studio-team-theme"],
  });
})();`;

function applyTeamTheme(contents: Electron.WebContents, theme: TeamTheme) {
  return contents.executeJavaScriptInIsolatedWorld(controlsWorld, [{ code:
    `globalThis.__amoStudioSetTeamTheme(${JSON.stringify(theme)});`,
  }]).catch(() => undefined);
}

function originalOf(value: unknown, origin: string): URL | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const url = URL.parse(value);
  if (!url || url.origin !== origin || url.username || url.password) return null;
  const direct = /^\/([a-z0-9_-]+)\/projects\/([a-f0-9-]+)\/(?:issues|work-items)\/([a-f0-9-]+)\/?$/i.exec(url.pathname);
  if (/^\/[a-z0-9_-]+\/browse\/[a-z0-9_-]+-\d{1,9}\/?$/i.test(url.pathname) ||
      (direct && uuid.test(direct[2]!) && uuid.test(direct[3]!))) return url;
  return null;
}

async function navigatePlanePage(contents: Electron.WebContents, url: URL): Promise<boolean> {
  if (contents.getURL() === url.href) return true;
  if (URL.parse(contents.getURL())?.origin !== url.origin) return false;
  // Plane CE's browser router must run in the page world. It keeps the existing document and stores alive.
  const path = url.pathname + url.search + url.hash;
  return contents.executeJavaScript(`(async () => {
    const router = window.__reactRouterDataRouter;
    if (typeof router?.navigate !== "function") return false;
    await router.navigate(${JSON.stringify(path)});
    return true;
  })()`).catch(() => false);
}

function targetOf(value: unknown): Target | null {
  const input = value as { server?: unknown; workspace?: unknown; project?: unknown; identity?: unknown; name?: unknown; originalUrl?: unknown } | null;
  if (!input || typeof input.server !== "string" || input.server.length > 512 ||
      typeof input.workspace !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(input.workspace) ||
      typeof input.project !== "string" || !uuid.test(input.project) ||
      typeof input.identity !== "string" || !input.identity || input.identity.length > 160) return null;
  try {
    const url = new URL(input.server);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    url.pathname = `/${input.workspace}/projects/${input.project}/issues/`;
    url.search = ""; url.hash = "";
    const name = typeof input.name === "string" ? input.name.trim().slice(0, 200) : "";
    const originalUrl = originalOf(input.originalUrl, url.origin);
    if (input.originalUrl !== undefined && !originalUrl) return null;
    return { url, originalUrl: originalUrl ?? undefined, identity: input.identity, name: name || "团队任务" };
  } catch { return null; }
}

export function installTeamPlaneView(mainWindow: () => BrowserWindow | null): void {
  let current: PlaneView | null = null;

  function close() {
    if (!current) return;
    const { owner, view } = current;
    current = null;
    if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }
  app.on("before-quit", close);

  function frameOf(owner: BrowserWindow, region: unknown): Rectangle | null {
    if (!region || typeof region !== "object") return null;
    const { x, y, width, height } = region as Rectangle;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0) return null;
    const zoom = owner.webContents.getZoomFactor();
    const { width: viewportWidth, height: viewportHeight } = owner.getContentBounds();
    const left = Math.ceil(x * zoom), top = Math.ceil(y * zoom);
    return { x: left, y: top, width: Math.max(0, Math.min(viewportWidth - left, Math.floor(width * zoom))), height: Math.max(0, Math.min(viewportHeight - top, Math.floor(height * zoom))) };
  }

  const validatedOwner = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const owner = mainWindow();
    return owner && !owner.isDestroyed() && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame ? owner : null;
  };

  function place(instance: PlaneView, bounds: Rectangle, visible: boolean, theme: unknown) {
    instance.visible = visible;
    const contents = instance.view.webContents;
    if ((theme === "dark" || theme === "light") && theme !== instance.theme) {
      instance.theme = theme;
      if (instance.ready && URL.parse(contents.getURL())?.origin === instance.target.url.origin)
        void applyTeamTheme(contents, theme);
    }
    instance.view.setBounds(bounds);
    instance.view.setVisible(instance.ready && instance.visible);
  }

  ipcMain.handle("amo:plane-show", async (event, id: unknown, targetInput: unknown, region: unknown, theme: unknown, visible: unknown) => {
    const owner = validatedOwner(event);
    const target = targetOf(targetInput);
    const bounds = owner && frameOf(owner, region);
    if (!owner || !target || !bounds || typeof id !== "string" || !uuid.test(id)) return false;
    // Keep one document alive while the renderer visits its local pages. A changed connection gets its own view.
    if (current?.id === id && current.owner === owner && !current.view.webContents.isDestroyed() &&
        current.target.url.href === target.url.href && current.target.identity === target.identity && current.target.name === target.name) {
      const instance = current;
      const page = target.originalUrl ?? (instance.target.originalUrl ? target.url : undefined);
      instance.target = target;
      place(instance, bounds, visible !== false, theme);
      const contents = instance.view.webContents;
      if (page && !await navigatePlanePage(contents, page) && current === instance && instance.target === target) {
        // The login screen or an older Plane build may not have its router ready.
        await contents.loadURL(page.href).catch(() => undefined);
      }
      return current === instance;
    }
    close();
    const account = createHash("sha256").update(JSON.stringify([target.url.origin, target.identity])).digest("hex").slice(0, 32);
    const profile = session.fromPartition(`persist:amo-plane-${account}`);
    profile.setPermissionRequestHandler((contents, permission, callback) => {
      callback(permission === "clipboard-sanitized-write" && URL.parse(contents.getURL())?.origin === target.url.origin);
    });
    profile.setPermissionCheckHandler((_contents, permission, origin) => permission === "clipboard-sanitized-write" && URL.parse(origin)?.origin === target.url.origin);
    const view = new WebContentsView({ webPreferences: { session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
    const instance: PlaneView = { target, owner, view, id, ready: false, visible: visible !== false, theme: theme === "dark" ? "dark" : "light" };
    current = instance;
    const contents = view.webContents;
    view.setVisible(false);
    view.setBounds(bounds);
    owner.contentView.addChildView(view);
    const dispose = () => { if (current === instance) close(); };
    owner.once("closed", dispose);
    owner.webContents.once("did-start-loading", dispose);
    contents.once("destroyed", () => {
      owner.removeListener("closed", dispose);
      owner.webContents.removeListener("did-start-loading", dispose);
    });
    const sameOrigin = (url: string) => URL.parse(url)?.origin === target.url.origin;
    const settingsUrl = new URL(`/.amo-studio/team-connection/${id}`, target.url).href;
    const personalTaskPrefix = new URL(`/.amo-studio/personal-task/${id}/`, target.url).href;
    const requestCopy = (item: { id: string } | { url: string }) => {
      if (current === instance && instance.visible && sameOrigin(contents.getURL())) owner.webContents.send("amo:plane-copy", id, item);
    };
    contents.on("will-navigate", (navigation) => {
      // The gear uses an intercepted URL without exposing IPC or loading a page on Plane.
      if (navigation.url === settingsUrl) {
        navigation.preventDefault();
        if (current === instance && instance.visible && sameOrigin(contents.getURL())) owner.webContents.send("amo:plane-settings", id);
      } else if (!sameOrigin(navigation.url)) navigation.preventDefault();
    });
    contents.on("will-redirect", (navigation) => { if (!sameOrigin(navigation.url)) navigation.preventDefault(); });
    contents.setWindowOpenHandler(({ url }) => {
      // The card command must leave the current document in place, even if an editor has an unsaved change.
      if (url.startsWith(personalTaskPrefix)) {
        const itemId = url.slice(personalTaskPrefix.length);
        if (uuid.test(itemId)) requestCopy({ id: itemId });
        return { action: "deny" };
      }
      if (sameOrigin(url) && URL.parse(url)?.pathname.includes("/browse/")) setImmediate(() => {
        if (!contents.isDestroyed()) void contents.loadURL(url).catch(() => undefined);
      });
      return { action: "deny" };
    });
    contents.on("before-input-event", (inputEvent, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
        inputEvent.preventDefault(); contents.reload();
      } else if (input.alt && input.key === "ArrowLeft" && contents.navigationHistory.canGoBack()) {
        inputEvent.preventDefault(); contents.navigationHistory.goBack();
      }
    });
    contents.on("did-finish-load", async () => {
      if (!sameOrigin(contents.getURL())) return;
      await Promise.allSettled([
        contents.executeJavaScriptInIsolatedWorld(controlsWorld, [{ code: projectControlsScript(target.url.pathname.replace(/\/$/, ""), target.name, settingsUrl, personalTaskPrefix, id) }]),
        contents.insertCSS(PROJECT_CHROME),
      ]);
      if (current !== instance) return;
      instance.ready = true;
      await applyTeamTheme(contents, instance.theme);
      if (current === instance) view.setVisible(instance.visible);
    });
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (current !== instance || !isMainFrame || code === -3) return;
      close();
      owner.webContents.send("amo:plane-error", id);
    });
    contents.on("render-process-gone", () => {
      if (current !== instance) return;
      close();
      owner.webContents.send("amo:plane-error", id);
    });
    contents.on("context-menu", async (_menuEvent, info) => {
      if (current !== instance || !instance.visible || !sameOrigin(contents.getURL())) return;
      const point = JSON.stringify([info.x, info.y]);
      const item = await contents.executeJavaScript(`(() => {
        const element = document.elementFromPoint(...${point});
        const card = element?.closest('[id^="issue-"],[data-entity-id]') ??
          (element?.closest('#full-screen-portal') && document.querySelector('[id^="issue-"].border-accent-strong'));
        return card?.getAttribute('data-entity-id') ?? card?.id.slice(6) ?? null;
      })()`).catch(() => null);
      if (current !== instance || !instance.visible) return;
      const original = originalOf(contents.getURL(), target.url.origin);
      const itemRef = original ? { url: original.href } : typeof item === "string" && uuid.test(item) ? { id: item } : null;
      const menu: Electron.MenuItemConstructorOptions[] = [];
      if (itemRef) menu.push({ label: "创建个人任务", click: () => requestCopy(itemRef) });
      if (info.isEditable) menu.push({ role: "cut" }, { role: "copy" }, { role: "paste" });
      else if (info.selectionText) menu.push({ role: "copy" });
      if (menu.length) Menu.buildFromTemplate(menu).popup({ window: owner });
    });
    try { await contents.loadURL((target.originalUrl ?? target.url).href); return current === instance; }
    catch {
      if (current === instance) {
        close(); owner.webContents.send("amo:plane-error", id);
      }
      return false;
    }
  });

  ipcMain.on("amo:plane-position", (event, id: unknown, region: unknown, visible: unknown, theme: unknown) => {
    const owner = validatedOwner(event);
    const instance = current;
    if (!owner || !instance || instance.id !== id || instance.owner !== owner) return;
    const bounds = frameOf(owner, region);
    if (!bounds) return;
    place(instance, bounds, visible === true, theme);
  });
  ipcMain.on("amo:plane-hide", (event, id: unknown) => {
    const instance = current;
    if (!validatedOwner(event) || !instance || instance.id !== id) return;
    instance.visible = false;
    instance.view.setVisible(false);
  });
  ipcMain.on("amo:plane-discard", (event, id: unknown) => {
    if (validatedOwner(event) && current?.id === id) close();
  });
}
