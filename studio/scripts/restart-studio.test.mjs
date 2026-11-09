import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture({ running = 0, buildExit = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-restart-"));
  roots.push(root);
  const studio = join(root, "含空格 Studio");
  for (const path of ["scripts", ".data", "bin", "node_modules/electron/dist"]) mkdirSync(join(studio, path), { recursive: true });
  copyFileSync(new URL("./restart-studio.mjs", import.meta.url), join(studio, "scripts/restart-studio.mjs"));
  writeFileSync(join(studio, "node_modules/electron/dist/electron.exe"), "");
  writeFileSync(join(studio, "bin/npm.cmd"), `@echo off\r\necho built>build-ran.txt\r\nexit /b ${buildExit}\r\n`);
  writeFileSync(join(studio, ".data/host-token"), "fixture-token");
  const shutdowns = [];
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") return response.end(JSON.stringify({ ok: true, pid: process.pid, running }));
    shutdowns.push({ method: request.method, authorization: request.headers.authorization });
    response.statusCode = 409;
    response.end(JSON.stringify({ ok: false, running: 1 }));
  });
  servers.push(server);
  // Tests stay in the repository's reserved range; EADDRINUSE just tries the next port.
  for (let port = 47999; port >= 47900; port--) {
    const listening = await new Promise((done) => {
      const failed = () => done(false);
      server.once("error", failed);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", failed); done(true); });
    });
    if (listening) break;
  }
  if (!server.listening) throw new Error("No test port available");
  writeFileSync(join(studio, ".data/host.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, pid: process.pid }));
  return {
    studio, shutdowns,
    run: () => new Promise((done, reject) => {
      const child = spawn(process.execPath, [join(studio, "scripts/restart-studio.mjs")], {
        cwd: root, env: { ...process.env, PATH: `${join(studio, "bin")};${process.env.PATH}` }, windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => done({ code, output }));
    }),
  };
}

describe.skipIf(process.platform !== "win32")("源码版双击重启", () => {
  it("有会话运行时不构建、不关闭后台，并释放重启锁", async () => {
    const test = await fixture({ running: 1 });
    const result = await test.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("有会话正在运行");
    expect(test.shutdowns).toEqual([]);
    expect(existsSync(join(test.studio, "build-ran.txt"))).toBe(false);
    expect(existsSync(join(test.studio, ".data/restart.lock"))).toBe(false);
  });

  it("构建失败保留当前后台，中文空格路径可运行", async () => {
    const test = await fixture({ buildExit: 2 });
    const result = await test.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("构建失败");
    expect(existsSync(join(test.studio, "build-ran.txt"))).toBe(true);
    expect(test.shutdowns).toEqual([]);
  });

  it("构建期间开始的会话由关闭接口保护，不强制中断", async () => {
    const test = await fixture();
    const result = await test.run();
    expect(result.code).toBe(1);
    expect(result.output).toContain("构建期间有会话开始运行");
    expect(test.shutdowns).toEqual([{ method: "POST", authorization: "Bearer fixture-token" }]);
    expect(existsSync(join(test.studio, ".data/restart.lock"))).toBe(false);
  });
});
