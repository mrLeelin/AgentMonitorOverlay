import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionGoalState, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";
import { currentMessagePurpose } from "../../runtime/message-purpose.js";

const PROFILES: ModelProfile[] = [{ id: "goal-test", label: "Goal test", runtime: "codex", provider: null, model: null }];
const TOKEN = "goal-test-host-token";
let root: string;
let store: Store;
let servers: FakeServers;
let http: HostServer;
let service: HostService;
let session: Session;
let path: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-goals-route-"));
  mkdirSync(join(root, "ws"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES);
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
  const workspace = (await api<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") })).data;
  session = (await api<{ session: Session }>("POST", "/api/tasks", { title: "Goal", workspaceId: workspace.id, firstSession: { profileId: PROFILES[0]!.id, text: "prepare goal" } })).data.session;
  path = `/api/sessions/${session.id}/goal`;
  await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
});

afterEach(async () => {
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${http.url}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as T };
}

describe("native Goal HTTP controls", () => {
  it("reads, starts, pauses, resumes and clears the native goal", async () => {
    expect(await api("GET", path)).toEqual({ status: 200, data: { goal: null } });
    const created = await api<SessionGoalState>("PUT", path, { objective: "Finish the requested work", status: "active", tokenBudget: 10000 });
    expect(created.status).toBe(200);
    expect(created.data.goal).toMatchObject({ objective: "Finish the requested work", status: "active", tokenBudget: 10000 });
    expect((await api<SessionGoalState>("PUT", path, { status: "paused" })).data.goal?.status).toBe("paused");
    expect((await api<SessionGoalState>("PUT", path, { status: "active" })).data.goal?.status).toBe("active");
    expect(await api("DELETE", path)).toEqual({ status: 200, data: { goal: null } });
    expect((await api<SessionGoalState>("GET", path)).data.goal).toBeNull();
  });

  it.each([
    {}, [], null, { objective: "" }, { objective: "  " }, { objective: 123 }, { objective: "目".repeat(4001) },
    { tokenBudget: 0 }, { tokenBudget: -1 }, { tokenBudget: 1.5 }, { tokenBudget: Number.MAX_SAFE_INTEGER + 1 }, { tokenBudget: "1000" }, { tokenBudget: null },
    { roundBudget: 0 }, { roundBudget: -1 }, { roundBudget: 1.5 }, { roundBudget: Number.MAX_SAFE_INTEGER + 1 }, { roundBudget: "100" }, { roundBudget: null },
    { status: "complete" }, { status: "blocked" }, { status: "unknown" }, { status: null },
    { objective: "work", origin: "user" }, { objective: "work", extra: true },
  ])("rejects malformed or unowned fields before native mutation: %j", async (body) => {
    const before = servers.fakes.get(session.profileId)!.calls.length;
    expect((await api("PUT", path, body)).status).toBe(400);
    expect(servers.fakes.get(session.profileId)!.calls.slice(before).some((call) => call.method === "thread/goal/set")).toBe(false);
  });

  it("counts the native objective limit in Unicode characters rather than UTF-16 units", async () => {
    const objective = "🎯".repeat(4000);
    const result = await api<SessionGoalState>("PUT", path, { objective, status: "active" });
    expect(result.status).toBe(200);
    expect(result.data.goal?.objective).toBe(objective);
    expect((await api("PUT", path, { objective: `${objective}🎯`, status: "active" })).status).toBe(400);
  });

  it.each(["terminal-handoff", "archived"] as const)("refuses writes to %s sessions", async (writer) => {
    store.updateSession(session.id, { writer });
    expect((await api("PUT", path, { objective: "Should not start", status: "active" })).status).toBe(409);
    expect((await api("DELETE", path)).status).toBe(409);
  });

  it("refuses archived session mutations even if the writer field is stale", async () => {
    store.archiveSubtree(session.id);
    expect((await api("PUT", path, { objective: "Archived", status: "active" })).status).toBe(409);
    expect((await api("DELETE", path)).status).toBe(409);
  });

  it("returns an explicit unsupported result when this Host has no adapter for the session runtime", async () => {
    const other = store.createSession({ taskId: session.taskId, topicId: null, parentId: null, kind: "main", runtime: "claude", profileId: "claude-test", workspaceId: session.workspaceId, title: "Other runtime", status: "idle", writer: "workbench", runtimeRef: "other-thread" });
    const route = `/api/sessions/${other.id}/goal`;
    const read = await api<SessionGoalState>("GET", route);
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ goal: null, unavailable: expect.any(String) });
    expect((await api("PUT", route, { objective: "Unsupported", status: "active" })).status).toBe(400);
    expect((await api("DELETE", route)).status).toBe(400);
  });

  it("does not silently ignore a DSH round budget on Codex", async () => {
    expect((await api("PUT", path, { objective: "Do work", roundBudget: 20, status: "active" })).status).toBe(400);
    expect((await api<SessionGoalState>("GET", path)).data.goal).toBeNull();
  });

  it.each([
    { purpose: "inquiry", finish: "paused" },
    { purpose: "notification", finish: "complete" },
  ] as const)("keeps inbox $purpose held until the Goal is $finish without marking it unsent", async ({ purpose, finish }) => {
    await api("PUT", path, { objective: "Finish before reading the follow-up", status: "active" });
    const id = `i-goal-held-${purpose}`;
    const deliveries: Array<string | undefined> = [];
    service.on("event", (event) => {
      if ((event.type === "item.appended" || event.type === "item.updated") && event.item.id === id && event.item.type === "user") deliveries.push(event.item.delivery);
    });
    expect(await service.sessions.inbox.put(session.id, `Follow-up ${purpose}`, undefined, id, { purpose })).toEqual({ delivered: false, waiting: 1 });
    await service.sessions.inbox.flush(session.id);
    expect(store.getItem(id)).toMatchObject({ type: "user", delivery: "held", messagePurpose: purpose });
    expect(currentMessagePurpose(store, session.id)).toBe("work");
    expect(deliveries).not.toContain("unsent");

    if (finish === "paused") await api("PUT", path, { status: "paused" });
    else {
      const { client } = await servers.ensure(session.profileId);
      await client.request("thread/goal/set", { threadId: session.runtimeRef!, origin: "automatic", status: "complete" });
    }
    // The native Goal update itself releases the held item; no human retry is necessary.
    await vi.waitFor(() => {
      const item = store.getItem(id);
      expect(item?.type).toBe("user");
      if (item?.type === "user") expect(item.delivery).toBeUndefined();
    });
    await vi.waitFor(() => expect(store.getSession(session.id)?.status).toBe("idle"));
    expect(currentMessagePurpose(store, session.id)).toBe(purpose);
    expect(store.getSession(session.id)?.goal?.status).toBe(finish);
    expect(deliveries).not.toContain("unsent");
  });
});
