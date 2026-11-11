import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PI_MCP_SERVERS_ENV, piMcpExtension, piUnavailable, resolvePiCommand } from "./launch.js";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-pi-launch-")); roots.push(dir); return dir; };
const file = (path: string, content = "") => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content, "utf8"); return path; };

afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Pi launch", () => {
  it.each(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"])("resolves %s npm shims through Node without a shell", (name) => {
    const dir = root();
    file(join(dir, "pi.cmd"), "@echo off\r\n");
    const entry = file(join(dir, "node_modules", name, "dist", "cli.js"));
    file(join(dir, "node_modules", name, "package.json"), JSON.stringify({ bin: { pi: "dist/cli.js" } }));
    expect(resolvePiCommand({ PATH: dir, AMO_STUDIO_NODE: process.execPath }, "win32")).toEqual({ command: process.execPath, args: [entry] });
  });

  it("respects PATH order, quoted directories, and a native executable", () => {
    const dir = root(), first = join(dir, "first"), second = join(dir, "second");
    const binary = file(join(first, "pi.exe"));
    file(join(second, "pi.exe"));
    expect(resolvePiCommand({ PATH: `"${first}"${delimiter}${second}` }, "win32")).toEqual({ command: binary, args: [] });
  });

  it("supports an executable Pi on non-Windows systems", () => {
    const dir = root(), binary = file(join(dir, "pi"));
    expect(resolvePiCommand({ PATH: dir }, "linux")).toEqual({ command: binary, args: [] });
  });

  it("refuses unrecognised wrappers, missing entry points and npm bins outside the package", () => {
    const dir = root();
    file(join(dir, "pi.cmd"));
    expect(resolvePiCommand({ PATH: dir }, "win32")).toBeNull();
    const pkg = join(dir, "node_modules", "@earendil-works/pi-coding-agent", "package.json");
    file(pkg, JSON.stringify({ bin: "missing.js" }));
    expect(resolvePiCommand({ PATH: dir }, "win32")).toBeNull();
    file(join(dir, "node_modules", "outside.js"));
    file(pkg, JSON.stringify({ bin: "../../outside.js" }));
    expect(resolvePiCommand({ PATH: dir }, "win32")).toBeNull();
    expect(piUnavailable({ PATH: "" })).toContain("没有找到 Pi");
  });

  it("creates a constant MCP extension that registers transient servers and removes its secret environment", async () => {
    const dir = root(), extension = piMcpExtension(dir);
    const source = readFileSync(extension, "utf8");
    const previous = process.env[PI_MCP_SERVERS_ENV];
    const config = { amo: { url: "http://127.0.0.1:47999/mcp", headers: { Authorization: "Bearer test-secret" } } };
    try {
      process.env[PI_MCP_SERVERS_ENV] = JSON.stringify(config);
      const module = await import(pathToFileURL(extension).href);
      const registered: unknown[] = [];
      const handlers = new Map<string, () => unknown>();
      module.default({ on: (name: string, handler: () => unknown) => handlers.set(name, handler), events: { emit() {} }, registerMcpServer: (...args: unknown[]) => registered.push(args) });
      expect(registered).toEqual([]);
      handlers.get("session_start")!();
      expect(registered).toEqual([["amo", config.amo]]);
      expect(process.env[PI_MCP_SERVERS_ENV]).toBeUndefined();
      expect(source).not.toContain("test-secret");
      expect(piMcpExtension(dir)).toBe(extension);
      expect(readFileSync(extension, "utf8")).toBe(source);
      process.env[PI_MCP_SERVERS_ENV] = JSON.stringify(config);
      module.default({ on: (name: string, handler: () => unknown) => handlers.set(name, handler), events: { emit() {} } });
      expect(() => handlers.get("session_start")!()).toThrow("升级 Pi");
    } finally {
      if (previous === undefined) delete process.env[PI_MCP_SERVERS_ENV];
      else process.env[PI_MCP_SERVERS_ENV] = previous;
    }
  });

  it("uses pi-mcp-adapter runtime registration after extensions load, without registering unhandled native servers", async () => {
    const extension = piMcpExtension(root());
    const previous = process.env[PI_MCP_SERVERS_ENV];
    const config = { amo: { type: "http", url: "http://127.0.0.1:47999/mcp", headers: { Authorization: "Bearer test-secret" } }, local: { type: "stdio", command: "node", args: ["server.mjs"], env: { TEST: "value" } } };
    const requests: any[] = [], disposed: string[] = [], native: unknown[] = [];
    const handlers = new Map<string, () => unknown>();
    try {
      process.env[PI_MCP_SERVERS_ENV] = JSON.stringify(config);
      const module = await import(pathToFileURL(extension).href);
      module.default({
        on: (name: string, handler: () => unknown) => handlers.set(name, handler),
        events: { emit: (event: string, request: any) => {
          expect(event).toBe("pi-mcp-adapter:runtime-register:v1");
          requests.push(request);
          request.result = { ok: true, registration: { dispose: async () => { disposed.push(request.name); } } };
        } },
        registerMcpServer: (...args: unknown[]) => native.push(args),
      });
      expect(process.env[PI_MCP_SERVERS_ENV]).toBeUndefined();
      expect(requests).toEqual([]);
      handlers.get("session_start")!();
      expect(requests.map(({ version, name, definition }) => ({ version, name, definition }))).toEqual([
        { version: 1, name: "amo", definition: { url: config.amo.url, headers: config.amo.headers, httpTransport: "streamable-http", lifecycle: "eager" } },
        { version: 1, name: "local", definition: { command: "node", args: ["server.mjs"], env: { TEST: "value" }, lifecycle: "eager" } },
      ]);
      expect(native).toEqual([]);
      handlers.get("session_start")!();
      expect(requests).toHaveLength(2);
      await handlers.get("session_shutdown")!();
      expect(disposed).toEqual(["amo", "local"]);
      handlers.get("session_start")!();
      expect(requests).toHaveLength(4);
    } finally {
      if (previous === undefined) delete process.env[PI_MCP_SERVERS_ENV];
      else process.env[PI_MCP_SERVERS_ENV] = previous;
    }
  });

  it("surfaces adapter registration failures without silently falling back to an unhandled native registry", async () => {
    const extension = piMcpExtension(root()), previous = process.env[PI_MCP_SERVERS_ENV];
    const handlers = new Map<string, () => unknown>();
    try {
      process.env[PI_MCP_SERVERS_ENV] = JSON.stringify({ amo: { url: "http://127.0.0.1:47999/mcp" } });
      const module = await import(pathToFileURL(extension).href);
      const native: unknown[] = [];
      module.default({
        on: (name: string, handler: () => unknown) => handlers.set(name, handler),
        events: { emit: (_event: string, request: any) => { request.result = { ok: false, error: new Error("duplicate server") }; } },
        registerMcpServer: (...args: unknown[]) => native.push(args),
      });
      expect(() => handlers.get("session_start")!()).toThrow("duplicate server");
      expect(native).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[PI_MCP_SERVERS_ENV];
      else process.env[PI_MCP_SERVERS_ENV] = previous;
    }
  });
});
