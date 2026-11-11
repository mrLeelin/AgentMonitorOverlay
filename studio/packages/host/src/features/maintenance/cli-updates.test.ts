import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import type { MaintenanceUpdateCli } from "@amo-studio/protocol";
import { CliUpdates, compareCliVersions, latestCliVersion, locateCliInstallation, parseVersion, type CliInstallation, type CliUpdateIo } from "./cli-updates.js";
import { CliCleanupError } from "./command-runner.js";

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); if (root) removeTempDir(root); root = undefined; });

function fixture(selected: MaintenanceUpdateCli = "codex") {
  let version = "0.100.0";
  const install: CliInstallation = { path: `C:/npm/${selected}.cmd`, version: { file: "node", args: [`${selected}.js`, "--version"] }, update: { file: "node", args: ["npm-cli.js", "install"] }, updateCommand: "npm install --global @openai/codex@latest", reason: null, ...(selected === "pi" ? { packageName: "@earendil-works/pi-coding-agent" } : {}) };
  const run = vi.fn(async (command: CliInstallation["version"]) => command === install.version ? `codex-cli ${version}` : "installed");
  const io: CliUpdateIo = { locate: vi.fn((cli) => cli === selected ? install : null), run, latest: vi.fn(async () => "0.101.0") };
  return { updates: new CliUpdates(io), install, io, run, setVersion: (next: string) => { version = next; } };
}

describe("CLI versions", () => {
  it("keeps prerelease identifiers and compares semver without offering a preview downgrade", () => {
    expect(parseVersion("codex-cli 0.102.0-alpha.12+build.1")).toBe("0.102.0-alpha.12");
    expect(compareCliVersions("0.102.0-alpha.12", "0.102.0-alpha.2")).toBeGreaterThan(0);
    expect(compareCliVersions("0.102.0-alpha.12", "0.101.0")).toBeGreaterThan(0);
    expect(compareCliVersions("0.101.0-alpha.1", "0.101.0")).toBeLessThan(0);
    expect(compareCliVersions("0.101.0", "0.101.0")).toBe(0);
    expect(compareCliVersions("0.101.0-beta-x", "0.101.0-beta-y")).toBeLessThan(0);
  });

  it("caches checks and reports a missing CLI without querying the registry for it", async () => {
    const { updates, io } = fixture();
    const list = await updates.list();
    expect(list.items[0]).toMatchObject({ cli: "claude", path: null, canUpdate: false, state: "idle" });
    expect(list.items[1]).toMatchObject({ currentVersion: "0.100.0", latestVersion: "0.101.0", updateAvailable: true, canUpdate: true });
    expect(io.latest).toHaveBeenCalledTimes(1);
    await updates.list();
    expect(io.latest).toHaveBeenCalledTimes(1);
    await updates.check();
    expect(io.latest).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping checks", async () => {
    const { updates, io } = fixture();
    await Promise.all([updates.list(), updates.list(), updates.check()]);
    expect(io.latest).toHaveBeenCalledTimes(1);
  });

  it("exposes registry failures and retains the detected version", async () => {
    const { updates, io } = fixture();
    vi.mocked(io.latest).mockRejectedValue(new Error("网络不可用"));
    const list = await updates.list();
    expect(list.items[1]).toMatchObject({ currentVersion: "0.100.0", latestVersion: null, canUpdate: true, updateAvailable: false, state: "error", message: "网络不可用" });
    await expect(updates.update("codex")).rejects.toThrow("网络不可用");
  });

  it("does not update SDK-provided or unrecognized installs", async () => {
    const { updates, install, run } = fixture();
    install.update = null;
    install.reason = "请使用原安装方式更新";
    expect((await updates.list()).items[1]).toMatchObject({ canUpdate: false, updateAvailable: true });
    await expect(updates.update("codex")).rejects.toThrow("请使用原安装方式更新");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("returns updating immediately, deduplicates clicks and checks actual installed version", async () => {
    const { updates, run, install, setVersion } = fixture();
    let finish: (() => void) | undefined;
    run.mockImplementation(async (command) => {
      if (command === install.update) await new Promise<void>((resolve) => { finish = resolve; });
      return command === install.version ? "0.101.0" : "done";
    });
    // Detect an old version first.
    run.mockResolvedValueOnce("0.100.0");
    await updates.list();
    expect(await updates.update("codex")).toMatchObject({ state: "updating" });
    expect(await updates.update("codex")).toMatchObject({ state: "updating" });
    expect((await updates.check()).items[1]!.state).toBe("updating");
    setVersion("0.101.0");
    finish!();
    await vi.waitFor(async () => expect((await updates.list()).items[1]).toMatchObject({ state: "updated", currentVersion: "0.101.0", updateAvailable: false }));
    expect(run.mock.calls.filter(([command]) => command === install.update)).toHaveLength(1);
  });

  it("keeps a failed update retryable and never treats an unchanged version as success", async () => {
    const { updates } = fixture();
    await updates.list();
    await updates.update("codex");
    await vi.waitFor(async () => expect((await updates.list()).items[1]).toMatchObject({ state: "error", currentVersion: "0.100.0", latestVersion: "0.101.0", updateAvailable: true, canUpdate: true }));
    expect(await updates.update("codex")).toMatchObject({ state: "updating" });
  });

  it("refuses to update when the installation changed after checking", async () => {
    const { updates, io, install } = fixture();
    await updates.list();
    vi.mocked(io.locate).mockReturnValue({ ...install, path: "D:/other/codex.cmd" });
    await expect(updates.update("codex")).rejects.toThrow("安装位置已改变");
  });

  it("blocks all further installs and checks if timed-out installer cleanup could not be confirmed", async () => {
    const { updates, run } = fixture();
    await updates.list();
    run.mockRejectedValueOnce(new CliCleanupError("cleanup unconfirmed"));
    await updates.update("codex");
    await vi.waitFor(async () => expect((await updates.list()).items[1]).toMatchObject({ state: "error", canUpdate: false }));
    await updates.check();
    await expect(updates.update("codex")).rejects.toThrow("安装进程未能确认结束");
  });
});

describe("local npm install detection", () => {
  it("uses the selected native Claude updater and leaves unrecognized standalone Codex installs alone", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-updates-"));
    writeFileSync(join(root, "claude.exe"), "fake executable");
    writeFileSync(join(root, "codex.exe"), "fake executable");
    vi.stubEnv("PATH", root);
    expect(locateCliInstallation("claude")).toMatchObject({ path: join(root, "claude.exe"), update: { file: join(root, "claude.exe"), args: ["update"] } });
    expect(locateCliInstallation("codex")).toMatchObject({ path: join(root, "codex.exe"), update: null, updateCommand: null });
  });

  it("does not turn a mismatched npm package into an update target", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-updates-"));
    const packageRoot = join(root, "node_modules", "@openai", "codex");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(root, "codex.cmd"), "fake shim");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "unrelated-package", bin: "codex.js" }));
    writeFileSync(join(packageRoot, "codex.js"), "fake CLI");
    vi.stubEnv("PATH", root);
    expect(locateCliInstallation("codex")).toMatchObject({ update: null });
  });

  it("uses the selected shim prefix and starts npm through its JS entry instead of a shell", () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-updates-"));
    const prefix = join(root, "personal npm");
    const nodeDir = join(root, "node");
    const packageRoot = join(prefix, "node_modules", "@openai", "codex");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(prefix, "codex.cmd"), "fake shim");
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", bin: { codex: "codex.js" } }));
    writeFileSync(join(packageRoot, "codex.js"), "fake CLI");
    writeFileSync(join(nodeDir, "npm.cmd"), "fake npm shim");
    writeFileSync(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), "fake npm");
    vi.stubEnv("PATH", `${prefix};${nodeDir}`);
    const found = locateCliInstallation("codex");
    expect(found?.path).toBe(join(prefix, "codex.cmd"));
    expect(found?.version).toMatchObject({ file: process.execPath, args: [join(packageRoot, "codex.js"), "--version"], node: true });
    expect(found?.update).toMatchObject({ file: process.execPath, args: [join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), "install", "--global", "--prefix", prefix, "@openai/codex@latest"], node: true });
  });
});

describe("Pi CLI updates", () => {
  function piInstall(names: string[]) {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-updates-pi-"));
    const prefix = join(root, "pi global"), nodeDir = join(root, "node");
    mkdirSync(prefix, { recursive: true });
    mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(join(prefix, "pi.cmd"), "fake shim");
    for (const name of names) {
      const pkg = join(prefix, "node_modules", name);
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, bin: { pi: "dist/cli.js" } }));
      writeFileSync(join(pkg, "dist", "cli.js"), "fake Pi");
    }
    writeFileSync(join(nodeDir, "npm.cmd"), "fake shim");
    const npmEntry = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    writeFileSync(npmEntry, "fake npm");
    vi.stubEnv("PATH", `${prefix};${nodeDir}`);
    vi.stubEnv("AMO_STUDIO_NODE", process.execPath);
    return { prefix, npmEntry };
  }

  it.each(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"])("checks and updates the actual %s package at its existing prefix", async (name) => {
    const { prefix, npmEntry } = piInstall([name]);
    const found = locateCliInstallation("pi")!;
    const entry = join(prefix, "node_modules", name, "dist", "cli.js");
    expect(found).toMatchObject({ path: entry, packageName: name, version: { file: process.execPath, args: [entry, "--version"] }, update: { file: process.execPath, args: [npmEntry, "install", "--global", "--prefix", prefix, `${name}@latest`] } });
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ version: "0.102.0" }) }));
    vi.stubGlobal("fetch", fetch);
    expect(await latestCliVersion("pi", found)).toBe("0.102.0");
    expect(fetch).toHaveBeenCalledWith(`https://registry.npmjs.org/${name}/latest`, expect.any(Object));
  });

  it("uses the runtime's same scope preference when both renamed packages are installed", () => {
    piInstall(["@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent"]);
    expect(locateCliInstallation("pi")).toMatchObject({ packageName: "@earendil-works/pi-coding-agent", updateCommand: expect.stringContaining("@earendil-works/pi-coding-agent@latest") });
  });

  it("disables native Pi updates without guessing a distribution or querying its registry", async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-cli-updates-pi-"));
    writeFileSync(join(root, "pi.exe"), "fake binary");
    vi.stubEnv("PATH", root);
    const found = locateCliInstallation("pi")!;
    expect(found).toMatchObject({ path: join(root, "pi.exe"), update: null, packageName: null });
    const latest = vi.fn(async () => "0.102.0");
    const updates = new CliUpdates({ locate: (cli) => cli === "pi" ? found : null, run: async () => "0.101.0", latest });
    expect((await updates.list()).items[2]).toMatchObject({ cli: "pi", currentVersion: "0.101.0", latestVersion: null, canUpdate: false, message: expect.stringContaining("请使用原安装方式更新") });
    expect(latest).not.toHaveBeenCalled();
  });

  it("checks Pi versions, performs its update, and verifies the resulting version", async () => {
    const { updates, io, install, setVersion } = fixture("pi");
    const item = (await updates.list()).items[2];
    expect(item).toMatchObject({ cli: "pi", name: "Pi", currentVersion: "0.100.0", latestVersion: "0.101.0", canUpdate: true, updateAvailable: true });
    expect(io.latest).toHaveBeenCalledWith("pi", install);
    setVersion("0.101.0");
    expect(await updates.update("pi")).toMatchObject({ state: "updating" });
    await vi.waitFor(async () => expect((await updates.list()).items[2]).toMatchObject({ state: "updated", currentVersion: "0.101.0", updateAvailable: false }));
  });

  it("retains Pi update failures for retry and rejects a changed Pi path", async () => {
    const { updates, io, install, run } = fixture("pi");
    await updates.list();
    run.mockRejectedValueOnce(new Error("Pi install failed"));
    await updates.update("pi");
    await vi.waitFor(async () => expect((await updates.list()).items[2]).toMatchObject({ state: "error", canUpdate: true, updateAvailable: true, message: "Pi install failed" }));
    vi.mocked(io.locate).mockReturnValue({ ...install, path: "D:/new-pi/cli.js" });
    await expect(updates.update("pi")).rejects.toThrow("安装位置已改变");
  });

  it("does not report Pi success when its selected installation moves during the update", async () => {
    const { updates, io, install, run } = fixture("pi");
    await updates.list();
    run.mockImplementation(async (command) => {
      if (command === install.update) vi.mocked(io.locate).mockReturnValue({ ...install, path: "D:/other-scope/dist/cli.js", packageName: "@mariozechner/pi-coding-agent" });
      return "0.101.0";
    });
    await updates.update("pi");
    await vi.waitFor(async () => expect((await updates.list()).items[2]).toMatchObject({ state: "error", message: expect.stringContaining("安装位置或安装包发生变化") }));
  });
});
