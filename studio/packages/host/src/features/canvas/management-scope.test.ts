import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCanvas, type ModelProfile, type Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { toolContext } from "../../mcp/tool-kit.js";
import { canvasTools } from "./mcp.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string, store: Store, servers: FakeServers, service: HostService, topicId: string, leadSessionId: string, topicSessionId: string;
let lead: Task, child: Task, peer: Task;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-canvas-scope-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles);
  const workspace = store.addWorkspace({ name: "项目", path: root });
  topicId = service.topics.createTopic({ title: "专题" }).id;
  lead = store.createTask({ title: "主控", workspaceId: workspace.id, topicId, lead: true });
  child = store.createTask({ title: "执行", workspaceId: workspace.id, topicId, managerTaskId: lead.id });
  peer = store.createTask({ title: "平级", workspaceId: workspace.id, topicId, lead: true });
  const session = { parentId: null, kind: "main" as const, runtime: "codex" as const, profileId: "test", workspaceId: workspace.id, title: "", status: "idle" as const, writer: "workbench" as const, runtimeRef: null };
  leadSessionId = store.createSession({ ...session, taskId: lead.id, topicId: null }).id;
  topicSessionId = store.createSession({ ...session, taskId: null, topicId }).id;
  service.canvases.saveCanvas(topicId, {
    ...emptyCanvas(topicId),
    groups: [{ id: "mixed", title: "混合组", workspaceId: null, rect: { x: 0, y: 0, w: 600, h: 300 } }],
    nodes: [
      { id: "lead", kind: "task", taskId: lead.id, groupId: null, pos: { x: 0, y: 500 } },
      { id: "child", kind: "task", taskId: child.id, groupId: "mixed", pos: { x: 20, y: 60 } },
      { id: "peer", kind: "task", taskId: peer.id, groupId: "mixed", pos: { x: 300, y: 60 } },
    ],
    links: [{ id: "ordinary", from: "child", to: "peer", fromSide: "right", toSide: "left", label: "保留文字" }],
  });
});

afterEach(async () => { await servers.close(); store.close(); removeTempDir(root); });

describe("canvas explicit management scope", () => {
  it("refuses peer cards, mixed groups, dependencies and full-document bypass before any write", async () => {
    const before = service.canvases.canvas(topicId);
    const tools = canvasTools(toolContext(service, { sessionId: leadSessionId }));
    for (const [name, args] of [
      ["canvas_move", { target: peer.id, x: 3, y: 4 }],
      ["canvas_move", { target: "mixed", x: 3, y: 4 }],
      ["canvas_arrange", { targets: ["peer", "child"] }],
      ["canvas_color", { target: peer.id, color: "red" }],
      ["canvas_depend", { fromTaskId: child.id, toTaskId: peer.id }],
    ] as const) {
      expect(await tools.find((t) => t.name === name)!.run(args)).toHaveProperty("isError", true);
      expect(service.canvases.canvas(topicId)).toEqual(before);
    }
    expect(() => service.canvases.saveCanvas(topicId, { ...before, links: [] }, leadSessionId)).toThrow("管理范围");
    expect(service.canvases.canvas(topicId)).toEqual(before);
    service.canvases.canvasSetColor(topicId, { target: child.id, color: "green" }, leadSessionId);
    expect(service.canvases.canvas(topicId).nodes.find((n) => n.id === "child")?.color).toBe("green");
  });

  it("lets the topic entry point arrange peers while ordinary annotations grant no authority", async () => {
    const before = service.canvases.canvas(topicId);
    const tools = canvasTools(toolContext(service, { sessionId: leadSessionId }));
    expect(await tools.find((t) => t.name === "canvas_color")!.run({ target: peer.id, color: "red" })).toHaveProperty("isError", true);
    service.canvases.canvasMove(topicId, { target: "mixed", x: 10, y: 20 }, topicSessionId);
    expect(service.canvases.canvas(topicId).links).toEqual(before.links);
    expect(service.canvases.canvas(topicId).edges).toEqual([]);
    expect(service.canvases.canvas(topicId).groups[0]?.rect).toMatchObject({ x: 10, y: 20 });
  });

  it("checks review callouts and grouped item insertion through the same boundary", () => {
    expect(() => service.canvasReview.addCallout(leadSessionId, topicId, { target: peer.id, text: "越权" })).toThrow("管理范围");
    expect(() => service.canvasReview.addCallout(leadSessionId, topicId, { target: "mixed", text: "越权" })).toThrow("管理范围");
    expect(store.listCallouts(topicId)).toHaveLength(0);
    const ownCallout = service.canvasReview.addCallout(leadSessionId, topicId, { target: child.id, text: "只管理自己的卡片" });
    expect(service.canvasReview.closeFor(topicId, { calloutId: ownCallout.id }, leadSessionId).closed).toEqual([ownCallout.id]);
    const callout = service.canvasReview.addCallout(topicSessionId, topicId, { target: peer.id, text: "请确认" });
    expect(() => service.canvasReview.closeFor(topicId, { calloutId: callout.id }, leadSessionId)).toThrow("管理范围");
    expect(service.canvasReview.getCallout(callout.id).state).toBe("open");
    const before = service.canvases.canvas(topicId);
    expect(() => service.canvasReview.postItems(leadSessionId, topicId, { group: "mixed", items: [{ title: "越权调整分组" }] })).toThrow("管理范围");
    expect(service.canvases.canvas(topicId)).toEqual(before);
    service.canvasReview.postItems(leadSessionId, topicId, { items: [{ title: "自己的审阅" }] });
  });
});
