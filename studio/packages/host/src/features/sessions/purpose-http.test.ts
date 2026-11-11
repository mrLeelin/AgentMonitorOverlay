import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { sessionsRoutes } from "./routes.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, worker: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-http-purpose-"));
  store = new Store(join(folder, "studio.db")); servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "隔离", path: folder });
  const root = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "已验收", workspaceId: workspace.id, managerTaskId: root.id });
  const manager = await service.tasks.addSession(root.id, { profileId: "test" });
  worker = await service.tasks.addSession(child.id, { profileId: "test" });
  const result = service.orchestration.submit(worker.id, "交付", "证据");
  service.orchestration.review(manager.id, result.id, true, "通过");
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });
const send = (body: unknown) => sessionsRoutes(service).find((r) => r.path === "/api/sessions/:id/messages")!.handle({ method: "POST", path: `/api/sessions/${worker.id}/messages`, params: { id: worker.id }, query: new URLSearchParams(), body });

it("passes public HTTP inquiry through to the actual read-only turn while preserving acceptance", async () => {
  await send({ text: "[[slow]] HTTP只读查询", purpose: "inquiry", now: true });
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect(store.findItems(worker.id, "turn", { state: "running" })[0]).toMatchObject({ messagePurpose: "inquiry" });
  const call = servers.fakes.get("test")!.calls.filter((c) => c.method === "turn/start" && JSON.stringify(c.params).includes("HTTP只读查询")).at(-1);
  expect(call?.params).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  await service.sessions.interrupt(worker.id);
});

it.each(["notification", "invalid", 42])("refuses public purpose %s instead of silently defaulting to work", (purpose) => {
  expect(() => send({ text: "查询", purpose })).toThrow(/purpose/);
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
});

it("keeps a new session's initial inquiry behind the same checked message path", async () => {
  const created = await service.tasks.addSession(worker.taskId!, { profileId: "test", text: "[[slow]] 新会话只读查询", purpose: "inquiry" });
  await vi.waitFor(() => expect(store.getSession(created.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect(store.findItems(created.id, "turn", { state: "running" })[0]).toMatchObject({ messagePurpose: "inquiry" });
  await service.sessions.interrupt(created.id);
});
