import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { McpServerSpec, ModelProfile } from "@amo-studio/protocol";
import { mockCodexProvider, removeTempDir, startMockModel } from "@amo-studio/testkit";
import { startHostServer, type HostServer } from "../../http/server.js";
import { McpIdentities } from "../../mcp/identity.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { CodexRuntime } from "./codex-runtime.js";
import { CodexServerManager } from "./server-manager.js";

// A real app-server and AMO HTTP MCP with a scripted model: management writes must work without file access.
it("keeps lead allocation and canvas management available through real Codex MCP under never+read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-test-lead-mcp-"));
  const workspacePath = join(root, "workspace");
  mkdirSync(workspacePath);
  mkdirSync(join(root, "codex-home"));
  const mock = await startMockModel();
  const store = new Store(":memory:");
  const identities = new McpIdentities(store);
  const profiles: ModelProfile[] = [{ id: "mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" }];
  let http: HostServer | undefined;
  const manager = new CodexServerManager({ dataDir: join(root, "data"), profiles, credentials: new StaticCredentialReader({ mock: "mock-key" }), cwd: root, env: { CODEX_HOME: join(root, "codex-home") }, providers: { "amo-mock": mockCodexProvider(mock.baseUrl) }, portRange: [47940, 47949], mcp: () => http ? { url: `${http.url}/mcp`, token: "test-mcp" } : null, extraMcp: (): Record<string, McpServerSpec> => http ? { unsafe: { type: "http", url: `${http.url}/mcp`, headers: { Authorization: "Bearer test-mcp" } } } : {} });
  const runtime = new CodexRuntime({ store, servers: manager, profiles, identities });
  const service = new HostService(store, runtime, profiles);
  try {
    http = await startHostServer({ service, token: "test-host", mcpToken: "test-mcp", mcpIdentities: identities });
    const workspace = service.projects.addWorkspace({ path: workspacePath });
    const topic = service.topics.createTopic({ title: "主控画布" });
    const task = store.createTask({ title: "lead", workspaceId: workspace.id, topicId: topic.id, lead: true });
    const session = await runtime.startSession({ taskId: task.id, topicId: null, profileId: "mock", workspace, text: '[[mcp: task_plan_propose {"summary":"拆开实现","tasks":[{"title":"实现功能","description":"由执行任务改代码"}]}]]' });
    const started = Date.now();
    while (!store.listTaskPlans().length && Date.now() - started < 25_000) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.listTaskPlans()).toMatchObject([{ fromTaskId: task.id, state: "open", tasks: [{ title: "实现功能" }] }]);
    const idle = Date.now();
    while (store.getSession(session.id)?.status !== "idle" && Date.now() - idle < 10_000) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store.getSession(session.id)?.status).toBe("idle");
    await runtime.sendMessage(session.id, '[[mcp: canvas_group_create {"title":"实施任务"}]]');
    const arranged = Date.now();
    while (!service.canvases.canvas(topic.id).groups.length && Date.now() - arranged < 15_000) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(service.canvases.canvas(topic.id).groups).toMatchObject([{ title: "实施任务" }]);
    expect(store.listItems(session.id).some((item) => item.type === "approval")).toBe(false);
    const handle = await manager.ensure("mock");
    const status = await handle.client.request("mcpServerStatus/list", { threadId: session.runtimeRef }) as { data: Array<{ name: string; runtimeStatus?: string; tools: Record<string, unknown> }> };
    expect(status.data.find((server) => server.name === "unsafe")?.runtimeStatus).toBe("disabled");
  } finally {
    await manager.stopAll();
    await http?.close();
    store.close();
    await mock.close();
    removeTempDir(root);
  }
}, 60_000);
