import { execFile, spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize } from "node:path";
import type { GitEditor } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";

export const GIT_EDITOR_KEY = "settings:git-editor";

const CLIENTS = [
  { name: "Fork", exe: "Fork.exe", folders: ["Fork"] },
  { name: "Sourcetree", exe: "SourceTree.exe", folders: ["SourceTree", "Atlassian/SourceTree"] },
  { name: "GitHub Desktop", exe: "GitHubDesktop.exe", folders: ["GitHubDesktop"] },
  { name: "GitKraken", exe: "gitkraken.exe", folders: ["gitkraken"] },
] as const;

const file = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

export function gitEditorName(path: string): string {
  return CLIENTS.find((c) => c.exe.toLowerCase() === basename(path).toLowerCase())?.name ?? basename(path, extname(path));
}

/** The field is a program path, never a shell command or an argument template. */
export function checkedGitEditorPath(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new HostError("bad_request", "Git 编辑器要填写程序的完整路径");
  const path = normalize(value.trim().replace(/^"(.*)"$/, "$1"));
  if (!isAbsolute(path) || extname(path).toLowerCase() !== ".exe") throw new HostError("bad_request", "请选择 Git 编辑器的 .exe 程序，填写完整路径");
  if (!file(path)) throw new HostError("bad_request", `找不到 Git 编辑器程序：${path}`);
  return path;
}

/** Search only known install locations and PATH; do not scan disks or guess a preferred client. */
export async function detectGitEditors(): Promise<GitEditor[]> {
  if (process.platform !== "win32") return [];
  const out: GitEditor[] = [];
  for (const client of CLIENTS) {
    const candidates: string[] = [];
    for (const hive of ["HKCU", "HKLM"]) {
      const found = await registryPath(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${client.exe}`);
      if (found) candidates.push(found);
    }
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
      if (!root) continue;
      for (const folder of client.folders) {
        for (const install of [join(root, folder), join(root, "Programs", folder)]) {
          candidates.push(join(install, client.exe));
          candidates.push(join(install, "current", client.exe));
          // Squirrel installs keep the current executable under an app-<version> directory.
          try {
            const versions = readdirSync(install).filter((n) => /^app-\d/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const version of versions) candidates.push(join(install, version, client.exe));
          } catch { /* absent install */ }
        }
      }
    }
    for (const dir of (process.env.PATH ?? "").split(";")) if (dir) candidates.push(join(dir.replace(/^"|"$/g, ""), client.exe));
    const path = candidates.map((p) => normalize(p.replace(/^"|"$/g, ""))).find(file);
    if (path) out.push({ name: client.name, path });
  }
  return out;
}

function registryPath(key: string): Promise<string | null> {
  return new Promise((done) => {
    execFile("reg", ["query", key, "/ve"], { windowsHide: true, timeout: 1500, maxBuffer: 16 * 1024 }, (error, stdout) => {
      if (error) return done(null);
      const value = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(stdout)?.[1]?.trim();
      done(value ? value.replace(/%([^%]+)%/g, (_, key: string) => process.env[key] ?? `%${key}%`) : null);
    });
  });
}

/** Keep a linked worktree's own root; never follow --git-common-dir back to the main checkout. */
export function gitRepositoryRoot(cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (error, stdout) => {
      if (error) return fail(new HostError("bad_request", (error as NodeJS.ErrnoException).code === "ENOENT" ? "找不到 Git 或项目文件夹，请检查安装和项目路径" : "这个项目不是可打开的 Git 仓库"));
      const path = stdout.trim();
      if (!path || !isAbsolute(path)) return fail(new HostError("bad_request", "没有读到 Git 仓库的完整路径"));
      done(normalize(path));
    });
  });
}

export function gitEditorArgs(exe: string, repository: string): string[] {
  const name = basename(exe).toLowerCase();
  // GitHub Desktop's own CLI forwards --cli-open to the executable (desktop/desktop app/src/cli/main.ts).
  if (name === "githubdesktop.exe") return [`--cli-open=${repository}`];
  if (name === "gitkraken.exe") return ["--path", repository];
  return [repository];
}

/** Resolve only after the OS accepted the start, so a removed/broken executable reports an error in Studio. */
export function startGitEditor(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, args, { cwd, detached: true, stdio: "ignore", windowsHide: false, env });
    child.once("error", () => fail(new HostError("bad_request", "Git 编辑器启动失败，请在设置中检查程序路径")));
    child.once("spawn", () => { child.unref(); done(); });
  });
}
