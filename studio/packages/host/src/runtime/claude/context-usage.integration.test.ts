import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelProfile, SessionItem, Task, Workspace } from "@amo-studio/protocol";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, type ClaudeMockServer, mockClaudeProvider } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { RuntimeRouter } from "../runtime.js";
import { HostService } from "../../service.js";
import { ClaudeRuntime } from "./claude-runtime.js";

// 任务页侧栏「环境与上下文」(2026-11-18) against the real Claude Agent SDK and CLI (mock Anthropic API): the context
// breakdown comes from the running process (getContextUsage), lists the project's CLAUDE.md, and stays shown (not
// live) once the process has exited; other runtimes say they have no breakdown.

const PROFILES: ModelProfile[] = [{ id: "claude-mock", label: "Mock Claude", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }];

let root: string;
let mock: ClaudeMockServer;
let store: Store;
let runtime: ClaudeRuntime;
let service: HostService;
let workspace: Workspace;
let task: Task;

const until = async (pred: () => boolean, label: string, timeoutMs = 60_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const agentTexts = (sessionId: string) => store.listItems(sessionId).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).map((i) => i.markdown);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-context-"));
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  const wsDir = join(root, "workspace");
  mkdirSync(wsDir, { recursive: true });
  writeFileSync(join(wsDir, "CLAUDE.md"), "# 项目说明\n回答用中文。\n");
  mock = await startMockAnthropic();
  store = new Store(join(root, "studio.db"));
  runtime = new ClaudeRuntime({ store, profiles: PROFILES, providers: { mock: mockClaudeProvider(mock.baseUrl) }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome });
  service = new HostService(store, new RuntimeRouter(store, PROFILES, { claude: runtime }), PROFILES, { localClaudeHome: claudeHome });
  workspace = store.addWorkspace({ path: wsDir, name: "ws" });
  task = store.createTask({ title: "context", workspaceId: workspace.id });
});

afterAll(async () => {
  await runtime?.closeAll();
  store?.close();
  await mock?.close();
  if (root) removeTempDir(root);
});

describe("context usage by category", () => {
  it("reads it from the running process, then keeps the last one once the process has exited", async () => {
    const s = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "one" });
    await until(() => agentTexts(s.id).includes("MOCK: one") && store.getSession(s.id)!.status === "idle", "first reply");

    const now = await service.sessions.contextUsage(s.id);
    expect(now.live).toBe(true);
    expect(now.unavailable).toBeUndefined();
    const b = now.breakdown!;
    expect(b.window).toBeGreaterThan(0);
    expect(b.used).toBeGreaterThan(0);
    expect(b.categories.some((c) => c.kind === "used" && c.tokens > 0)).toBe(true);
    expect(b.categories.some((c) => c.kind === "free")).toBe(true);
    expect(b.memoryFiles.some((f) => f.path.endsWith("CLAUDE.md"))).toBe(true);

    await runtime.closeAll();
    const after = await service.sessions.contextUsage(s.id);
    expect(after.live).toBe(false);
    expect(after.breakdown).toEqual(b);
  }, 180_000);

  it("says other runtimes have no breakdown, and a Claude session never read has none yet", async () => {
    const base = store.getSession((await runtime.startSession({ taskId: task.id, topicId: null, profileId: "claude-mock", workspace, text: "two" })).id)!;
    await until(() => agentTexts(base.id).includes("MOCK: two") && store.getSession(base.id)!.status === "idle", "second reply");
    await runtime.closeAll();
    const fresh = await service.sessions.contextUsage(base.id);
    expect(fresh).toMatchObject({ breakdown: null, live: false });
    expect(fresh.unavailable).toContain("进程没开着");

    const codex = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "claude-mock", workspaceId: workspace.id, title: "c", status: "idle", writer: base.writer, runtimeRef: null });
    const other = await service.sessions.contextUsage(codex.id);
    expect(other).toMatchObject({ breakdown: null, live: false });
    expect(other.unavailable).toContain("不提供分项");
  }, 180_000);
});
