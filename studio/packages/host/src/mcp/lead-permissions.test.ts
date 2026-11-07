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

describe("主控只读和分配任务", () => {
  it("exposes only reading and assignment tools, including mail reading", async () => {
    store.updateTask(taskId, { lead: true });
    const tools = amoToolsFor(service, { sessionId });
    expect(tools.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual([
      "decision_request", "mailbox_read", "mailbox_send", "task_describe", "task_message", "task_plan_propose",
    ]);
    expect(tools.some((t) => t.name === "topic_docs")).toBe(true);
    expect(tools.some((t) => t.name === "project_context")).toBe(true);
    expect(await tools.find((t) => t.name === "task_describe")!.run({ description: "让执行任务修复导入" })).not.toHaveProperty("isError", true);
    expect(store.getTask(taskId)?.description).toBe("让执行任务修复导入");
    expect(await tools.find((t) => t.name === "mailbox_read")!.run({})).not.toHaveProperty("isError", true);
    expect(roleCard(service, sessionId)).toContain("只有读取和分配任务的权限");
  });

  it("refuses cached write tools immediately after the task becomes a lead", async () => {
    const cached = amoToolsFor(service, { sessionId });
    store.updateTask(taskId, { lead: true });
    for (const name of ["topic_doc_write", "session_start", "canvas_color", "prompt_template_save", "duty_save", "issue_reply", "task_note_add"]) {
      const result = await cached.find((t) => t.name === name)!.run({});
      expect(result.isError, name).toBe(true);
      expect(result.content[0]?.text, name).toContain("主控只能读取和分配任务");
    }
    expect(service.collab.taskNotes(taskId)).toEqual([]);
  });

  it("also restricts forks and subagents in a lead task", () => {
    store.updateTask(taskId, { lead: true });
    const main = store.getSession(sessionId)!;
    for (const kind of ["fork", "sub"] as const) {
      const session = store.createSession({ ...main, id: undefined, kind, parentId: sessionId });
      expect(amoToolsFor(service, { sessionId: session.id }).some((t) => t.name === "topic_doc_write")).toBe(false);
      expect(roleCard(service, session.id)).toContain("只有读取和分配任务的权限");
    }
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
