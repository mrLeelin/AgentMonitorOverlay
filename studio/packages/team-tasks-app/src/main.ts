import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readAccount, readJsonFile, writeJsonFile } from "@amo-studio/account";
import { RelayClient, RelayClientError } from "@amo-studio/relay/light";
import type { TeamTasksDesktop } from "@amo-studio/protocol";

const here = fileURLToPath(new URL(".", import.meta.url));
const page = join(here, "../../ui/dist/team-tasks.html");
const pageUrl = pathToFileURL(page).href;
app.setName("AMO Team Tasks");
app.setPath("userData", process.env.AMO_TEAM_TASKS_HOME ?? join(app.getPath("appData"), "AMO Team Tasks"));
let window: BrowserWindow | null = null;
const running = join(app.getPath("userData"), "running.json");

async function using<T>(work: (client: RelayClient) => Promise<T>): Promise<T> {
  const account = await readAccount();
  if (!account) throw new Error("请先在 AMO 平台里登录");
  try {
    return await work(new RelayClient(account.server, account.key));
  } catch (error) {
    if (error instanceof RelayClientError && error.status === 401) throw new Error("团队登录已过期，请在 AMO 平台重新登录");
    if (error instanceof RelayClientError) throw new Error(error.message);
    throw new Error("团队服务器连接超时或断开，请刷新后重试");
  }
}

const handlers: TeamTasksDesktop = {
  identity: async () => (await readAccount()) ? using((client) => client.teamTaskIdentity()) : null,
  list: () => using((client) => client.teamTaskList()),
  detail: (id) => using((client) => client.teamTaskDetail(id)),
  create: (input) => using((client) => client.teamTaskCreate(input)),
  change: (id, input) => using((client) => client.teamTaskChange(id, input)),
  saveAttachment: async (id, file) => {
    if (!window) return false;
    const result = await dialog.showSaveDialog(window, { title: "保存团队任务附件", defaultPath: basename(file.name) });
    if (result.canceled || !result.filePath) return false;
    const bytes = await using((client) => client.teamTaskDownload(id, file.id));
    await writeFile(result.filePath, Buffer.from(bytes));
    return true;
  },
};

function bind<K extends keyof TeamTasksDesktop>(name: K): void {
  ipcMain.handle(`team-tasks:${name}`, (event, ...args: Parameters<TeamTasksDesktop[K]>) => {
    if (event.sender !== window?.webContents || event.senderFrame?.url !== pageUrl) throw new Error("这扇窗口不能访问团队任务");
    const handler = handlers[name] as (...args: Parameters<TeamTasksDesktop[K]>) => ReturnType<TeamTasksDesktop[K]>;
    return handler(...args);
  });
}

for (const name of ["identity", "list", "detail", "create", "change", "saveAttachment"] as const) bind(name);
if (!app.requestSingleInstanceLock() || process.argv.includes("--amo-quit")) app.quit();
else {
  app.on("second-instance", (_event, args) => {
    if (args.includes("--amo-quit")) { app.quit(); return; }
    window?.restore();
    window?.show();
    window?.focus();
  });
  app.on("will-quit", () => {
    if (readJsonFile<{ pid: number }>(running)?.pid === process.pid) {
      try { rmSync(running, { force: true }); } catch { /* The platform also checks whether the pid is live. */ }
    }
  });
  void app.whenReady().then(() => {
    try { writeJsonFile(running, { pid: process.pid, exe: process.execPath, version: app.getVersion() }); } catch { /* The platform can detect the process without the record. */ }
    const hidden = process.argv.includes("--hidden");
    window = new BrowserWindow({ title: "AMO 团队任务", width: 1090, height: 820, minWidth: 640, minHeight: 500, show: !hidden, ...(hidden ? { x: -20_000, y: -20_000, focusable: false } : {}), backgroundColor: "#fafbf6", webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => { window = null; });
    void window.loadFile(page).catch((error: unknown) => { console.error(error); app.exit(1); });
  });
  app.on("window-all-closed", () => app.quit());
}
