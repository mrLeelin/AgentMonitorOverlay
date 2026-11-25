import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dpapi } from "@amo-studio/account";
import { PLANE_BOARD_API, type ModelProfile, type Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAmoMcpServer } from "../../mcp/amo-mcp.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { PlaneBoardSettings } from "./plane-settings.js";
import { teamTasksRoutes } from "./routes.js";

const origin = "https://plane.test";
const projectId = "71eac826-1d93-4182-9832-b640d4ca1369";
const workItemId = "21eac826-1d93-4182-9832-b640d4ca1369";
const parentId = "11eac826-1d93-4182-9832-b640d4ca1369";
const fileId = "91eac826-1d93-4182-9832-b640d4ca1369";
const commentId = "31eac826-1d93-4182-9832-b640d4ca1369";
const prefix = `${PLANE_BOARD_API}/workspaces/demo/projects/${projectId}`;
const parentUrl = `${origin}/demo/browse/DEMO-1/`;
const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test" }];
let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let session: Session;
let mcp: Client;
let planeViewer: string;
const fetchPlane = vi.fn<typeof fetch>();

function callerTask() {
  const workspace = service.projects.addWorkspace({ path: root });
  const task = store.createTask({ title: "本地副本", workspaceId: workspace.id });
  store.db.prepare("INSERT INTO local_team_board_links (task_id, server, account, ticket_id) VALUES (?, ?, ?, ?)").run(task.id, origin + prefix, "plane-account", workItemId);
  return { workspace, task };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-plane-context-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles);
  planeViewer = "plane-account";
  const { workspace, task } = callerTask();
  session = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId: workspace.id, title: "", status: "idle", writer: "workbench", runtimeRef: "fixture" });
  vi.spyOn(PlaneBoardSettings.prototype, "current", "get").mockReturnValue({ owner: "fixture", server: origin, sealed: "fixture-encrypted-key", selected: null });
  const server = createAmoMcpServer(service, { sessionId: session.id });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  mcp = new Client({ name: "plane-context-test", version: "0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  vi.spyOn(dpapi, "unprotect").mockResolvedValue("fixture-plane-key");
  fetchPlane.mockReset();
  fetchPlane.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(`/files/${fileId}`)) return new Response("测试附件", { headers: { "X-Plane-Viewer": planeViewer, "X-Plane-Filename": encodeURIComponent("原单.txt") } });
    if (url.pathname.endsWith("/resolve/DEMO/1")) return Response.json({ project: projectId, ticketId: parentId });
    const parent = url.pathname.includes(parentId);
    const item = { id: parent ? parentId : workItemId, title: parent ? "父工作项" : "团队原单", state: "审查中" };
    const offset = url.searchParams.get("offset");
    return Response.json({
      viewerId: planeViewer, item,
      ...(url.searchParams.get("section") === "comment" ? { comment: { id: commentId, text: "评论余下正文", nextOffset: null } } :
        offset ? { comments: { items: [{ text: "较早评论" }], nextOffset: null } } : {
        parent: { id: parentId, url: parentUrl }, children: { items: [{ title: "子工作项" }], nextOffset: null },
        comments: { items: [{ id: commentId, text: "最近评论", textNextOffset: 1800 }], nextOffset: 10 }, files: { items: [{ id: fileId }], nextOffset: null },
      }),
    });
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchPlane);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await mcp.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  const text = result.content[0]!.text;
  return { error: result.isError, data: result.isError ? text : JSON.parse(text), text };
}

describe("Plane work item context", () => {
  it("defaults to the existing connection and lets an explicit switch hide access without deleting it", async () => {
    expect(service.config.settings().teamTasksEnabled).toBe(true);
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("plane_task_get");
    expect(() => service.config.updateSettings({ teamTasksEnabled: "false" })).toThrow(/true or false/);
    expect(service.config.updateSettings({ teamTasksEnabled: false }).teamTasksEnabled).toBe(false);
    expect(await call("plane_task_get")).toMatchObject({ error: true, text: expect.stringContaining("团队任务已关闭") });
    expect(await call("plane_task_file", { fileId })).toMatchObject({ error: true, text: expect.stringContaining("团队任务已关闭") });
    expect(service.teamTasks.board.contextInstruction(session.taskId!)).toBe("");
    const routes = teamTasksRoutes(service);
    const entry = routes.find((entry) => entry.path === "/api/team-board/plane/work-items/:id");
    expect(() => entry!.handle({ method: "GET", path: "", params: { id: workItemId }, query: new URLSearchParams(), body: undefined })).toThrow(/团队任务已关闭/);
    expect(fetchPlane).not.toHaveBeenCalled();
    expect(service.teamTasks.board.reference(session.taskId!)?.url).toContain(workItemId);
    expect(service.config.updateSettings({ teamTasksEnabled: true }).teamTasksEnabled).toBe(true);
    expect((await call("plane_task_get")).data.item.id).toBe(workItemId);
  });

  it("hides the feature by default on an installation without a saved team connection", () => {
    vi.stubEnv("AMO_TEAM_BOARD_URL", undefined);
    vi.spyOn(PlaneBoardSettings.prototype, "current", "get").mockReturnValue(undefined);
    expect(service.config.settings().teamTasksEnabled).toBe(false);
    vi.stubEnv("AMO_TEAM_BOARD_URL", origin);
    expect(service.config.settings().teamTasksEnabled).toBe(true);
    vi.stubEnv("AMO_TEAM_BOARD_URL", undefined);
    expect(service.config.updateSettings({ teamTasksEnabled: true }).teamTasksEnabled).toBe(true);
  });

  it("reads the bound original, follows the provided parent URL and pages older comments", async () => {
    const first = await call("plane_task_get");
    expect(first.data).toMatchObject({ item: { id: workItemId, state: "审查中" }, parent: { url: parentUrl }, children: { items: [{ title: "子工作项" }] }, comments: { nextOffset: 10 } });
    expect(first.text).not.toContain("fixture-plane-key");
    expect(first.text).not.toContain("plane-account");
    expect(fetchPlane).toHaveBeenNthCalledWith(1, expect.stringContaining(`${prefix}/work-items/${workItemId}/context`), expect.objectContaining({ headers: { "x-api-key": "fixture-plane-key" } }));
    expect((await call("plane_task_get", { section: "comments", offset: 10 })).data.comments).toEqual({ items: [{ text: "较早评论" }], nextOffset: null });
    expect(fetchPlane).toHaveBeenNthCalledWith(2, expect.stringContaining("section=comments&offset=10"), expect.anything());
    expect((await call("plane_task_get", { url: parentUrl })).data.item.title).toBe("父工作项");
    expect((await call("plane_task_get", { section: "comment", commentId, offset: 1800 })).data.comment.text).toBe("评论余下正文");
    expect(fetchPlane).toHaveBeenLastCalledWith(expect.stringContaining(`section=comment&offset=1800&commentId=${commentId}`), expect.anything());
  });

  it("downloads a file on demand and returns a readable local copy", async () => {
    const { data } = await call("plane_task_file", { fileId });
    expect(data.name).toBe("原单.txt");
    expect(readFileSync(data.path, "utf8")).toBe("测试附件");
  });

  it("rejects a changed account or removed link without returning ticket data", async () => {
    planeViewer = "other-account";
    expect(await call("plane_task_get")).toMatchObject({ error: true, text: expect.stringContaining("切换回") });
    expect(await call("plane_task_file", { fileId })).toMatchObject({ error: true, text: expect.stringContaining("切换回") });
    service.teamTasks.board.detach(session.taskId!);
    expect(await call("plane_task_get", { url: parentUrl })).toMatchObject({ error: true, text: expect.stringContaining("没有关联") });
    expect(fetchPlane).toHaveBeenCalledTimes(2);
  });

  it("rejects a URL on a different Plane server before contacting it", async () => {
    expect(await call("plane_task_get", { url: "https://other.test/demo/browse/DEMO-1/" })).toMatchObject({ error: true, text: expect.stringContaining("当前已连接的 Plane 服务器") });
    expect(fetchPlane).not.toHaveBeenCalled();
  });

  it("adds the read-before-work instruction to a direct start and leaves unrelated tasks alone", async () => {
    const workspace = store.getWorkspace(session.workspaceId)!;
    const linked = await service.tasks.startSession({ taskId: session.taskId, topicId: null }, workspace, { profileId: "test", text: "开始处理" });
    const localTask = store.createTask({ title: "普通任务", workspaceId: workspace.id });
    const local = await service.tasks.startSession({ taskId: localTask.id, topicId: null }, workspace, { profileId: "test", text: "开始处理" });
    expect(store.listItems(linked.id).find((i) => i.type === "user")?.text).toContain("先调用 plane_task_get");
    expect(store.listItems(local.id).find((i) => i.type === "user")?.text).toBe("开始处理");
  });

  it("adds the instruction when a task filed for later sends its first message", async () => {
    const workspace = store.getWorkspace(session.workspaceId)!;
    const filed = await service.tasks.startSession({ taskId: session.taskId, topicId: null }, workspace, { profileId: "test" });
    expect(store.listItems(filed.id)).toEqual([]);
    await service.sessions.sendMessage(filed.id, "开始处理");
    expect(store.listItems(filed.id).find((i) => i.type === "user")?.text).toContain("先调用 plane_task_get");
    expect(store.hasWorkInput(filed.id)).toBe(true);
  });
});
