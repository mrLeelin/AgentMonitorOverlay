import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer, mockClaudeProvider } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import type { McpLaunch } from "../mcp-launch.js";
import { ClaudeRuntime } from "./claude-runtime.js";

// 任务页侧栏的「重连」(2026-11-18) against the real Claude Agent SDK and CLI (mock Anthropic API): a server of the
// person's own (~/.claude.json) that could not start connects again once fixed, and reconnecting writes nothing in the
// config dir (unlike toggleMcpServer, which writes ~/.claude.json).

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];

let root: string;
let claudeHome: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let workspace: Workspace;
let task: Task;
let broken: string;

const until = async (pred: () => boolean | Promise<boolean>, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const agentTexts = (sessionId: string) => store.listItems(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);
const statusOf = async (sessionId: string, name: string) => (await runtime.mcpStatus(sessionId))?.find((x) => x.name === name)?.status;

/** Every settings file of the config dir (not the conversations under projects/), by content. */
function configFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p).replace(/\\/g, "/");
      if (statSync(p).isDirectory()) {
        if (!/^(projects|todos|shell-snapshots|statsig|session-env|debug|file-history)$/.test(rel)) walk(p);
      } else if (rel.endsWith(".json")) out[rel] = createHash("sha1").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

// A minimal MCP server over stdio that exits at once while the flag file exists (as one misconfigured would).
const SERVER = `
if (require("fs").existsSync(process.argv[2])) process.exit(1);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result;
    if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "1" } };
    else if (m.method === "tools/list") result = { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\\n"); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-reconnect-"));
  claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  const script = join(root, "flaky.cjs");
  writeFileSync(script, SERVER);
  broken = join(root, "broken.flag");
  writeFileSync(broken, "");
  writeFileSync(join(claudeHome, ".claude.json"), JSON.stringify({ mcpServers: { flaky: { type: "stdio", command: process.execPath, args: [script, broken] } } }));
  const wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  const plan: McpLaunch = { explicit: {}, deny: [], enableJson: [], strict: false };
  runtime = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: mockClaudeProvider(mock.baseUrl) }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome, mcp: { launch: () => plan } });
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "reconnect", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("reconnecting one MCP server", () => {
  it("connects a fixed server again and writes nothing in the config dir", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "one" });
    await until(() => agentTexts(s.id).includes("MOCK: one") && store.getSession(s.id)!.status === "idle", "first reply");
    await until(async () => (await statusOf(s.id, "flaky")) === "failed", "flaky failed");

    rmSync(broken);
    expect(existsSync(broken)).toBe(false);
    const before = configFiles(claudeHome);
    expect(await runtime.reconnectMcp(s.id, "flaky")).toBe(true);
    await until(async () => (await statusOf(s.id, "flaky")) === "connected", "flaky connected");
    await new Promise((r) => setTimeout(r, 1000));
    expect(configFiles(claudeHome)).toEqual(before);

    // The AMO server is not reconnected; without a running process there is nothing to reconnect.
    await expect(runtime.reconnectMcp(s.id, "amo")).rejects.toThrow("amo");
    await runtime.closeAll();
    expect(await runtime.reconnectMcp(s.id, "flaky")).toBe(false);
  }, 180_000);
});
