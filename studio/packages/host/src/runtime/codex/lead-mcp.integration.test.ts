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
    const bot = service.bots.save({ name: "画布主控", purpose: "派工并管理画布", memory: "", workspaceId: workspace.id, profileId: "mock", enabled: true });
    const appointment = service.botLeads.appoint({ operationId: "lead-mcp-integration", source: { kind: "manual" }, intent: "create", workspaceId: workspace.id, title: "lead", topic: { topicTitle: "主控画布" }, botId: bot.id,
      firstMessage: '[[mcp: task_plan_propose {"summary":"拆开实现","tasks":[{"title":"实现功能","description":"由执行任务改代码"}]}]]' });
    const task = store.getTask(appointment.taskId!)!;
    const topicId = task.topicId!;
    await expect.poll(() => store.listTaskPlans(), { timeout: 25_000 }).toMatchObject([{
      fromTaskId: task.id, state: "accepted", tasks: [{ title: "实现功能" }], created: [{ taskId: expect.any(String) }],
    }]);
    const session = store.getSession(service.botLeads.currentTerm(task.id)!.sessionId!)!;
    const childId = store.listTaskPlans()[0]!.created![0]!.taskId;
    expect(store.getTask(childId)).toMatchObject({ title: "实现功能", managerTaskId: task.id, topicId });
    await expect.poll(() => store.getSession(session.id)?.status, { timeout: 10_000 }).toBe("idle");
    await service.sessions.sendMessage(session.id, '[[mcp: canvas_group_create {"title":"实施任务"}]]');
    await expect.poll(() => service.canvases.canvas(topicId).groups, { timeout: 15_000 }).toMatchObject([{ title: "实施任务" }]);
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
