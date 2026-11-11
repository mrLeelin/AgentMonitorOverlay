import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { claudeOnPath, claudeCodeCandidates, codexOnPath, firstOnPath } from "@amo-studio/locate";
import type { MaintenanceCliList, MaintenanceCliStatus, MaintenanceUpdateCli } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { findClaudeCode } from "../../runtime/claude/executable.js";
import { CliCleanupError, runCliCommand, type CliCommand } from "./command-runner.js";
import { PI_PACKAGES, resolvePiCommand } from "../../runtime/pi/launch.js";

const CLIS = ["claude", "codex", "pi"] as const;
const NAMES = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
const VERSION = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?\b/;

type Command = CliCommand;
export interface CliInstallation {
  path: string;
  version: Command;
  update: Command | null;
  updateCommand: string | null;
  reason: string | null;
  /** The detected npm distribution; Pi must never switch scopes while updating. */
  packageName?: string | null;
}
export interface CliUpdateIo {
  locate(cli: MaintenanceUpdateCli): CliInstallation | null;
  run(command: Command, timeout: number): Promise<string>;
  latest(cli: MaintenanceUpdateCli, install: CliInstallation): Promise<string>;
}

/** Paths are discovered locally. The HTTP request chooses only a whitelisted CLI, never a path or command. */
export class CliUpdates {
  private items = new Map<MaintenanceUpdateCli, MaintenanceCliStatus>();
  private checked = false;
  private checking: Promise<MaintenanceCliList> | null = null;
  private updating = new Set<MaintenanceUpdateCli>();
  private cleanupBlocked = false;

  constructor(private readonly io: CliUpdateIo = defaultIo) {
    for (const cli of CLIS) this.items.set(cli, { cli, name: NAMES[cli], path: null, currentVersion: null, latestVersion: null, updateAvailable: false, canUpdate: false, updateCommand: null, state: "idle", message: null });
  }

  async list(): Promise<MaintenanceCliList> {
    return this.checked ? this.snapshot() : this.check();
  }

  check(): Promise<MaintenanceCliList> {
    if (this.checking) return this.checking;
    if (this.updating.size || this.cleanupBlocked) return Promise.resolve(this.snapshot());
    this.checking = this.performCheck().finally(() => { this.checking = null; });
    return this.checking;
  }

  async update(cli: MaintenanceUpdateCli): Promise<MaintenanceCliStatus> {
    await this.list();
    if (this.checking) await this.checking;
    const item = this.items.get(cli)!;
    if (this.cleanupBlocked) throw new HostError("bad_request", "上次安装进程未能确认结束，请关闭残留的安装进程后重新启动 Studio。");
    if (this.updating.has(cli)) return { ...item };
    if (this.updating.size) throw new HostError("bad_request", "另一个 CLI 正在更新，请等待更新结束后再试。");
    if (!item.canUpdate || !item.updateAvailable) throw new HostError("bad_request", item.message ?? "这个 CLI 当前没有可安装的新版本");
    const install = this.io.locate(cli);
    if (!install?.update || install.path !== item.path || install.updateCommand !== item.updateCommand) throw new HostError("bad_request", "CLI 安装位置已改变，请重新检查版本后再更新");
    this.updating.add(cli);
    Object.assign(item, { state: "updating", message: "正在下载并安装更新…" });
    void this.performUpdate(cli, install).finally(() => this.updating.delete(cli));
    return { ...item };
  }

  private snapshot(): MaintenanceCliList {
    return { items: CLIS.map((cli) => ({ ...this.items.get(cli)! })) };
  }

  private async performCheck(): Promise<MaintenanceCliList> {
    await Promise.all(CLIS.map(async (cli) => {
      const item = this.items.get(cli)!;
      Object.assign(item, { state: "checking", message: null, currentVersion: null, latestVersion: null, updateAvailable: false, canUpdate: false, updateCommand: null });
      try {
        const install = this.io.locate(cli);
        item.path = install?.path ?? null;
        if (!install) { Object.assign(item, { state: "idle", message: `没有找到 ${NAMES[cli]}，请先在本机安装。` }); return; }
        item.updateCommand = install.updateCommand;
        item.canUpdate = !!install.update;
        item.currentVersion = parseVersion(await this.io.run(install.version, 15_000));
        if (!item.currentVersion) throw new Error("无法读取当前版本，请检查 CLI 能否正常运行。");
        if (cli === "pi" && !install.packageName) { item.state = "idle"; item.message = install.reason; return; }
        item.latestVersion = parseVersion(await this.io.latest(cli, install));
        if (!item.latestVersion) throw new Error("版本服务返回的数据无效，请稍后重新检查。");
        item.updateAvailable = compareCliVersions(item.currentVersion, item.latestVersion) < 0;
        item.state = "idle";
        item.message = install.reason;
      } catch (err) {
        item.state = "error";
        item.message = err instanceof Error ? err.message : "检查失败，请重试。";
      }
    }));
    this.checked = true;
    return this.snapshot();
  }

  private async performUpdate(cli: MaintenanceUpdateCli, install: CliInstallation): Promise<void> {
    const item = this.items.get(cli)!;
    try {
      await this.io.run(install.update!, 300_000);
      // An installer exit code alone does not prove the selected CLI was updated.
      const current = this.io.locate(cli);
      if (!current || current.path !== install.path || current.packageName !== install.packageName) throw new Error("更新后安装位置或安装包发生变化，请重新检查版本。");
      const version = parseVersion(await this.io.run(current.version, 15_000));
      if (!version) throw new Error("更新命令已结束，但无法读取更新后的版本，请重新检查。");
      item.currentVersion = version;
      item.updateAvailable = !!item.latestVersion && compareCliVersions(version, item.latestVersion) < 0;
      if (item.updateAvailable) throw new Error(`更新命令已结束，当前仍为 ${version}，尚未达到检测到的新版本。请稍后重试。`);
      item.state = "updated";
      item.message = `已更新到 ${version}，重新打开 CLI 后使用新版本。`;
    } catch (err) {
      item.state = "error";
      item.message = err instanceof Error ? err.message : "更新失败，请重试。";
      if (err instanceof CliCleanupError) {
        this.cleanupBlocked = true;
        for (const status of this.items.values()) status.canUpdate = false;
      }
    }
  }
}

export function parseVersion(text: string): string | null {
  return VERSION.exec(text)?.[1] ?? null;
}

/** Semver ordering, including prereleases; never offer a stable downgrade to a newer preview build. */
export function compareCliVersions(a: string, b: string): number {
  const split = (value: string): [string, string | null] => {
    const at = value.indexOf("-");
    return at < 0 ? [value, null] : [value.slice(0, at), value.slice(at + 1)];
  };
  const [baseA, preA] = split(a);
  const [baseB, preB] = split(b);
  const x = baseA!.split(".").map(Number), y = baseB!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  if (preA === preB) return 0;
  if (!preA || !preB) return preA ? -1 : 1;
  const px = preA.split("."), py = preB.split(".");
  for (let i = 0; i < Math.max(px.length, py.length); i++) {
    const l = px[i], r = py[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) - Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

function nodeCommand(script: string, args: string[] = []): Command {
  return { file: process.execPath, args: [script, ...args], node: true };
}

function packageEntry(root: string, packageName: string, binName?: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; bin?: string | Record<string, string> };
    if (pkg.name !== packageName) return null;
    const bin = typeof pkg.bin === "string" ? pkg.bin : (binName ? pkg.bin?.[binName] : Object.values(pkg.bin ?? {})[0]);
    if (!bin) return null;
    const entry = resolve(root, bin), rel = relative(root, entry);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) && existsSync(entry) ? entry : null;
  } catch { return null; }
}

function npmInstallation(path: string, packageName: string, binName?: string): CliInstallation | null {
  const normalized = path.replace(/\\/g, "/");
  const marker = `/node_modules/${packageName}/`;
  const at = normalized.toLowerCase().indexOf(marker.toLowerCase());
  const prefix = at >= 0 ? resolve(normalized.slice(0, at)) : /\.cmd$/i.test(path) ? dirname(path) : null;
  if (!prefix) return null;
  const entry = packageEntry(join(prefix, "node_modules", packageName), packageName, binName);
  if (!entry) return null;
  const npm = firstOnPath(["npm.cmd", "npm"]);
  const script = npm ? join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js") : null;
  const update = script && existsSync(script) ? nodeCommand(script, ["install", "--global", "--prefix", prefix, `${packageName}@latest`]) : null;
  return {
    path,
    version: /\.exe$/i.test(entry) ? { file: entry, args: ["--version"] } : nodeCommand(entry, ["--version"]),
    update,
    updateCommand: update ? `npm install --global --prefix ${JSON.stringify(prefix)} ${packageName}@latest` : null,
    reason: update ? null : "没有找到 npm 的运行入口，请先修复本机 Node.js / npm 安装后重新检查。",
    packageName,
  };
}

export function locateCliInstallation(cli: MaintenanceUpdateCli): CliInstallation | null {
  if (cli === "pi") {
    const command = resolvePiCommand();
    if (!command) return null;
    const entry = command.args[0] ?? command.command;
    const version = { file: command.command, args: [...command.args, "--version"], node: command.args.length > 0 };
    // Use the runtime's exact selection, including its scope preference when both distributions exist.
    for (const packageName of PI_PACKAGES) {
      const install = npmInstallation(entry, packageName, "pi");
      if (!install) continue;
      const normalized = entry.replace(/\\/g, "/");
      const at = normalized.toLowerCase().indexOf(`/node_modules/${packageName}/`.toLowerCase());
      if (at < 0) continue;
      const selectedEntry = packageEntry(join(resolve(normalized.slice(0, at)), "node_modules", packageName), packageName, "pi");
      if (!selectedEntry || resolve(selectedEntry).toLowerCase() !== resolve(entry).toLowerCase()) continue;
      return { ...install, version };
    }
    return { path: entry, version, update: null, updateCommand: null, packageName: null, reason: "未识别到 Pi 的 npm 安装包，无法确定对应的新版本；请使用原安装方式更新。" };
  }
  const own = cli === "claude" ? claudeOnPath() ?? claudeCodeCandidates()[0] ?? null : codexOnPath();
  if (own) {
    if (cli === "claude" && /[/\\]node_modules[/\\]@anthropic-ai[/\\]claude-agent-sdk/i.test(own)) return { path: own, version: { file: own, args: ["--version"] }, update: null, updateCommand: null, reason: "这是 Studio SDK 自带的 Claude Code，请通过 Studio 的更新更新它。" };
    const npm = npmInstallation(own, PACKAGES[cli]);
    if (npm) return npm;
    const native = /\.exe$/i.test(own);
    const update = cli === "claude" && native ? { file: own, args: ["update"] } : null;
    return { path: own, version: { file: own, args: ["--version"] }, update, updateCommand: update ? `"${own}" update` : null, reason: update ? null : "未识别到可自动更新的安装方式，请使用原安装方式更新。" };
  }
  if (cli === "claude") {
    const bundled = findClaudeCode();
    if (bundled) return { path: bundled.path, version: { file: bundled.path, args: ["--version"] }, update: null, updateCommand: null, reason: "这是 Studio 自带或指定的 Claude Code，请通过原安装方式更新；安装个人版后可在这里更新。" };
  }
  return null;
}

const defaultIo: CliUpdateIo = {
  locate: locateCliInstallation,
  run: runCliCommand,
  latest: latestCliVersion,
};

export async function latestCliVersion(cli: MaintenanceUpdateCli, install: CliInstallation): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const packageName = install.packageName ?? (cli === "pi" ? null : PACKAGES[cli]);
    if (!packageName) throw new Error("unknown distribution");
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: controller.signal });
    if (!response.ok) throw new Error("registry unavailable");
    const data = await response.json() as { version?: unknown };
    if (typeof data.version !== "string") throw new Error("invalid registry response");
    return data.version;
  } catch { throw new Error("无法连接版本服务，请检查网络后重新检查。"); }
  finally { clearTimeout(timer); }
}
