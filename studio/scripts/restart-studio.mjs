// The root restart-amo.bat restarts only this checkout and its .data, even when another Studio is installed.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { constants, getPriority, setPriority } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const studioRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(studioRoot, ".data");
const electron = join(studioRoot, "node_modules", "electron", "dist", "electron.exe");
const lockFile = join(dataDir, "restart.lock");
const note = (message) => console.log(`[AMO Studio] ${message}`);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function health(info) {
  const url = new URL(info.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("后台地址应为本机地址，请检查 .data/host.json。");
  const response = await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`后台健康检查失败（HTTP ${response.status}）。`);
  const result = await response.json();
  if (result.ok !== true || result.pid !== info.pid || !Number.isSafeInteger(result.running) || result.running < 0) throw new Error("后台进程信息不匹配，请检查 .data/host.json。");
  return result;
}

async function availablePort(preferred) {
  const ports = [...new Set([preferred, ...Array.from({ length: 100 }, (_, index) => 47900 + index)])];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 47900 || port > 47999) continue;
    const free = await new Promise((resolvePort) => {
      const server = createServer();
      server.once("error", () => resolvePort(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
    });
    if (free) return port;
  }
  throw new Error("47900–47999 端口均不可用，请关闭占用端口的程序后重试。");
}

async function restart() {
  if (!existsSync(electron)) throw new Error("缺少 Electron，请先运行 studio/start-studio.cmd 安装依赖。");
  const host = readJson(join(dataDir, "host.json"));
  const shell = readJson(join(dataDir, "shell.json"));
  const hostRunning = alive(host?.pid);
  if (hostRunning && (await health(host)).running > 0) throw new Error("有会话正在运行，请等会话结束后再双击重启。");
  if (shell && alive(shell.pid) && resolve(shell.exe).toLowerCase() !== electron.toLowerCase()) throw new Error("当前数据目录由其他版本的 Studio 使用，请先关闭那个版本。");
  if (!hostRunning && alive(shell?.pid)) throw new Error("Studio 窗口仍在运行，但后台未响应。请先在托盘中完全退出 Studio 后重试。");

  note("正在构建当前文件夹中的最新源码……");
  const priority = getPriority();
  let exitCode;
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
    exitCode = await new Promise((resolveBuild, reject) => {
      const build = spawn("cmd.exe", ["/d", "/s", "/c", "npm.cmd run build"], { cwd: studioRoot, stdio: "inherit", windowsHide: true });
      build.once("error", reject);
      build.once("exit", resolveBuild);
    });
  } finally {
    setPriority(0, priority);
  }
  if (exitCode !== 0) throw new Error("构建失败，请检查上面的报错并重试。");

  if (hostRunning) {
    note("正在关闭当前源码版……");
    const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
    // The server rechecks active sessions here, including sessions started during the build.
    const response = await fetch(new URL("/api/shutdown", host.url), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (response.status === 409) throw new Error("构建期间有会话开始运行，请等会话结束后再重启。");
    if (!response.ok) throw new Error(`关闭后台失败（HTTP ${response.status}）。`);
    const deadline = Date.now() + 20000;
    while (alive(host.pid) || alive(shell?.pid)) {
      if (Date.now() > deadline) throw new Error("Studio 尚未完全退出，请稍后重试。");
      await delay(250);
    }
  }

  const backupDir = join(dataDir, `backup-before-restart-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  for (const name of ["studio.db", "studio.db-wal", "studio.db-shm", "studio.db-journal"]) {
    if (!existsSync(join(dataDir, name))) continue;
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(join(dataDir, name), join(backupDir, name));
  }

  const port = await availablePort(host?.port);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$|ELECTRON_RUN_AS_NODE$)/i.test(key)) delete env[key];
  }
  env.AMO_STUDIO_DATA_DIR = dataDir;
  env.AMO_STUDIO_PORT = String(port);
  note(`正在启动源码版，端口 ${port}……`);
  const child = spawn(electron, ["packages/app"], { cwd: studioRoot, env, detached: true, stdio: "ignore" });
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  child.unref();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const startedShell = readJson(join(dataDir, "shell.json"));
    const startedHost = readJson(join(dataDir, "host.json"));
    if (startedShell?.pid === child.pid && startedHost && (await health(startedHost)).ok) {
      note(`重启完成。源码目录 ${studioRoot}`);
      return;
    }
    if (!alive(child.pid)) throw new Error("Studio 启动失败，请检查 .data/host.log。");
    await delay(300);
  }
  throw new Error("启动验证超时，请检查 Studio 窗口和 .data/host.log。");
}

let locked = false;
try {
  if (process.platform !== "win32") throw new Error("此重启脚本用于 Windows。");
  mkdirSync(dataDir, { recursive: true });
  // A second double-click must not stop a Studio that the first invocation has just launched.
  const previousLock = readJson(lockFile);
  if (previousLock && !alive(previousLock.pid)) unlinkSync(lockFile);
  try {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    locked = true;
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("已有一个重启脚本在运行，请等待它完成。");
    throw error;
  }
  await restart();
} catch (error) {
  console.error(`[AMO Studio] ${error.message}`);
  process.exitCode = 1;
} finally {
  if (locked) unlinkSync(lockFile);
}
