import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acpServer } from "./mcp-launch.js";

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "amo-mcp-command-"));
  roots.push(root);
  return root;
};
const executable = (file: string) => { writeFileSync(file, ""); chmodSync(file, 0o755); return file; };
const suffix = process.platform === "win32" ? ".cmd" : "";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DSH ACP MCP commands", () => {
  it("resolves a short command from PATH before session/new or session/resume", () => {
    const root = fixture();
    const file = executable(join(root, `codegraph${suffix}`));
    const server = acpServer("codegraph", { type: "stdio", command: "codegraph", args: ["mcp"], env: { TOKEN: "test" } }, { PATH: root }, root);
    expect(isAbsolute(server.command as string)).toBe(true);
    expect(server).toEqual({ name: "codegraph", command: file, args: ["mcp"], env: [{ name: "TOKEN", value: "test" }] });
  });

  it("uses the server's PATH, resolves relative PATH entries against the workspace, and skips directories", () => {
    const root = fixture();
    mkdirSync(join(root, "bin"));
    mkdirSync(join(root, `tool${suffix}`));
    const file = executable(join(root, "bin", `tool${suffix}`));
    const env: Record<string, string> = process.platform === "win32" ? { Path: `.${delimiter}bin` } : { PATH: `.${delimiter}bin` };
    expect(acpServer("tool", { type: "stdio", command: "tool", env }, { PATH: "missing" }, root).command).toBe(file);
  });

  it("resolves a workspace-relative command and leaves absolute commands and HTTP specs intact", () => {
    const root = fixture();
    mkdirSync(join(root, "bin"));
    const file = executable(join(root, "bin", `tool${suffix}`));
    expect(acpServer("tool", { type: "stdio", command: `./bin/tool${suffix}` }, {}, root).command).toBe(file);
    expect(acpServer("tool", { type: "stdio", command: file }, {}, root).command).toBe(file);
    expect(acpServer("remote", { type: "http", url: "https://example.test/mcp" })).toEqual({ type: "http", name: "remote", url: "https://example.test/mcp", headers: [] });
  });

  it("names an unresolvable MCP instead of forwarding an invalid ACP command", () => {
    expect(() => acpServer("missing-mcp", { type: "stdio", command: "missing-command" }, { PATH: "" }, fixture())).toThrow(/missing-mcp.*missing-command/);
  });
});
