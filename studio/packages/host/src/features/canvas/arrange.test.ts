import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Task } from "@amo-studio/protocol";
import { emptyCanvas } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { toolContext } from "../../mcp/tool-kit.js";
import { canvasTools } from "./mcp.js";

const PROFILES: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let topicId: string;
let tasks: Task[];
let sessionId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-canvas-arrange-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  const workspace = store.addWorkspace({ name: "测试", path: root });
  topicId = service.topics.createTopic({ title: "专题" }).id;
  tasks = ["甲", "乙"].map((title) => store.createTask({ title, workspaceId: workspace.id, topicId }));
  sessionId = store.createSession({ taskId: tasks[0]!.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId: workspace.id, title: "", status: "idle", writer: "workbench", runtimeRef: null }).id;
  service.canvases.saveCanvas(topicId, {
    ...emptyCanvas(topicId),
    groups: [
      { id: "g1", title: "一组", workspaceId: workspace.id, rect: { x: 100, y: 100, w: 500, h: 320 }, color: "blue" },
      { id: "g2", title: "二组", workspaceId: null, rect: { x: 900, y: 200, w: 300, h: 400 } },
    ],
    nodes: [
      { id: "a", kind: "task", taskId: tasks[0]!.id, groupId: "g1", pos: { x: 112, y: 142 }, size: { w: 400, h: 90 }, color: "yellow" },
      { id: "b", kind: "task", taskId: tasks[1]!.id, groupId: "g1", pos: { x: 350, y: 280 } },
      { id: "note", kind: "note", text: "保留便签", groupId: null, pos: { x: 800, y: 800 }, size: { w: 250, h: 150 } },
      { id: "item", kind: "item", num: 1, title: "保留审阅", body: "内容", status: "discuss", conclusion: "待讨论", sessionId, groupId: null, pos: { x: 900, y: 1000 } },
      { id: "ref", kind: "ref", taskId: "other-task", groupId: "g2", pos: { x: 912, y: 242 } },
    ],
    edges: [{ id: "edge", kind: "depends", from: tasks[0]!.id, to: tasks[1]!.id }],
    links: [{ id: "link", from: "a", to: "b", fromSide: "right", toSide: "left", label: "说明" }],
  });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("画布移动排序", () => {
  it("includes exact geometry only when canvas_read requests layout", async () => {
    const read = canvasTools(toolContext(service, { sessionId })).find((t) => t.name === "canvas_read")!;
    const plain = await read.run({});
    const plainData = JSON.parse(plain.content[1]!.text);
    expect(plainData).not.toHaveProperty("layout");
    const withLayout = await read.run({ topic: "专题", layout: true });
    const { layout, ...structure } = JSON.parse(withLayout.content[1]!.text);
    expect(structure).toEqual(plainData);
    expect(withLayout.content[0]).toEqual(plain.content[0]);
    expect(layout.groups).toEqual([
      { id: "g1", rect: { x: 100, y: 100, w: 500, h: 320 } },
      { id: "g2", rect: { x: 900, y: 200, w: 300, h: 400 } },
    ]);
    expect(layout.nodes[0]).toEqual({ id: "a", kind: "task", taskId: tasks[0]!.id, groupId: "g1", pos: { x: 112, y: 142 }, size: { w: 400, h: 90 } });
    expect(layout.nodes[3]).toEqual({ id: "item", kind: "item", groupId: null, pos: { x: 900, y: 1000 } });
    expect(JSON.parse((await read.run({ layout: false })).content[1]!.text)).toEqual(plainData);
  });

  it("orders task cards by requested ids using resized widths and expands their group", () => {
    const before = service.canvases.canvas(topicId);
    const result = service.canvases.canvasArrange(topicId, { targets: [tasks[1]!.id, tasks[0]!.id], direction: "horizontal" });
    const doc = service.canvases.canvas(topicId);
    expect(result.arranged.map((n) => [n.id, n.pos])).toEqual([["b", { x: 112, y: 142 }], ["a", { x: 348, y: 142 }]]);
    expect(doc.groups[0]!.rect).toEqual({ x: 100, y: 100, w: 660, h: 320 });
    expect(doc.nodes.find((n) => n.id === "a")).toMatchObject({ groupId: "g1", size: { w: 400, h: 90 }, color: "yellow" });
    expect(doc.edges).toEqual(before.edges);
    expect(doc.links).toEqual(before.links);
    expect(doc.nodes.find((n) => n.id === "item")).toEqual(before.nodes.find((n) => n.id === "item"));
  });

  it("uses review item height and the requested order for a vertical arrangement", () => {
    const result = service.canvases.canvasArrange(topicId, { targets: ["#1", "note"] });
    expect(result.direction).toBe("vertical");
    expect(result.arranged).toMatchObject([
      { id: "item", pos: { x: 800, y: 800 }, size: { w: 240, h: 124 } },
      { id: "note", pos: { x: 800, y: 940 }, size: { w: 250, h: 150 } },
    ]);
    expect(service.canvases.canvas(topicId).nodes.find((n) => n.id === "item")).toMatchObject({ body: "内容", status: "discuss", conclusion: "待讨论" });
  });

  it("moves groups with every member while keeping cards and connections intact", () => {
    const before = service.canvases.canvas(topicId);
    service.canvases.canvasArrange(topicId, { targets: ["g2", "g1"], direction: "horizontal" });
    const doc = service.canvases.canvas(topicId);
    expect(doc.groups[0]!.rect).toEqual({ x: 416, y: 100, w: 500, h: 320 });
    expect(doc.groups[1]!.rect).toEqual({ x: 100, y: 100, w: 300, h: 400 });
    expect(doc.nodes.find((n) => n.id === "a")!.pos).toEqual({ x: 428, y: 142 });
    expect(doc.nodes.find((n) => n.id === "b")!.pos).toEqual({ x: 666, y: 280 });
    expect(doc.nodes.find((n) => n.id === "ref")!.pos).toEqual({ x: 112, y: 142 });
    expect(doc.nodes.find((n) => n.id === "note")).toEqual(before.nodes.find((n) => n.id === "note"));
    expect(doc.edges).toEqual(before.edges);
    expect(doc.links).toEqual(before.links);
  });

  it("moves one group precisely and expands a moved card's group on every side", () => {
    service.canvases.canvasMove(topicId, { target: "g1", x: -200, y: 700 });
    expect(service.canvases.canvas(topicId).nodes.find((n) => n.id === "a")!.pos).toEqual({ x: -188, y: 742 });
    const result = service.canvases.canvasMove(topicId, { target: tasks[0]!.id, x: -400, y: 500 });
    expect(result).toMatchObject({ target: tasks[0]!.id, id: "a", pos: { x: -400, y: 500 } });
    const doc = service.canvases.canvas(topicId);
    expect(doc.groups[0]!.rect).toEqual({ x: -412, y: 458, w: 712, h: 562 });
    expect(doc.nodes.find((n) => n.id === "a")).toMatchObject({ groupId: "g1", size: { w: 400, h: 90 } });
    expect(doc.nodes.find((n) => n.id === "b")!.pos).toEqual({ x: 50, y: 880 });
  });

  it("rejects invalid selections and coordinates without saving any partial change", () => {
    const before = service.canvases.canvas(topicId);
    for (const input of [
      { targets: ["a", "missing"] },
      { targets: ["a", tasks[0]!.id] },
      { targets: ["g1", "b"] },
      { targets: ["a", "note"] },
      { targets: [] },
      { targets: ["a"], direction: "diagonal" },
    ]) {
      expect(() => service.canvases.canvasArrange(topicId, input)).toThrow();
      expect(service.canvases.canvas(topicId)).toEqual(before);
    }
    for (const input of [{ target: "missing", x: 1, y: 2 }, { target: "a", x: Number.NaN, y: 2 }, { target: "a", x: 1, y: Number.POSITIVE_INFINITY }]) {
      expect(() => service.canvases.canvasMove(topicId, input)).toThrow();
      expect(service.canvases.canvas(topicId)).toEqual(before);
    }
  });

  it("scopes MCP layout edits to the caller's topic and refuses anonymous writes", async () => {
    const before = service.canvases.canvas(topicId);
    const anonymous = canvasTools(toolContext(service, null));
    expect(await anonymous.find((t) => t.name === "canvas_move")!.run({ target: "a", x: 1, y: 2 })).toHaveProperty("isError", true);
    const otherTopicId = service.topics.createTopic({ title: "别的专题" }).id;
    const foreign = store.createSession({ ...store.getSession(sessionId)!, id: undefined, taskId: null, topicId: otherTopicId });
    const foreignTools = canvasTools(toolContext(service, { sessionId: foreign.id }));
    expect(await foreignTools.find((t) => t.name === "canvas_arrange")!.run({ targets: ["a"] })).toHaveProperty("isError", true);
    expect(service.canvases.canvas(topicId)).toEqual(before);
    const own = canvasTools(toolContext(service, { sessionId }));
    expect(await own.find((t) => t.name === "canvas_move")!.run({ target: "#1", x: 10, y: 20 })).not.toHaveProperty("isError", true);
    expect(service.canvases.canvas(topicId).nodes.find((n) => n.id === "item")!.pos).toEqual({ x: 10, y: 20 });
  });
});
