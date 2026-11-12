import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir, TINY_PNG_BASE64 } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let folder: string, store: Store, servers: FakeServers, service: HostService, manager: Session, worker: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-inquiry-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "项目", path: folder });
  const top = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "已完成执行", workspaceId: workspace.id, managerTaskId: top.id });
  manager = await service.tasks.addSession(top.id, { profileId: "test" });
  worker = await service.tasks.addSession(child.id, { profileId: "test", options: { permission: "workspace-write" } });
  const result = service.orchestration.submit(worker.id, "完成", "检查通过");
  service.orchestration.review(manager.id, result.id, true, "验收通过");
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });

it("keeps accepted work accepted while an explicit MCP inquiry reaches an actual runtime turn", async () => {
  const tool = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_message")!;
  const reply = await tool.run({ taskId: worker.taskId, text: "[[slow]] 只回答当前版本", purpose: "inquiry" });
  expect(reply.isError).not.toBe(true);
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect(store.listItems(worker.id).find((i) => i.type === "user" && i.text.includes("只回答当前版本"))).toHaveProperty("messagePurpose", "inquiry");
  expect(store.listItems(worker.id).find((i) => i.type === "turn" && i.state === "running")).toHaveProperty("messagePurpose", "inquiry");
  expect(servers.fakes.get("test")!.calls.filter((c) => c.method === "turn/start" && JSON.stringify(c.params).includes("只回答当前版本")).at(-1)?.params).toMatchObject({ sandboxPolicy: { type: "readOnly", networkAccess: false }, approvalPolicy: "never" });
  const update = amoToolsFor(service, { sessionId: worker.id }).find((t) => t.name === "task_update")!;
  expect(await update.run({ title: "不能由询问修改" })).toMatchObject({ isError: true, content: [expect.objectContaining({ text: expect.stringContaining("只读询问") })] });
  await service.sessions.interrupt(worker.id);
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).not.toBe("running"));
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
});

it.each([undefined, "work", "reopen"])("keeps legacy and explicit %s work reopening accepted work", async (purpose) => {
  const tool = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_message")!;
  expect((await tool.run({ taskId: worker.taskId, text: "[[slow]] 继续实施", ...(purpose ? { purpose } : {}) })).isError).not.toBe(true);
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("doing");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("returned");
  await service.sessions.interrupt(worker.id);
});

it("preserves acceptance for automatic notifications while retaining the recipient's original write capabilities", async () => {
  await service.sessions.inbox.put(worker.id, "[[slow]] 自动状态通知", undefined, "i-auto-status", { purpose: "notification" });
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect((await amoToolsFor(service, { sessionId: worker.id }).find((t) => t.name === "task_note_add")!.run({ text: "仍按原角色记录" })).isError).not.toBe(true);
  await service.sessions.interrupt(worker.id);
});

it("retains a paused inquiry's durable purpose through Host reconstruction before dispatch", async () => {
  service.sessions.inbox.pause(worker.id);
  const tool = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_message")!;
  await tool.run({ taskId: worker.taskId, text: "[[slow]] 重建后只读回答", purpose: "inquiry" });
  await vi.waitFor(() => expect(service.sessions.inbox.held(worker.id)).toHaveLength(1));
  const held = service.sessions.inbox.held(worker.id)[0]!;
  expect(held).toHaveProperty("messagePurpose", "inquiry");
  const rebuilt = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  await Promise.resolve();
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  await rebuilt.sessions.inbox.sendNow(worker.id, held.id);
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(rebuilt.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  await rebuilt.sessions.interrupt(worker.id);
});

it("keeps queued work outside the running inquiry and starts a separate work turn with restored permissions", async () => {
  const tool = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_message")!;
  await tool.run({ taskId: worker.taskId, text: "[[slow]] 当前只读回合", purpose: "inquiry" });
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  const inquiryTurn = store.listItems(worker.id).find((i) => i.type === "turn" && i.state === "running")!;
  const picture = service.attachments.save(Buffer.from(TINY_PNG_BASE64, "base64"), { mime: "image/png", name: "queued.png" });
  expect(await service.sessions.sendMessage(worker.id, "[[slow]] 接下来实施", [picture.id])).toMatchObject({ mode: "queue" });
  const update = amoToolsFor(service, { sessionId: worker.id }).find((t) => t.name === "task_update")!;
  expect((await update.run({ title: "不能提前修改" })).isError).toBe(true);
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect(store.getItem(inquiryTurn.id)).toHaveProperty("messagePurpose", "inquiry");
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/steer" && JSON.stringify(call.params).includes("接下来实施"))).toHaveLength(0);
  await service.runtime.interrupt(worker.id);
  await vi.waitFor(() => expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("returned"));
  const workTurn = store.listItems(worker.id).find((i) => i.type === "turn" && i.state === "running");
  expect(workTurn).toHaveProperty("messagePurpose", "work");
  expect(workTurn?.id).not.toBe(inquiryTurn.id);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("接下来实施")).at(-1)?.params).toMatchObject({ sandboxPolicy: { type: "workspaceWrite" } });
  expect(JSON.stringify(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("接下来实施")).at(-1)?.params)).toContain(picture.path.replaceAll("\\", "\\\\"));
  await service.sessions.interrupt(worker.id);
});

it.each([["inquiry", "work"], ["work", "inquiry"]] as const)("sends paused %s to %s changes only after the old native turn ends, preserving pause", async (first, second) => {
  await service.sessions.inbox.put(worker.id, "[[slow]] 初始用途", undefined, "i-first-purpose", { purpose: first });
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  const originalTurn = store.listItems(worker.id).find((item) => item.type === "turn" && item.state === "running")!;
  service.sessions.inbox.pause(worker.id);
  await service.sessions.inbox.put(worker.id, "[[slow]] 下一用途", undefined, "i-next-purpose", { purpose: second });
  await service.sessions.inbox.sendNow(worker.id, "i-next-purpose");
  await vi.waitFor(() => expect(store.listItems(worker.id).some((item) => item.type === "turn" && item.state === "running" && item.id !== originalTurn.id)).toBe(true));
  expect(store.getItem(originalTurn.id)).toMatchObject({ messagePurpose: first, state: "interrupted" });
  expect(store.listItems(worker.id).find((item) => item.type === "turn" && item.state === "running")).toHaveProperty("messagePurpose", second);
  expect(JSON.parse(store.getKv("sessions.inbox.paused")!.value)).toContain(worker.id);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/steer" && JSON.stringify(call.params).includes("下一用途"))).toHaveLength(0);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("下一用途")).at(-1)?.params).toMatchObject({ sandboxPolicy: { type: second === "inquiry" ? "readOnly" : "workspaceWrite" } });
  await service.runtime.interrupt(worker.id);
});

it("retains the inquiry's permission boundary after a failed immediate change and permits retry", async () => {
  await service.sessions.inbox.put(worker.id, "[[slow]] 保持只读", undefined, "i-inquiry-before-failed-now", { purpose: "inquiry" });
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  await service.sessions.inbox.put(worker.id, "[[slow]] 待重试工作", undefined, "i-retry-work", { purpose: "work" });
  const handle = await servers.ensure("test"), request = handle.client.request.bind(handle.client);
  const spy = vi.spyOn(handle.client, "request").mockImplementation(((method: string, params: never) => method === "turn/interrupt" ? Promise.reject(new Error("interrupt transport failed")) : request(method as never, params)) as typeof handle.client.request);
  await expect(service.sessions.inbox.sendNow(worker.id, "i-retry-work")).rejects.toThrow(/interrupt transport failed/);
  expect(store.getItem("i-retry-work")).toMatchObject({ delivery: "held" });
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect((await amoToolsFor(service, { sessionId: worker.id }).find((tool) => tool.name === "task_update")!.run({ title: "不能提前解锁" })).isError).toBe(true);
  spy.mockRestore();
  await service.sessions.inbox.sendNow(worker.id, "i-retry-work");
  await vi.waitFor(() => expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("returned"));
  await service.runtime.interrupt(worker.id);
});

it("migrates a legacy held relay receipt's purpose from its real producer before sending in the same context version", async () => {
  const final = service.orchestration.submit(manager.id, "全部交付", "下级已验收");
  service.orchestration.reviewByUser(manager.taskId!, final.id, true, "用户验收通过");
  service.sessions.inbox.pause(manager.id);
  const tool = amoToolsFor(service, { sessionId: manager.id }).find((t) => t.name === "task_message")!;
  await tool.run({ taskId: worker.taskId, text: "仅回答当前状态", purpose: "inquiry" });
  const relay = store.listRelays().at(-1)!;
  const receiptId = `i-relay-receipt-${relay.id}`;
  await vi.waitFor(() => expect(store.getItem(receiptId)).toMatchObject({ delivery: "held" }));
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("idle"));
  const receipt = store.getItem(receiptId)!;
  if (receipt.type !== "user") throw new Error("expected receipt user row");
  const { messagePurpose: _legacyMissing, ...legacy } = receipt;
  store.replaceItem(legacy);
  const rebuilt = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(folder, "common") });
  expect(store.getItem(receiptId)).toHaveProperty("messagePurpose", "notification");
  await rebuilt.sessions.inbox.sendNow(manager.id, receiptId);
  await vi.waitFor(() => expect(store.listItems(manager.id).some((i) => i.type === "turn" && i.messagePurpose === "notification")).toBe(true));
  expect(store.getTask(manager.taskId!)?.column).toBe("done");
  expect(rebuilt.orchestration.results(manager.taskId!).at(-1)?.state).toBe("accepted");
  await rebuilt.sessions.interrupt(manager.id);
});

it("answers a direct inquiry without unpausing previously held work or revoking acceptance", async () => {
  service.sessions.inbox.pause(worker.id);
  await service.sessions.inbox.put(worker.id, "暂停中的实施工作", undefined, "i-still-paused-work", { purpose: "work" });
  await service.sessions.sendMessage(worker.id, "本次仅回答状态", [], [], { purpose: "inquiry" });
  await vi.waitFor(() => expect(store.listItems(worker.id).some((row) => row.type === "agent" && !row.streaming && row.markdown.includes("本次仅回答状态"))).toBe(true));
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("idle"));
  expect(JSON.parse(store.getKv("sessions.inbox.paused")!.value)).toContain(worker.id);
  expect(store.getItem("i-still-paused-work")).toHaveProperty("delivery", "held");
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("暂停中的实施工作"))).toHaveLength(0);
});

it.each([["inquiry", "work"], ["inquiry", "notification"], ["work", "inquiry"]] as const)("serializes idle cold dispatch %s before %s without allowing purpose overwrite", async (firstPurpose, secondPurpose) => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const atGate = new Promise<void>((resolve) => { entered = resolve; });
  const ensure = servers.ensure.bind(servers);
  vi.spyOn(servers, "ensure").mockImplementationOnce(async (id) => { entered(); await gate; return ensure(id); });
  const first = service.sessions.sendMessage(worker.id, "[[slow]] 冷恢复输入A", [], [], { purpose: firstPurpose });
  await atGate;
  try {
    expect(store.getSession(worker.id)?.status).toBe("idle");
    if (secondPurpose === "notification") expect(await service.sessions.inbox.put(worker.id, "[[slow]] 并发用途B", undefined, "i-concurrent-notification", { purpose: "notification" })).toMatchObject({ delivered: false });
    else expect(await service.sessions.sendMessage(worker.id, "[[slow]] 并发用途B", [], [], { purpose: secondPurpose })).toMatchObject({ mode: "queue" });
    expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("并发用途B"))).toHaveLength(0);
    expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  } finally { release(); await first; }
  await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
  const firstTurn = store.listItems(worker.id).find((row) => row.type === "turn" && row.state === "running")!;
  expect(firstTurn).toHaveProperty("messagePurpose", firstPurpose);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("冷恢复输入A")).at(-1)?.params).toMatchObject({ sandboxPolicy: { type: firstPurpose === "inquiry" ? "readOnly" : "workspaceWrite" } });
  await service.runtime.interrupt(worker.id);
  await vi.waitFor(() => expect(store.listItems(worker.id).some((row) => row.type === "turn" && row.state === "running" && row.id !== firstTurn.id)).toBe(true));
  expect(store.listItems(worker.id).find((row) => row.type === "turn" && row.state === "running")).toHaveProperty("messagePurpose", secondPurpose);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("并发用途B")).at(-1)?.params).toMatchObject({ sandboxPolicy: { type: secondPurpose === "inquiry" ? "readOnly" : "workspaceWrite" } });
  await service.runtime.interrupt(worker.id);
});

it("retains the dispatch reservation when RPC acknowledgment precedes the persisted running session state", async () => {
  const handle = await servers.ensure("test");
  const emitter = handle.client as unknown as { emit(event: string, ...args: unknown[]): boolean };
  const emit = emitter.emit.bind(emitter), buffered: unknown[][] = [];
  let released = false;
  vi.spyOn(emitter, "emit").mockImplementation((event, ...args) => {
    const notification = args[0] as { method?: string; params?: { threadId?: string } } | undefined;
    if (!released && event === "notification" && notification?.params?.threadId === worker.runtimeRef) { buffered.push(args); return true; }
    return emit(event, ...args);
  });
  await service.sessions.sendMessage(worker.id, "[[slow]] 先确认只读RPC", [], [], { purpose: "inquiry" });
  expect(store.getSession(worker.id)?.status).toBe("idle");
  expect(await service.sessions.sendMessage(worker.id, "[[slow]] ACK后的工作", [], [], { purpose: "work" })).toMatchObject({ mode: "queue" });
  const index = buffered.findIndex(([value]) => (value as { method?: string }).method === "turn/started");
  expect(index).toBeGreaterThanOrEqual(0);
  const [started] = buffered.splice(index, 1);
  emit("notification", ...started!);
  // Codex appends its turn row before setStatus(running); releasing on that row reenters the inbox while still idle.
  expect(store.getSession(worker.id)?.status).toBe("running");
  expect(store.getTask(worker.taskId!)?.column).toBe("done");
  expect(service.orchestration.results(worker.taskId!).at(-1)?.state).toBe("accepted");
  released = true;
  for (const args of buffered.splice(0)) emit("notification", ...args);
  expect(servers.fakes.get("test")!.calls.filter((call) => call.method === "turn/steer" && JSON.stringify(call.params).includes("ACK后的工作"))).toHaveLength(0);
  await service.runtime.interrupt(worker.id);
  await vi.waitFor(() => expect(store.listItems(worker.id).some((row) => row.type === "turn" && row.state === "running" && row.messagePurpose === "work")).toBe(true));
  await service.runtime.interrupt(worker.id);
});
