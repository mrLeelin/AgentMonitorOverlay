import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, workspaceId: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-notifications-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  service = host();
  workspaceId = store.addWorkspace({ name: "隔离验证", path: folder }).id;
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });
function host() { return new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") }); }
const task = (title: string, lead = false, managerTaskId: string | null = null) => store.createTask({ title, lead, managerTaskId, workspaceId });
const session = (owner: Task) => store.createSession({ taskId: owner.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "test", workspaceId, title: owner.title, status: "running", writer: "workbench", runtimeRef: null });
function publish(lead: string, root: string) {
  const input = { rootTaskId: root, title: "共同需求", body: "v1正文", changeNote: "初版", sources: [{ kind: "user_requirement" as const, source: "隔离测试" }] };
  const draft = service.sharedContext.save(lead, { ...input, baseRevision: 0 });
  const first = service.sharedContext.publishVersion(lead, draft.id, draft.revision);
  const next = service.sharedContext.save(lead, { ...input, body: "v2正文", baseRevision: first.revision });
  service.sharedContext.publishVersion(lead, next.id, next.revision);
  return first.id;
}

describe("durable management notification lifecycle", () => {
  it("terminates a frozen v1 notice at explicit upgrade and reissues valid business with v2", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const contextId = publish(manager.id, root.id);
    service.sharedContext.apply(manager.id, { contextId, version: 1, taskIds: [root.id] });
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "提交业务", "隔离证据");
    const id = `i-${result.id}-submit`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    const frozen = store.getItem(id);
    service.sharedContext.apply(manager.id, { contextId, version: 2, taskIds: [root.id] });
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "expired"));
    expect(store.getItem(id)).toHaveProperty("text", frozen?.type === "user" ? frozen.text : "");
    expect(store.getItem(id)).toHaveProperty("deliveryReason", expect.any(String));
    const replacement = store.listItems(manager.id).find((i) => i.type === "user" && "replacesItemId" in i && i.replacesItemId === id);
    expect(replacement).toMatchObject({ type: "user", delivery: "held", text: expect.stringContaining("v2正文") });
    expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
  });

  it("never resurrects a superseded turn report when accepted work returns or Host reconstructs", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const turn = store.appendItem({ id: "i-finished-turn", sessionId: worker.id, createdAt: "2020-01-01T00:00:00Z", type: "turn", turnId: "turn", state: "completed", startedAt: "2020-01-01T00:00:00Z", endedAt: "2020-01-01T00:00:01Z" });
    service.publish({ type: "session.upserted", session: store.updateSession(worker.id, { status: "idle" })! });
    const id = `i-${turn.id}-manager`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    const result = service.orchestration.submit(worker.id, "业务完成", "实际证据");
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "expired"));
    service.orchestration.review(manager.id, result.id, true, "通过");
    service.tasks.updateTask(child.id, { column: "doing" });
    expect(store.getItem(id)).toHaveProperty("delivery", "expired");
    expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
    const rebuilt = host();
    await Promise.resolve();
    expect(store.getItem(id)).toHaveProperty("delivery", "expired");
    expect(rebuilt.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
  });

  it("keeps an actual transport error and retry, while a paused session stays paused after upgrade", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const contextId = publish(manager.id, root.id);
    service.sharedContext.apply(manager.id, { contextId, version: 1, taskIds: [root.id] });
    service.sessions.inbox.pause(manager.id);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "业务完成", "实际证据");
    await vi.waitFor(() => expect(store.getItem(`i-${result.id}-submit`)).toHaveProperty("delivery", "held"));
    const send = vi.spyOn(service.runtime, "resend").mockRejectedValue(new Error("isolated runtime offline"));
    service.sharedContext.apply(manager.id, { contextId, version: 2, taskIds: [root.id] });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    store.updateSession(manager.id, { status: "idle" });
    service.sessions.inbox.resume(manager.id);
    await vi.waitFor(() => expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([expect.objectContaining({ detail: expect.stringContaining("isolated runtime offline") })]));
    const failed = service.orchestration.workflow(root.id).deliveryIssues[0]!;
    send.mockImplementation(async (_sessionId, itemId) => {
      const item = store.getItem(itemId)!;
      if (item.type === "user") service.publish({ type: "item.updated", item: store.replaceItem({ ...item, delivery: undefined, deliveryReason: undefined }) });
      return { mode: "start" };
    });
    await service.orchestration.retry(root.id, failed.id);
    expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
  });

  it.each(["relay", "notification"] as const)("reissues same-tree %s once, preserves frozen text and rejects terminal manual resend", async (kind) => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const contextId = publish(manager.id, root.id);
    service.sharedContext.apply(manager.id, { contextId, version: 1, taskIds: [child.id] });
    await service.sessions.inbox.put(worker.id, "仍有效的管理业务", kind === "relay" ? manager.id : undefined, "i-relay-upgrade", kind === "relay" ? { purpose: "work" } : { purpose: "notification", rebaseOnContextUpgrade: true });
    const original = store.getItem("i-relay-upgrade");
    service.sharedContext.apply(manager.id, { contextId, version: 2, taskIds: [child.id] });
    expect(store.getItem("i-relay-upgrade")).toMatchObject({ delivery: "expired", text: original?.type === "user" ? original.text : "" });
    const replacements = () => store.listItems(worker.id).filter((i) => i.type === "user" && i.replacesItemId === "i-relay-upgrade");
    expect(replacements()).toHaveLength(1);
    expect(replacements()[0]).toMatchObject({ delivery: "held", text: expect.stringContaining("v2正文") });
    const native = vi.spyOn(service.runtime, "resend");
    await expect(service.sessions.resend(worker.id, "i-relay-upgrade")).rejects.toThrow(/升级|失效|过期/);
    expect(native).not.toHaveBeenCalled();
    const rebuilt = host();
    await Promise.resolve();
    expect(replacements()).toHaveLength(1);
    expect(rebuilt.sharedContext.get(child.id).binding?.version).toBe(2);
  });

  it("cannot replay a cross-tree relay after transfer back and an explicit new binding", async () => {
    const root = task("原主控", true), other = task("另一棵树", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const contextId = publish(manager.id, root.id);
    service.sharedContext.apply(manager.id, { contextId, version: 1, taskIds: [child.id] });
    await service.sessions.inbox.put(worker.id, "不能跨树重放", manager.id, "i-relay-cross-tree");
    service.tasks.updateTask(child.id, { managerTaskId: other.id });
    expect(store.getItem("i-relay-cross-tree")).toHaveProperty("delivery", "expired");
    service.tasks.updateTask(child.id, { managerTaskId: root.id });
    service.sharedContext.apply(manager.id, { contextId, version: 2, taskIds: [child.id] });
    host();
    await Promise.resolve();
    expect(store.listItems(worker.id).filter((i) => i.type === "user" && i.replacesItemId === "i-relay-cross-tree")).toHaveLength(0);
    await expect(service.sessions.resend(worker.id, "i-relay-cross-tree")).rejects.toThrow(/永久撤回|管理范围/);
  });

  it("migrates the old invalidated-unsent representation through the service without deleting history", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "历史业务", "历史证据"), id = `i-${result.id}-submit`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    // Fixture representing the previous Host's persisted invalidation format, in an isolated database only.
    const row = store.getItem(id)!;
    if (row.type === "user") store.replaceItem({ ...row, delivery: "unsent", text: "【管理通知已失效】任务归属或问题状态已变化，请以 task_workflow 最新内容为准。" });
    const rebuilt = host();
    expect(store.getItem(id)).toMatchObject({ delivery: "expired", deliveryReason: expect.stringContaining("旧管理通知") });
    expect(rebuilt.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
    expect(rebuilt.orchestration.workflow(root.id).deliveryNotices).toContainEqual(expect.objectContaining({ id, state: "expired" }));
    expect(store.getItem(id)).toBeTruthy();
    expect(store.getSession(manager.id)).toBeTruthy();
  });

  it("keeps an archived-session replacement live and retryable after a real dispatch failure", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "交付", "验证");
    const oldId = `i-${result.id}-submit`;
    await vi.waitFor(() => expect(store.getItem(oldId)).toHaveProperty("delivery", "held"));
    store.updateSession(manager.id, { writer: "archived" });
    const current = session(root);
    service.publish({ type: "session.upserted", session: current });
    const newId = `${oldId}-${current.id}`;
    await vi.waitFor(() => expect(store.getItem(newId)).toHaveProperty("delivery", "held"));
    expect(service.orchestration.workflow(root.id).deliveryNotices).toContainEqual(expect.objectContaining({ id: newId, state: "waiting" }));
    vi.spyOn(service.runtime, "resend").mockRejectedValue(new Error("replacement runtime offline"));
    store.updateSession(current.id, { status: "idle" });
    await service.sessions.inbox.flush(current.id);
    expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([expect.objectContaining({ id: newId, detail: "replacement runtime offline" })]);
  });

  it("migrates orphaned legacy transfer rows even after the producer moved its active pointer", async () => {
    const root = task("主控", true), manager = session(root);
    const orphan = store.appendItem({ id: "i-orphaned-transfer", type: "user", text: "【管理通知已转交新会话】旧会话已归档，以任务当前主会话中的通知为准。", delivery: "unsent", sessionId: manager.id, createdAt: new Date().toISOString(), raw: { runtime: "codex", method: "user/inbox" } });
    const rebuilt = host();
    expect(store.getItem(orphan.id)).toMatchObject({ delivery: "expired", deliveryReason: expect.stringContaining("转交") });
    await expect(rebuilt.sessions.resend(manager.id, orphan.id)).rejects.toThrow(/禁止重新发送/);
  });

  it("reconciles an upgrade that arrives while the producer is awaiting inbox dispatch", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    const contextId = publish(manager.id, root.id);
    service.sharedContext.apply(manager.id, { contextId, version: 1, taskIds: [root.id] });
    service.sharedContext.getForSession(manager.id);
    for (const row of service.sessions.inbox.held(manager.id)) service.sessions.inbox.expire(row.id, "完整正文已通过正式读取提供，本回归只保留业务队列。");
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => { enter = r; }), barrier = new Promise<void>((r) => { release = r; });
    vi.spyOn(service.runtime, "resend").mockImplementation(async () => { enter(); await barrier; throw new Error("old dispatch cancelled"); });
    store.updateSession(manager.id, { status: "idle" }); store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "等待恢复的有效业务", "隔离证据"), oldId = `i-${result.id}-submit`;
    await entered;
    service.sessions.inbox.pause(manager.id);
    service.sharedContext.apply(manager.id, { contextId, version: 2, taskIds: [root.id] });
    release();
    await vi.waitFor(() => expect(store.listItems(manager.id).some((row) => row.type === "user" && row.replacesItemId === oldId && row.delivery === "held")).toBe(true));
    expect(store.getItem(oldId)).toHaveProperty("delivery", "expired");
    expect(service.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
  });

  it.each([false, true])("terminates unverifiable legacy root text and regenerates current business only once (transferred=%s)", async (transferred) => {
    const root = task("主控", true), other = task("新管理根", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "当前有效交付", "当前验证证据"), id = `i-${result.id}-submit`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    // An old Host had neither a root snapshot nor a shared-context token. Never invent its historical root.
    const notices = JSON.parse(store.getKv("orchestration.outbox")!.value) as Array<Record<string, unknown>>;
    store.setKv("orchestration.outbox", JSON.stringify(notices.map(({ rootTaskId: _oldRoot, ...notice }) => notice)));
    const row = store.getItem(id)!;
    if (row.type === "user") store.replaceItem({ ...row, text: "OLD_RAW_TEXT_MUST_NOT_REPLAY", messagePurpose: undefined });
    if (transferred) service.tasks.updateTask(root.id, { managerTaskId: other.id });
    const rebuilt = host(), newId = `${id}-reconciled-${transferred ? other.id : root.id}`;
    await vi.waitFor(() => expect(store.getItem(newId)).toMatchObject({ delivery: "held", messagePurpose: "notification", text: expect.stringContaining("当前有效交付") }));
    expect(store.getItem(id)).toMatchObject({ delivery: "expired", text: "OLD_RAW_TEXT_MUST_NOT_REPLAY", deliveryReason: expect.stringContaining("缺少可核验依据") });
    expect(store.getItem(newId)).not.toMatchObject({ text: expect.stringContaining("OLD_RAW_TEXT_MUST_NOT_REPLAY") });
    host();
    await Promise.resolve();
    expect(store.listItems(manager.id).filter((item) => item.id === newId)).toHaveLength(1);
    expect(rebuilt.orchestration.workflow(root.id).deliveryIssues).toEqual([]);
  });

  it("preserves consumed delivery history when the business is accepted, reopened and recovered", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "已送入的交付", "已送入的证据"), id = `i-${result.id}-submit`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    vi.spyOn(service.runtime, "resend").mockImplementation(async (_sessionId, itemId) => {
      const row = store.getItem(itemId)!;
      if (row.type === "user") service.publish({ type: "item.updated", item: store.replaceItem({ ...row, delivery: undefined }) });
      return { mode: "start" };
    });
    store.updateSession(manager.id, { status: "idle" });
    await service.sessions.inbox.flush(manager.id);
    const transported = store.getItem(id);
    expect(transported?.type === "user" && transported.delivery === undefined).toBe(true);
    service.orchestration.review(manager.id, result.id, true, "通过");
    service.tasks.updateTask(child.id, { column: "doing" });
    const rebuilt = host();
    expect(store.getItem(id)).toEqual(transported);
    expect(rebuilt.orchestration.workflow(root.id).deliveryNotices).toContainEqual(expect.objectContaining({ id, state: "delivered" }));
  });

  it("does not regenerate a permanently revoked legacy return when the same result is returned again without a root snapshot", async () => {
    const root = task("主控", true), child = task("执行", false, root.id), manager = session(root), worker = session(child);
    store.updateSession(worker.id, { status: "idle" });
    const result = service.orchestration.submit(worker.id, "历史交付", "历史证据");
    store.updateSession(worker.id, { status: "running" });
    service.orchestration.review(manager.id, result.id, false, "当前是同一结果的退回状态");
    const id = `i-${result.id}-return`;
    await vi.waitFor(() => expect(store.getItem(id)).toHaveProperty("delivery", "held"));
    // Combined old-Host fixture: no root/terminal metadata, an already revoked row, and returned business again.
    const notices = JSON.parse(store.getKv("orchestration.outbox")!.value) as Array<Record<string, unknown>>;
    store.setKv("orchestration.outbox", JSON.stringify(notices.map(({ rootTaskId: _root, expiredAt: _expired, expiredReason: _reason, retiredAt: _retired, ...notice }) => notice)));
    const row = store.getItem(id)!;
    if (row.type === "user") store.replaceItem({ ...row, delivery: "unsent", text: "【管理通知已失效】任务归属或问题状态已变化，请以 task_workflow 最新内容为准。" });
    host();
    await Promise.resolve();
    expect(store.getItem(id)).toHaveProperty("delivery", "expired");
    expect(store.listItems(worker.id).filter((item) => item.type === "user" && item.replacesItemId === id)).toHaveLength(0);
  });
});
