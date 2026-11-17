import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { startHostServer, type HostServer } from "../../http/server.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 2026-11-17, plans/done/task-dependencies.md: a task whose prerequisites are not finished is not started (nor reopened) by its
// manager's work, and the person starts it only once they confirmed it; one already started is not held up. Before, the
// canvas's dependency line held nothing: Free's 「Free UI 移植」 and the 下级 changed the same file at once.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [{ id: "p", label: "测试", runtime: "codex", provider: null, model: null }];
const TOKEN = "test-host-token";
let root: string, store: Store, servers: FakeServers, service: HostService, http: HostServer;
let lead: Task, prerequisite: Task, dependent: Task, leadSession: Session;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-dependency-gates-"));
  mkdirSync(join(root, "ws"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
  const ws = store.addWorkspace({ name: "ws", path: join(root, "ws") });
  const topic = service.topics.createTopic({ title: "Free" });
  lead = store.createTask({ title: "主控", workspaceId: ws.id, topicId: topic.id, lead: true });
  prerequisite = store.createTask({ title: "Free UI 移植", workspaceId: ws.id, topicId: topic.id, managerTaskId: lead.id });
  dependent = store.createTask({ title: "核对 Free 配置", workspaceId: ws.id, topicId: topic.id, managerTaskId: lead.id });
  service.canvases.canvasAddDependency(prerequisite.id, dependent.id);
  leadSession = store.createSession({ taskId: lead.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-lead" });
  vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });
  vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
});
afterEach(async () => { vi.restoreAllMocks(); await http.close(); await servers.close(); store.close(); removeTempDir(root); });

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

const sessions = (task: Task) => store.listSessions({ taskId: task.id });
const relay = (purpose: "work" | "reopen" | "inquiry") => service.relays.send(leadSession.id, { taskId: dependent.id, text: "开始核对", purpose });
const accepted = () => {
  const owner = store.createSession({ ...leadSession, id: undefined, taskId: prerequisite.id, runtimeRef: null });
  const result = service.orchestration.submit(owner.id, "移植完成", "隔离验证通过");
  service.orchestration.review(leadSession.id, result.id, true, "验收通过");
};

it("the manager's work neither starts nor reopens a task whose prerequisite is not finished, and says which", () => {
  expect(() => relay("work")).toThrow(/Free UI 移植/);
  expect(() => relay("reopen")).toThrow(/Free UI 移植/);
  expect(sessions(dependent)).toHaveLength(0);
});

it("an inquiry still goes, and does not count as starting it; reopening goes once the prerequisite's manager accepted it", async () => {
  expect(() => relay("inquiry")).not.toThrow();
  await vi.waitFor(() => expect(sessions(dependent)).toHaveLength(1));
  expect(() => relay("work")).toThrow(/Free UI 移植/);
  accepted();
  expect(() => relay("reopen")).not.toThrow();
});

it("a task already working is not held up by a line drawn later; only reopening it waits", async () => {
  const owner = store.createSession({ ...leadSession, id: undefined, taskId: dependent.id, runtimeRef: null });
  store.appendItem({ id: "turn-work", sessionId: owner.id, createdAt: new Date().toISOString(), type: "turn", turnId: "turn-work", state: "completed", startedAt: new Date().toISOString(), messagePurpose: "work" });
  expect(() => relay("work")).not.toThrow();
  expect(() => relay("reopen")).toThrow(/Free UI 移植/);
});

it("the person starts it by hand only once they confirmed it; the page can ask which prerequisites wait", async () => {
  const waiting = await api<Task[]>("GET", `/api/tasks/${dependent.id}/prerequisites`);
  expect(waiting.data.map((t) => t.title)).toEqual(["Free UI 移植"]);
  const refused = await api<{ error: { code: string; message: string } }>("POST", `/api/tasks/${dependent.id}/sessions`, { profileId: "p" });
  expect(refused.status).toBe(409);
  expect(refused.data.error.message).toContain("Free UI 移植");
  expect(sessions(dependent)).toHaveLength(0);
  const started = await api<Session>("POST", `/api/tasks/${dependent.id}/sessions`, { profileId: "p", confirmed: true });
  expect(started.status).toBe(200);
  expect(sessions(dependent)).toHaveLength(1);
  // Started now: another session needs no confirming.
  expect((await api<Session>("POST", `/api/tasks/${dependent.id}/sessions`, { profileId: "p" })).status).toBe(200);
});

it("nothing to confirm once the prerequisite is finished", async () => {
  expect((await api<Record<string, string[]>>("GET", "/api/prerequisites")).data).toEqual({ [dependent.id]: [prerequisite.id] });
  accepted();
  expect((await api<Task[]>("GET", `/api/tasks/${dependent.id}/prerequisites`)).data).toEqual([]);
  expect((await api<Record<string, string[]>>("GET", "/api/prerequisites")).data).toEqual({});
  expect((await api<Session>("POST", `/api/tasks/${dependent.id}/sessions`, { profileId: "p" })).status).toBe(200);
});
