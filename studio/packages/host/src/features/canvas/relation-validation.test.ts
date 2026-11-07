import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type CanvasLink, type ModelProfile, type Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { toolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";
import { canvasTools } from "./mcp.js";
import { canvasRoutes } from "./routes.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string, store: Store, servers: FakeServers, service: HostService, topicId: string, topicSessionId: string, leadSessionId: string;
let tasks: Task[];
const ordinary = (id: string, from: string, to: string, patch: Partial<CanvasLink> = {}): CanvasLink => ({ id, from, to, fromSide: "right", toSide: "left", ...patch });
const current = () => service.canvases.canvas(topicId);
const saveLinks = (links: CanvasLink[]) => service.canvases.saveCanvas(topicId, { ...current(), links });
const dependency = (id: string, from: number, to: number) => ({ id, kind: "depends" as const, from: tasks[from]!.id, to: tasks[to]!.id });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-canvas-relations-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles);
  const workspace = store.addWorkspace({ name: "测试项目", path: root });
  topicId = service.topics.createTopic({ title: "连线校验" }).id;
  const lead = store.createTask({ title: "主控甲", workspaceId: workspace.id, topicId, lead: true });
  tasks = [lead, store.createTask({ title: "执行乙", workspaceId: workspace.id, topicId, managerTaskId: lead.id }), store.createTask({ title: "执行丙", workspaceId: workspace.id, topicId, managerTaskId: lead.id }), store.createTask({ title: "独立丁", workspaceId: workspace.id, topicId })];
  const session = { parentId: null, kind: "main" as const, runtime: "codex" as const, profileId: "test", workspaceId: workspace.id, title: "", status: "idle" as const, writer: "workbench" as const, runtimeRef: null };
  topicSessionId = store.createSession({ ...session, taskId: null, topicId }).id;
  leadSessionId = store.createSession({ ...session, taskId: lead.id, topicId: null }).id;
  service.canvases.saveCanvas(topicId, {
    ...emptyCanvas(topicId),
    nodes: tasks.map((task, i) => ({ id: ["a", "b", "c", "d"][i]!, kind: "task", taskId: task.id, groupId: null, pos: { x: i * 300, y: 40 } })),
  });
});

afterEach(async () => { await servers.close(); store.close(); removeTempDir(root); });

describe("canvas relationship validation at Host boundaries", () => {
  it("rejects ordinary duplicates across connection sides and preserves both document and version", () => {
    saveLinks([ordinary("first", "a", "b", { label: "已保存说明" })]);
    const before = current();
    expect(() => saveLinks([...before.links!, ordinary("second", "a", "b", { fromSide: "top", toSide: "bottom", label: "不同说明也不能新增重复" })])).toThrow(/重复|已存在|duplicate|already exists/);
    expect(current()).toEqual(before);
  });

  it("refuses ordinary self, reverse and long cycles with a concrete path", () => {
    for (const links of [[ordinary("self", "a", "a")], [ordinary("ab", "a", "b"), ordinary("ba", "b", "a")], [ordinary("ab", "a", "b"), ordinary("bc", "b", "c"), ordinary("ca", "c", "a")]]) {
      const before = current();
      expect(() => saveLinks(links)).toThrow();
      expect(current()).toEqual(before);
    }
    expect(() => saveLinks([ordinary("ab", "a", "b"), ordinary("bc", "b", "c"), ordinary("ca", "c", "a")])).toThrow(/a.*b.*c.*a|主控甲.*执行乙.*执行丙.*主控甲/);
  });

  it("checks endpoint reversal for both a duplicate and a cycle before writing", () => {
    saveLinks([ordinary("ab", "a", "b"), ordinary("ac", "a", "c"), ordinary("bc", "b", "c")]);
    const before = current();
    expect(() => saveLinks(before.links!.map((l) => l.id === "ac" ? { ...l, from: "c", to: "a" } : l))).toThrow(/循环|cycle/);
    expect(current()).toEqual(before);
    // A historical antiparallel pair must not become a duplicate by reversing one member.
    store.putCanvas({ ...before, links: [ordinary("ab", "a", "b"), ordinary("ba", "b", "a")] });
    const dirty = current();
    expect(() => saveLinks(dirty.links!.map((l) => l.id === "ba" ? { ...l, from: "a", to: "b" } : l))).toThrow(/重复|已存在|duplicate|already exists/);
    expect(current()).toEqual(dirty);
  });

  it("keeps ordinary, collaboration and dependency graphs separate and accepts dependency joins", () => {
    const links = [ordinary("ab", "a", "b"), ordinary("bc", "b", "c"), ordinary("collab-ca", "c", "a", { kind: "collaboration" }), ordinary("collab-ab", "a", "b", { kind: "collaboration" }), ordinary("collab-bc", "b", "c", { kind: "collaboration" })];
    const edges = [dependency("db-a", 1, 0), dependency("db-c", 1, 2), dependency("da-d", 0, 3), dependency("dc-d", 2, 3)];
    const next = service.canvases.saveCanvas(topicId, { ...current(), links, edges });
    expect(next.links).toEqual(links);
    expect(next.edges).toEqual(edges);
    const before = current();
    expect(() => saveLinks([...links, ordinary("collab-ba", "b", "a", { kind: "collaboration", fromSide: "top" })])).toThrow(/重复|已存在|duplicate|already exists/);
    expect(current()).toEqual(before);
  });

  it("direct PUT route rejects the entire invalid document, including unrelated node movement", () => {
    const before = current();
    const put = canvasRoutes(service).find((r) => r.method === "PUT" && r.path === "/api/topics/:id/canvas")!;
    const body: CanvasDoc = { ...before, nodes: before.nodes.map((n) => ({ ...n, pos: { x: 123, y: 456 } })), links: [ordinary("ab", "a", "b"), ordinary("duplicate", "a", "b", { fromSide: "top" })] };
    expect(() => put.handle({ method: "PUT", path: `/api/topics/${topicId}/canvas`, params: { id: topicId }, query: new URLSearchParams(), body })).toThrow();
    expect(current()).toEqual(before);
  });

  it("returns bad_request rather than TypeError for malformed cards combined with duplicate links", () => {
    const before = current();
    const put = canvasRoutes(service).find((r) => r.method === "PUT" && r.path === "/api/topics/:id/canvas")!;
    for (const malformed of [{ kind: "note", text: null }, { kind: "note", text: { unexpected: true } }, { kind: "unknown-kind", text: 123 }]) {
      const body = { ...before, nodes: [...before.nodes.map((n) => ({ ...n, pos: { x: 123, y: 456 } })), { id: "malformed", groupId: null, pos: { x: 900, y: 900 }, ...malformed }], links: [ordinary("first", "malformed", "b"), ordinary("duplicate", "malformed", "b", { fromSide: "top" })] };
      let error: unknown;
      try { put.handle({ method: "PUT", path: `/api/topics/${topicId}/canvas`, params: { id: topicId }, query: new URLSearchParams(), body }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(HostError);
      expect(error).toHaveProperty("code", "bad_request");
      expect(error).toHaveProperty("message", expect.stringMatching(/has no text|unknown kind/));
      expect(current()).toEqual(before);
    }
  });

  it("MCP rejects dependency self, reverse, long cycles and duplicate without partial writes", async () => {
    const depend = canvasTools(toolContext(service, { sessionId: topicSessionId })).find((t) => t.name === "canvas_depend")!;
    for (const [from, to] of [[0, 1], [1, 2]]) expect(await depend.run({ fromTaskId: tasks[from!]!.id, toTaskId: tasks[to!]!.id })).not.toHaveProperty("isError", true);
    const before = current();
    for (const [from, to] of [[0, 0], [1, 0], [2, 0], [0, 1]]) {
      expect(await depend.run({ fromTaskId: tasks[from!]!.id, toTaskId: tasks[to!]!.id })).toHaveProperty("isError", true);
      expect(current()).toEqual(before);
    }
    expect(await depend.run({ fromTaskId: tasks[0]!.id, toTaskId: tasks[3]!.id })).not.toHaveProperty("isError", true);
    expect(await depend.run({ fromTaskId: tasks[2]!.id, toTaskId: tasks[3]!.id })).not.toHaveProperty("isError", true);
  });

  it("reads historical duplicates and cycles, saves movement and labels, and repairs one line at a time", () => {
    const dirty = { ...current(), links: [ordinary("ab", "a", "b", { label: "第一份说明" }), ordinary("ab-copy", "a", "b", { label: "必须保留的不同说明", fromSide: "top" }), ordinary("bc", "b", "c"), ordinary("ca", "c", "a")] };
    store.putCanvas(dirty);
    expect(current()).toEqual(dirty);
    service.canvases.canvasMove(topicId, { target: "d", x: 99, y: 88 });
    expect(current().links).toEqual(dirty.links);
    saveLinks(current().links!.map((l) => l.id === "ab-copy" ? { ...l, label: "人工整理的说明", fromSide: "bottom" } : l));
    expect(current().links).toHaveLength(4);
    saveLinks(current().links!.filter((l) => l.id !== "ca"));
    expect(current().links).toHaveLength(3);
    expect(current().links!.find((l) => l.id === "ab-copy")?.label).toBe("人工整理的说明");
    saveLinks(current().links!.filter((l) => l.id !== "ab"));
    expect(current().links).toEqual([expect.objectContaining({ id: "ab-copy", label: "人工整理的说明" }), expect.objectContaining({ id: "bc" })]);
  });

  it("grandfathers existing defects only, rejecting new defects and endpoint edits even with reused ids", () => {
    store.putCanvas({ ...current(), links: [ordinary("ab", "a", "b"), ordinary("ab-copy", "a", "b"), ordinary("bc", "b", "c"), ordinary("ca", "c", "a")] });
    const before = current();
    expect(() => saveLinks([...before.links!, ordinary("cd", "c", "d"), ordinary("dc", "d", "c")])).toThrow(/循环|cycle/);
    expect(current()).toEqual(before);
    expect(() => saveLinks(before.links!.map((l) => l.id === "ab-copy" ? { ...l, from: "b", to: "a" } : l))).toThrow(/循环|cycle/);
    expect(current()).toEqual(before);
    // Unrelated legal additions remain possible while the old defect is being repaired.
    saveLinks([...before.links!, ordinary("cd", "c", "d")]);
    expect(current().links).toHaveLength(5);
  });

  it("allows a legacy dependency cycle to be moved and repaired but refuses a new dependency cycle", () => {
    store.putCanvas({ ...current(), edges: [dependency("ab", 0, 1), dependency("bc", 1, 2), dependency("ca", 2, 0)] });
    service.canvases.canvasMove(topicId, { target: "a", x: 12, y: 34 });
    const before = current();
    expect(() => service.canvases.saveCanvas(topicId, { ...before, edges: [...before.edges, dependency("cd", 2, 3), dependency("dc", 3, 2)] })).toThrow(/循环|cycle/);
    expect(current()).toEqual(before);
    service.canvases.saveCanvas(topicId, { ...before, edges: before.edges.filter((e) => e.id !== "ca") });
    expect(current().edges).toHaveLength(2);
  });

  it.each(["ordinary", "collaboration", "dependency"] as const)("lets a legacy %s self-connection be explicitly removed without blocking movement", (kind) => {
    const before = current();
    const self = ordinary("self", "a", "a", { label: "旧自连说明", ...(kind === "collaboration" ? { kind: "collaboration" as const } : {}) });
    const dirty = kind === "dependency" ? { ...before, edges: [dependency("self", 0, 0)] } : { ...before, links: [self] };
    expect(() => service.canvases.saveCanvas(topicId, dirty)).toThrow();
    expect(current()).toEqual(before);
    store.putCanvas(dirty);
    service.canvases.canvasMove(topicId, { target: "b", x: 22, y: 33 });
    expect(kind === "dependency" ? current().edges : current().links).toEqual(kind === "dependency" ? dirty.edges : dirty.links);
    const repaired = service.canvases.saveCanvas(topicId, { ...current(), edges: [], links: [] });
    expect(repaired.edges).toEqual([]);
    expect(repaired.links).toEqual([]);
    expect(repaired.nodes.find((n) => n.id === "b")?.pos).toEqual({ x: 22, y: 33 });
  });

  it("preserves version conflicts and management boundaries while repairing old lines", () => {
    store.putCanvas({ ...current(), links: [ordinary("bd", "b", "d"), ordinary("duplicate", "b", "d")] });
    const before = current();
    expect(() => service.canvases.saveCanvas(topicId, { ...before, version: before.version - 1, links: [] })).toThrow(/version|changed elsewhere/);
    expect(() => service.canvases.saveCanvas(topicId, { ...before, links: [before.links![0]!] }, leadSessionId)).toThrow(/管理范围/);
    expect(current()).toEqual(before);
    service.canvases.saveCanvas(topicId, { ...before, links: [before.links![0]!] }, topicSessionId);
    expect(current().links).toHaveLength(1);
  });
});
