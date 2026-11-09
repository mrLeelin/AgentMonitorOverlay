import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { roleCard } from "../features/guide/role.js";
import { amoToolsFor } from "./tools.js";

const PROFILES: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let taskId: string;
let sessionId: string;
let topicSessionId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-lead-permissions-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  const workspace = store.addWorkspace({ name: "测试", path: root });
  const topic = service.topics.createTopic({ title: "测试专题" });
  taskId = store.createTask({ title: "分配工作", workspaceId: workspace.id, topicId: topic.id }).id;
  const base = { parentId: null, kind: "main" as const, runtime: "codex" as const, profileId: "test", workspaceId: workspace.id, title: "", status: "idle" as const, writer: "workbench" as const, runtimeRef: null };
  sessionId = store.createSession({ ...base, taskId, topicId: null }).id;
  topicSessionId = store.createSession({ ...base, taskId: null, topicId: topic.id }).id;
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("主控文件只读、分配工作与管理任务画布", () => {
  it("exposes management tools without approval while keeping execution and settings tools hidden", async () => {
    store.updateTask(taskId, { lead: true });
    const tools = amoToolsFor(service, { sessionId });
    expect(tools.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual([
      "canvas_arrange", "canvas_callout", "canvas_callout_close", "canvas_color", "canvas_depend", "canvas_group_create", "canvas_item_update", "canvas_items_post", "canvas_move", "canvas_place",
      "checklist_check", "decision_request", "handoff_submit", "mailbox_read", "mailbox_send", "task_decision_answer", "task_describe", "task_manager_set", "task_message", "task_note_add", "task_plan_propose", "task_review_result", "task_set_lead", "task_submit_result", "task_update", "topic_doc_write",
    ]);
    expect(tools.every((t) => t.autoApprove)).toBe(true);
    expect(tools.some((t) => t.name === "topic_docs")).toBe(true);
    expect(tools.some((t) => t.name === "project_context")).toBe(true);
    expect(await tools.find((t) => t.name === "task_describe")!.run({ description: "让执行任务修复导入" })).not.toHaveProperty("isError", true);
    expect(store.getTask(taskId)?.description).toBe("让执行任务修复导入");
    expect(await tools.find((t) => t.name === "mailbox_read")!.run({})).not.toHaveProperty("isError", true);
    expect(roleCard(service, sessionId)).toContain("本地文件只读");
    expect(roleCard(service, sessionId)).toContain("task_review_result");
  });

  it("refuses cached write tools immediately after the task becomes a lead", async () => {
    const cached = amoToolsFor(service, { sessionId });
    store.updateTask(taskId, { lead: true });
    for (const name of ["session_start", "session_send", "session_archive", "prompt_template_save", "duty_save", "issue_reply", "mcp_server_save"]) {
      const result = await cached.find((t) => t.name === name)!.run({});
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain("本地文件只读");
    }
    expect(service.collab.taskNotes(taskId)).toEqual([]);
  });

  it("also restricts forks and subagents in a lead task", () => {
    store.updateTask(taskId, { lead: true });
    const main = store.getSession(sessionId)!;
    for (const kind of ["fork", "sub"] as const) {
      const session = store.createSession({ ...main, id: undefined, kind, parentId: sessionId });
      const tools = amoToolsFor(service, { sessionId: session.id });
      expect(tools.some((t) => t.name === "session_start")).toBe(false);
      expect(tools.find((t) => t.name === "canvas_move")?.autoApprove).toBe(true);
      expect(roleCard(service, session.id)).toContain("本地文件只读");
    }
  });

  it("manages task metadata and Studio documents within its topic without changing role or permissions", async () => {
    store.updateTask(taskId, { lead: true });
    const lead = store.getTask(taskId)!;
    const worker = store.createTask({ title: "实现", workspaceId: lead.workspaceId, topicId: lead.topicId, managerTaskId: lead.id });
    const otherTopic = service.topics.createTopic({ title: "其他专题" });
    const outside = store.createTask({ title: "外部", workspaceId: lead.workspaceId, topicId: otherTopic.id });
    const tools = amoToolsFor(service, { sessionId });
    const update = tools.find((t) => t.name === "task_update")!;
    expect(await update.run({ taskId: worker.id, title: "修复导入", column: "review", lead: true })).not.toHaveProperty("isError", true);
    expect(store.getTask(worker.id)).toMatchObject({ title: "修复导入", column: "review" });
    expect(store.getTask(worker.id)?.lead).not.toBe(true);
    expect(await update.run({ taskId: outside.id, column: "done" })).toHaveProperty("isError", true);
    expect(await update.run({ title: " " })).toHaveProperty("isError", true);
    expect(await update.run({})).toHaveProperty("isError", true);
    const doc = service.topicDocs.create(otherTopic.id, { title: "外部文档", body: "原文" });
    const writeDoc = tools.find((t) => t.name === "topic_doc_write")!;
    expect(await writeDoc.run({ title: "协调计划", body: "先验证再实现" })).not.toHaveProperty("isError", true);
    expect(await writeDoc.run({ docId: doc.id, body: "越界" })).toHaveProperty("isError", true);
    expect(service.topicDocs.get(doc.id).body).toBe("原文");
    expect(await update.run({ taskId: worker.id, topicId: otherTopic.id })).toHaveProperty("isError", true);
    expect(store.getTask(worker.id)?.topicId).toBe(lead.topicId);
    service.tasks.setManager(worker.id, null);
    expect(await update.run({ taskId: worker.id, column: "done" })).toHaveProperty("isError", true);
  });

  it("allows canvas mutations through cached handles but keeps worker management approval and scope", async () => {
    const cached = amoToolsFor(service, { sessionId });
    expect(cached.find((t) => t.name === "canvas_group_create")?.autoApprove).toBe(false);
    expect(cached.find((t) => t.name === "task_update")?.autoApprove).toBe(false);
    const task = store.getTask(taskId)!;
    const sibling = store.createTask({ title: "其他任务", workspaceId: task.workspaceId, topicId: task.topicId });
    expect(await cached.find((t) => t.name === "task_update")!.run({ taskId: sibling.id, column: "done" })).toHaveProperty("isError", true);
    store.updateTask(taskId, { lead: true });
    expect(await cached.find((t) => t.name === "canvas_group_create")!.run({ title: "本周计划" })).not.toHaveProperty("isError", true);
    expect(service.canvases.canvas(task.topicId!).groups[0]?.title).toBe("本周计划");
    expect(await cached.find((t) => t.name === "canvas_place")!.run({ taskId })).not.toHaveProperty("isError", true);
    expect(await cached.find((t) => t.name === "canvas_color")!.run({ target: taskId, color: "blue" })).not.toHaveProperty("isError", true);
    expect(service.canvases.canvas(task.topicId!).nodes[0]?.color).toBe("blue");
  });

  it("keeps execution and topic sessions unchanged and anonymous writes refused", async () => {
    const worker = amoToolsFor(service, { sessionId });
    expect(worker.some((t) => t.name === "session_start")).toBe(true);
    expect(await worker.find((t) => t.name === "task_note_add")!.run({ text: "执行进度" })).not.toHaveProperty("isError", true);
    const topic = amoToolsFor(service, { sessionId: topicSessionId });
    expect(await topic.find((t) => t.name === "topic_doc_write")!.run({ title: "方案", body: "内容" })).not.toHaveProperty("isError", true);
    const anonymous = amoToolsFor(service, null);
    expect(await anonymous.find((t) => t.name === "topic_doc_write")!.run({ title: "绕过", body: "内容" })).toHaveProperty("isError", true);
  });
});
