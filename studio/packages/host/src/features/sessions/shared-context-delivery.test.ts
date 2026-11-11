import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionRuntime, Task } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostService } from "../../service.js";
import { RuntimeRouter, type RuntimeEvents, type SessionRuntimeApi } from "../../runtime/runtime.js";
import { Store } from "../../store/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(name: Exclude<SessionRuntime, "remote"> = "codex") {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-test-context-delivery-"));
  const store = new Store(join(root, "studio.db"));
  cleanups.push(() => removeTempDir(root), () => store.close());
  const workspace = store.addWorkspace({ name: "test", path: root });
  const profiles: ModelProfile[] = [{ id: "mock", label: "mock", runtime: name, provider: null, model: "mock" }];
  let sequence = 0;
  const create = (owner: Task): Session => store.createSession({ taskId: owner.id, topicId: null, parentId: null, kind: "main", runtime: name, profileId: "mock", workspaceId: workspace.id, title: owner.title, status: "idle", writer: "workbench", runtimeRef: `mock-ref-${owner.id}-${++sequence}` });
  const started = (sessionId: string): { mode: "start" } => {
    // A successful native start emits lifecycle separately from transport provision, as each real adapter does.
    native.emit("event", store.appendEvent({ type: "session.upserted", session: store.updateSession(sessionId, { status: "running" })! }));
    native.emit("event", store.appendEvent({ type: "session.upserted", session: store.updateSession(sessionId, { status: "idle" })! }));
    return { mode: "start" };
  };
  const native = Object.assign(new EventEmitter<RuntimeEvents>(), {
    startSession: vi.fn(async (input: Parameters<SessionRuntimeApi["startSession"]>[0]) => create(store.getTask(input.taskId!)!)),
    sendMessage: vi.fn(async (sessionId: string) => started(sessionId)),
    resend: vi.fn(async (sessionId: string) => started(sessionId)),
    interrupt: vi.fn(async () => undefined),
  });
  const runtime = new RuntimeRouter(store, profiles, { [name]: native as unknown as SessionRuntimeApi });
  return { root, store, workspace, profiles, runtime, native, create };
}

describe("shared context transport", () => {
  it.each(["codex", "claude", "dsh"] as const)("uses full first/new-version input and lightweight later turns without forging provision for %s", async (name) => {
    const f = fixture(name);
    const lead = f.store.createTask({ title: "lead", workspaceId: f.workspace.id, lead: true });
    const child = f.store.createTask({ title: "child", workspaceId: f.workspace.id, managerTaskId: lead.id });
    const manager = f.create(lead);
    const service = new HostService(f.store, f.runtime, f.profiles, { commonDir: join(f.root, "common") });
    const body = "正文".repeat(50_000);
    const input = { rootTaskId: lead.id, baseRevision: 0, title: "共同需求", body, changeNote: "初版", sources: [{ kind: "user_requirement" as const, source: "用户" }] };
    const saved = service.sharedContext.save(manager.id, input);
    const first = service.sharedContext.publishVersion(manager.id, saved.id, saved.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 1, taskIds: [child.id] });
    vi.spyOn(f.runtime, "choices").mockResolvedValue({ profileId: "mock", models: [], permissions: [], defaultPermission: "", source: "builtin" });
    const worker = await service.tasks.addSession(child.id, { profileId: "mock", text: "开始" });
    const initial = f.native.startSession.mock.calls[0]![0].text!;
    expect(initial).toContain(body);
    expect(service.sharedContext.receipts(worker.id).some((r) => r.deliveredAt)).toBe(false);
    const oldQueue = f.store.appendItem({ id: "frozen-full-input", sessionId: worker.id, type: "user", text: initial, delivery: "held", createdAt: new Date().toISOString(), raw: { runtime: name, method: "test" } });
    f.native.emit("message-delivered", worker.id, initial);
    const before = service.sharedContext.receipts(worker.id);
    expect(before[0]?.deliveredAt).toEqual(expect.any(String));
    expect(before[0]?.adoptedAt).toBeUndefined();
    const reference = service.sharedContext.sessionContext(worker.id);
    expect(reference).toContain("共同需求轻量引用");
    expect(reference).toContain("context_get");
    expect(reference).not.toContain(body);
    expect(reference.length).toBeLessThan(1000);
    await service.sessions.sendMessage(worker.id, "下一轮");
    expect(f.native.sendMessage).toHaveBeenLastCalledWith(worker.id, `下一轮\n\n${reference}`, [], { beforeDispatch: expect.any(Function), purpose: "work" });
    await service.sessions.sendMessage(worker.id, "恢复后继续");
    expect(f.native.sendMessage).toHaveBeenLastCalledWith(worker.id, `恢复后继续\n\n${reference}`, [], { beforeDispatch: expect.any(Function), purpose: "work" });
    f.native.emit("message-delivered", worker.id, reference);
    expect(service.sharedContext.receipts(worker.id)).toEqual(before);
    await f.runtime.resend(worker.id, oldQueue.id);
    expect(f.store.getItem(oldQueue.id)).toMatchObject({ text: initial });
    service.sessions.inbox.pause(worker.id);
    await service.sessions.inbox.put(worker.id, "后续排队消息", undefined, "lightweight-inbox-input");
    expect(f.store.getItem("lightweight-inbox-input")).toMatchObject({ text: expect.stringContaining("共同需求轻量引用") });
    expect(f.store.getItem("lightweight-inbox-input")).not.toMatchObject({ text: expect.stringContaining(body) });
    // A reference from one conversation is not proof of providing the full body to another conversation.
    const second = f.create(child);
    service.sharedContext.markDelivered(second.id, reference);
    expect(service.sharedContext.receipts(second.id).some((r) => r.deliveredAt)).toBe(false);
    expect(() => service.sharedContext.adopt(second.id, { contextId: first.id, version: 1 })).toThrow(/先用 context_get/);
    const reread = service.sharedContext.getForSession(second.id);
    expect(reread.context?.versions.find((v) => v.version === 1)?.body).toBe(body);
    expect(service.sharedContext.receipts(second.id)[0]?.deliveredAt).toEqual(expect.any(String));
    expect(service.sharedContext.receipts(second.id)[0]?.adoptedAt).toBeUndefined();
    expect(service.sharedContext.sessionContext(second.id)).toContain("共同需求轻量引用");
    service.sessions.inbox.pause(second.id);
    const next = service.sharedContext.save(manager.id, { ...input, baseRevision: first.revision, body: "新的完整需求正文", changeNote: "第二版" });
    service.sharedContext.publishVersion(manager.id, next.id, next.revision);
    expect(service.sharedContext.sessionContext(worker.id)).toBe(reference); // Publishing alone does not upgrade the task.
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 2, taskIds: [child.id] });
    const upgraded = service.sharedContext.sessionContext(worker.id);
    expect(upgraded).toContain("新的完整需求正文");
    expect(upgraded).not.toContain("共同需求轻量引用");
    expect(service.sharedContext.validateMessage(worker.id, oldQueue.id)).toBe(false);
    await vi.waitFor(() => expect(service.sessions.inbox.held(worker.id).some((item) => item.type === "user" && item.text.includes("新的完整需求正文"))).toBe(true));
    const view = service.sharedContext.getForSession(worker.id);
    expect(view.context?.versions.find((v) => v.version === view.binding?.version)?.body).toBe("新的完整需求正文");
    expect(service.sharedContext.sessionContext(worker.id)).toContain("共同需求轻量引用");
    expect(service.sharedContext.receipts(worker.id).find((r) => r.version === 2)?.adoptedAt).toBeUndefined();
  });

  it("queues a new applied requirement even when the prior put is still in flight", async () => {
    const f = fixture();
    const lead = f.store.createTask({ title: "lead", workspaceId: f.workspace.id, lead: true });
    const child = f.store.createTask({ title: "child", workspaceId: f.workspace.id, managerTaskId: lead.id });
    const manager = f.create(lead), worker = f.create(child);
    const service = new HostService(f.store, f.runtime, f.profiles, { commonDir: join(f.root, "common") });
    let release!: () => void;
    const put = vi.spyOn(service.sessions.inbox, "put").mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ delivered: false, waiting: 1 }); })).mockResolvedValue({ delivered: false, waiting: 1 });
    const saved = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: 0, title: "共同需求", body: "三枚", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户" }] });
    const first = service.sharedContext.publishVersion(manager.id, saved.id, saved.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 1, taskIds: [child.id] });
    expect(put).toHaveBeenCalledTimes(1);
    const changed = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: first.revision, title: "共同需求", body: "五枚", changeNote: "调整", sources: [{ kind: "user_requirement", source: "用户调整" }] });
    service.sharedContext.publishVersion(manager.id, changed.id, changed.revision);
    service.sharedContext.apply(manager.id, { contextId: first.id, version: 2, taskIds: [child.id] });
    release();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]?.[0]).toBe(worker.id);
    expect(put.mock.calls[1]?.[1]).toContain("五枚");
    expect(put.mock.calls[1]?.[3]).not.toBe(put.mock.calls[0]?.[3]);
  });

  it("supplies the first task turn without racing it with a second automatic notification", async () => {
    const f = fixture();
    const lead = f.store.createTask({ title: "lead", workspaceId: f.workspace.id, lead: true });
    const child = f.store.createTask({ title: "child", workspaceId: f.workspace.id, managerTaskId: lead.id });
    const manager = f.create(lead);
    const service = new HostService(f.store, f.runtime, f.profiles, { commonDir: join(f.root, "common") });
    const saved = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: 0, title: "共同需求", body: "投币五枚", changeNote: "用户确定", sources: [{ kind: "user_requirement", source: "当前目标" }] });
    const published = service.sharedContext.publishVersion(manager.id, saved.id, saved.revision);
    service.sharedContext.apply(manager.id, { contextId: published.id, version: 1, taskIds: [child.id] });
    vi.spyOn(f.runtime, "choices").mockResolvedValue({ profileId: "mock", models: [], permissions: [], defaultPermission: "", source: "builtin" });
    const worker = await service.tasks.addSession(child.id, { profileId: "mock", text: "开始" });
    await Promise.resolve();
    expect(f.native.startSession.mock.calls[0]![0].text).toContain("[AMO_SHARED_CONTEXT:");
    expect(service.sessions.inbox.held(worker.id)).toHaveLength(0);
    expect(f.native.resend).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude", "dsh"] as const)("injects frozen first/next input and forwards only explicit transport receipts for %s", async (name) => {
    const f = fixture(name), task = f.store.createTask({ title: "worker", workspaceId: f.workspace.id });
    let body = "[AMO_SHARED_CONTEXT:requirement-v1]\nversion one";
    f.runtime.setMessageContext({ task: () => body, session: () => body, validate: () => true });
    const receipts = vi.fn();
    f.runtime.on("message-delivered", receipts);
    const s = await f.runtime.startSession({ taskId: task.id, topicId: null, workspace: f.workspace, profileId: "mock", text: "first" });
    expect(f.native.startSession.mock.calls[0]![0].text).toBe(`first\n\n${body}`);
    await f.runtime.sendMessage(s.id, "next");
    expect(f.native.sendMessage).toHaveBeenCalledWith(s.id, `next\n\n${body}`, [], { beforeDispatch: expect.any(Function), purpose: "work" });
    expect(receipts).not.toHaveBeenCalled();
    const queued = f.store.appendItem({ id: "queued-v1", sessionId: s.id, type: "user", text: `queued\n\n${body}`, delivery: "held", createdAt: new Date().toISOString(), raw: { runtime: name, method: "test" } });
    body = "[AMO_SHARED_CONTEXT:requirement-v2]\nversion two";
    await f.runtime.resend(s.id, queued.id);
    expect(f.store.getItem(queued.id)).toMatchObject({ text: expect.stringContaining("requirement-v1") });
    expect(f.store.getItem(queued.id)).not.toMatchObject({ text: expect.stringContaining("requirement-v2") });
    f.native.emit("message-delivered", s.id, "[AMO_SHARED_CONTEXT:requirement-v1]");
    expect(receipts).toHaveBeenCalledWith(s.id, "[AMO_SHARED_CONTEXT:requirement-v1]");
    f.runtime.setMessageContext({ task: () => body, session: () => body, validate: () => false });
    expect(() => f.runtime.resend(s.id, queued.id)).toThrow(/通知已失效/);
    expect(f.native.resend).toHaveBeenCalledTimes(1);
  });

  it("keeps context notifications durable, deduplicated and paused across a new Host service", async () => {
    const f = fixture();
    const lead = f.store.createTask({ title: "lead", workspaceId: f.workspace.id, lead: true });
    const child = f.store.createTask({ title: "child", workspaceId: f.workspace.id, managerTaskId: lead.id });
    const manager = f.create(lead), worker = f.create(child);
    const service = new HostService(f.store, f.runtime, f.profiles, { commonDir: join(f.root, "common") });
    service.sessions.inbox.pause(worker.id);
    const saved = service.sharedContext.save(manager.id, { rootTaskId: lead.id, baseRevision: 0, title: "共同需求", body: "投币五枚", changeNote: "用户确定", sources: [{ kind: "user_requirement", source: "当前目标" }] });
    const published = service.sharedContext.publishVersion(manager.id, saved.id, saved.revision);
    const [binding] = service.sharedContext.apply(manager.id, { contextId: published.id, version: 1, taskIds: [child.id] });
    await vi.waitFor(() => expect(service.sessions.inbox.held(worker.id)).toHaveLength(1));
    service.publish({ type: "task.upserted", task: f.store.getTask(child.id)! });
    await Promise.resolve();
    expect(service.sessions.inbox.held(worker.id)).toHaveLength(1);
    expect(service.sharedContext.receipts(worker.id)).toEqual([expect.objectContaining({ requirementId: binding!.id, queuedAt: expect.any(String) })]);
    expect(service.sharedContext.receipts(worker.id)[0]?.deliveredAt).toBeUndefined();
    expect(f.native.resend).not.toHaveBeenCalled();
    const restoredRuntime = new RuntimeRouter(f.store, f.profiles, { codex: f.native as unknown as SessionRuntimeApi });
    const restored = new HostService(f.store, restoredRuntime, f.profiles, { commonDir: join(f.root, "common") });
    await Promise.resolve();
    expect(restored.sessions.inbox.held(worker.id)).toHaveLength(1);
    expect(f.native.resend).not.toHaveBeenCalled();
    const otherRoot = f.store.createTask({ title: "other", workspaceId: f.workspace.id, lead: true });
    f.store.updateTask(child.id, { managerTaskId: otherRoot.id });
    await expect(restored.sessions.inbox.sendNow(worker.id, restored.sessions.inbox.held(worker.id)[0]!.id)).rejects.toThrow(/通知已失效/);
    expect(f.native.resend).not.toHaveBeenCalled();
  });
});
