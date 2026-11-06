import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitEditorOpenResult, GitEditorState, ModelProfile, OpenInResult, TextFile, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { cliScript, decode } from "./service.js";
import { gitEditorArgs, startGitEditor } from "./git-editor.js";
import * as gitEditors from "./git-editor.js";

// Opening files outside Studio and reading them for a quick look (stage 12, S12-0). Test mode only records launches.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let http: HostServer;

beforeEach(async () => {
  vi.stubEnv("AMO_STUDIO_TEST", "1");
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-openin-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

function makeProject(): string {
  const dir = join(root, "game");
  mkdirSync(join(dir, "Assets"), { recursive: true });
  writeFileSync(join(dir, "Assets", "Player.cs"), "﻿public class Player {}\n");
  writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

describe("open in", () => {
  it("chooses an installed client in automatic mode and explains when none is found", async () => {
    const detect = vi.spyOn(gitEditors, "detectGitEditors");
    try {
      const editor = join(root, "Fork.exe");
      writeFileSync(editor, "");
      detect.mockResolvedValue([{ name: "Fork", path: editor }]);
      expect((await api<GitEditorState>("GET", "/api/git-editor")).data).toEqual({ configuredPath: null, detected: [{ name: "Fork", path: editor }], selected: { name: "Fork", path: editor } });
      detect.mockResolvedValue([]);
      const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
      const unavailable = await api<{ error: { message: string } }>("POST", `/api/workspaces/${ws.id}/git/open`);
      expect(unavailable.status).toBe(400);
      expect(unavailable.data.error.message).toContain("请先到设置");
      expect(service.openIn.launches).toEqual([]);
    } finally {
      detect.mockRestore();
    }
  });

  it("saves a custom Git client and opens the repository root for a project subfolder without launching it", async () => {
    const dir = makeProject();
    execFileSync("git", ["init", dir], { windowsHide: true, stdio: "ignore" });
    const editor = join(root, "custom editor.exe");
    writeFileSync(editor, "test executable placeholder");
    const saved = await api<GitEditorState>("PUT", "/api/git-editor", { path: editor });
    expect(saved.status).toBe(200);
    expect(saved.data.configuredPath).toBe(editor);
    expect(saved.data.selected).toEqual({ name: "custom editor", path: editor });
    expect((await api<GitEditorState>("GET", "/api/git-editor")).data.configuredPath).toBe(editor);
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: join(dir, "Assets") })).data;
    const opened = await api<GitEditorOpenResult>("POST", `/api/workspaces/${ws.id}/git/open`);
    expect(opened.status).toBe(200);
    expect(opened.data).toEqual({ path: dir, editor: "custom editor", dryRun: true });
    expect(service.openIn.launches.at(-1)).toEqual({ command: editor, args: [dir] });
    expect((await api<GitEditorState>("PUT", "/api/git-editor", { path: null })).data.configuredPath).toBeNull();
  });

  it("keeps a linked worktree as the repository target", async () => {
    const main = makeProject();
    execFileSync("git", ["init", main], { windowsHide: true, stdio: "ignore" });
    execFileSync("git", ["-C", main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"], { windowsHide: true, stdio: "ignore" });
    const worktree = join(root, "worktree with spaces");
    execFileSync("git", ["-C", main, "worktree", "add", "--detach", worktree], { windowsHide: true, stdio: "ignore" });
    const editor = join(root, "Fork.exe");
    writeFileSync(editor, "");
    await api("PUT", "/api/git-editor", { path: editor });
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: worktree })).data;
    const opened = await api<GitEditorOpenResult>("POST", `/api/workspaces/${ws.id}/git/open`);
    expect(opened.data.path).toBe(worktree);
    expect(service.openIn.launches.at(-1)).toEqual({ command: editor, args: [worktree] });
  });

  it("rejects commands, missing programs and non-repositories, retaining a valid saved choice", async () => {
    const editor = join(root, "Fork.exe");
    writeFileSync(editor, "");
    await api("PUT", "/api/git-editor", { path: editor });
    for (const path of ["Fork.exe", join(root, "absent.exe"), `${editor} --option`, root, 42]) expect((await api("PUT", "/api/git-editor", { path })).status).toBe(400);
    expect((await api("PUT", "/api/git-editor", {})).status).toBe(400);
    expect((await api<GitEditorState>("GET", "/api/git-editor")).data.configuredPath).toBe(editor);
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    expect((await api("POST", `/api/workspaces/${ws.id}/git/open`)).status).toBe(400);
    unlinkSync(editor);
    expect((await api("POST", `/api/workspaces/${ws.id}/git/open`)).status).toBe(400);
    expect(service.openIn.launches).toEqual([]);
  });

  it("passes client-specific repository arguments and reports OS launch failures", async () => {
    const repo = join(root, "repository with spaces & symbols");
    expect(gitEditorArgs(join(root, "Fork.exe"), repo)).toEqual([repo]);
    expect(gitEditorArgs(join(root, "SourceTree.exe"), repo)).toEqual([repo]);
    expect(gitEditorArgs(join(root, "GitHubDesktop.exe"), repo)).toEqual([`--cli-open=${repo}`]);
    expect(gitEditorArgs(join(root, "gitkraken.exe"), repo)).toEqual(["--path", repo]);
    await expect(startGitEditor(join(root, "missing.exe"), [repo], root)).rejects.toThrow("Git 编辑器启动失败");
  });

  it("opens project files in Explorer and the default program (recorded in test mode)", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const r = await api<OpenInResult>("POST", "/api/open-in", { path: "Assets/Player.cs", workspaceId: ws.id, app: "explorer" });
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ app: "explorer", path: join(ws.path, "Assets", "Player.cs"), dryRun: true });
    expect(service.openIn.launches.at(-1)).toEqual({ command: "explorer.exe", args: [`/select,"${join(ws.path, "Assets", "Player.cs")}"`] });

    await api("POST", "/api/open-in", { path: join(ws.path, "Assets"), app: "default" });
    expect(service.openIn.launches.at(-1)!.args).toEqual([`"${join(ws.path, "Assets")}"`]);
  });

  it("refuses missing files, unknown apps and relative paths without a project", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    expect((await api("POST", "/api/open-in", { path: "nope.cs", workspaceId: ws.id, app: "explorer" })).status).toBe(404);
    expect((await api("POST", "/api/open-in", { path: "Assets/Player.cs", workspaceId: ws.id, app: "notepad" })).status).toBe(400);
    expect((await api("POST", "/api/open-in", { path: "Assets/Player.cs", app: "explorer" })).status).toBe(400);
    expect(service.openIn.launches).toEqual([]);
  });

  it("tells whether VS Code is there", async () => {
    const r = await api<{ vscode: boolean }>("GET", "/api/open-in/apps");
    expect(r.status).toBe(200);
    expect(typeof r.data.vscode).toBe("boolean");
  });

  it("finds VS Code's CLI script through bin/code.cmd", () => {
    const install = join(root, "Microsoft VS Code");
    mkdirSync(join(install, "bin"), { recursive: true });
    mkdirSync(join(install, "abc123", "resources", "app", "out"), { recursive: true });
    writeFileSync(join(install, "abc123", "resources", "app", "out", "cli.js"), "");
    writeFileSync(join(install, "bin", "code.cmd"), '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\Code.exe" "%~dp0..\\abc123\\resources\\app\\out\\cli.js" %*\r\n');
    expect(cliScript(join(install, "Code.exe"))).toBe(join(install, "abc123", "resources", "app", "out", "cli.js"));
    expect(cliScript(join(root, "elsewhere", "Code.exe"))).toBeNull();
  });
});

describe("quick look", () => {
  it("reads text files and tells binary ones", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const text = await api<TextFile>("GET", `/api/fs/text?workspaceId=${ws.id}&path=${encodeURIComponent("Assets/Player.cs")}`);
    expect(text.status).toBe(200);
    expect(text.data.text).toBe("public class Player {}\n");
    const bin = await api<TextFile>("GET", `/api/fs/text?path=${encodeURIComponent(join(ws.path, "logo.png"))}`);
    expect(bin.data.binary).toBe(true);
    expect(bin.data.text).toBeUndefined();
    expect((await api("GET", `/api/fs/text?path=${encodeURIComponent(join(ws.path, "Assets"))}`)).status).toBe(400);
  });

  it("serves images with the token in the query, nothing else", async () => {
    const ws = (await api<Workspace>("POST", "/api/workspaces", { path: makeProject() })).data;
    const img = await fetch(`${http.url}/api/fs/raw?path=${encodeURIComponent(join(ws.path, "logo.png"))}&token=${TOKEN}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/png");
    const cs = await fetch(`${http.url}/api/fs/raw?path=${encodeURIComponent(join(ws.path, "Assets", "Player.cs"))}&token=${TOKEN}`);
    expect(cs.status).toBe(400);
  });

  it("serves a page's stylesheets, scripts, pictures and fonts under a key for its project, nothing outside or else (2026-11-06)", async () => {
    const dir = makeProject();
    mkdirSync(join(dir, "docs", "out"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "docs", "out", "page.html"), "<link rel=stylesheet href=style.css>");
    writeFileSync(join(dir, "docs", "out", "style.css"), "h1 { color: red }");
    writeFileSync(join(dir, "assets", "font.woff2"), "wOF2");
    writeFileSync(join(root, "secret.css"), "x");
    await api<Workspace>("POST", "/api/workspaces", { path: dir });

    const page = await api<{ key: string; dir: string }>("POST", "/api/fs/page", { path: join(dir, "docs", "out", "page.html") });
    expect(page.status).toBe(200);
    expect(page.data.key).toMatch(/^[0-9a-f]{32}$/);
    expect(page.data.dir).toBe("docs/out/");
    // The same project: the same key.
    expect((await api<{ key: string }>("POST", "/api/fs/page", { path: join(dir, "Assets", "Player.cs") })).data.key).toBe(page.data.key);
    const at = (rel: string) => fetch(`${http.url}/api/fs/page/${page.data.key}/${rel}`);
    // No token: the key is it.
    const css = await at("docs/out/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toBe("h1 { color: red }");
    const font = await at("assets/font.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("access-control-allow-origin")).toBe("*");
    expect((await at("logo.png")).status).toBe(200);
    // Not a page's kind of file, outside the project, a made-up key.
    expect((await at("Assets/Player.cs")).status).toBe(404);
    expect((await at("docs/out/page.html")).status).toBe(404);
    expect((await at("..%2Fsecret.css")).status).toBe(404);
    expect((await at("docs/..%2F..%2F..%2Fsecret.css")).status).toBe(404);
    expect((await fetch(`${http.url}/api/fs/page/${"0".repeat(32)}/docs/out/style.css`)).status).toBe(404);
    // A page in no project: its own folder.
    mkdirSync(join(root, "loose"), { recursive: true });
    writeFileSync(join(root, "loose", "p.html"), "x");
    writeFileSync(join(root, "loose", "p.css"), "p {}");
    const loose = await api<{ key: string; dir: string }>("POST", "/api/fs/page", { path: join(root, "loose", "p.html") });
    expect(loose.data.dir).toBe("");
    expect((await fetch(`${http.url}/api/fs/page/${loose.data.key}/p.css`)).status).toBe(200);
    expect((await fetch(`${http.url}/api/fs/page/${loose.data.key}/..%2Fsecret.css`)).status).toBe(404);
    // Asking for a key needs the token.
    expect((await fetch(`${http.url}/api/fs/page`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: join(root, "loose", "p.html") }) })).status).toBe(401);
  });

  it("decodes UTF-16 with a BOM", () => {
    expect(decode(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]))).toBe("AB");
    expect(decode(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe("A");
    expect(decode(Buffer.from([0x41, 0x00, 0x42]))).toBeNull();
  });
});
