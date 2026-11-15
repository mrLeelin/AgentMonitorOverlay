import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// Stage 16: 传话 — a 主控's message for another task's session: confirmed by the person (or not asked), delivered.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let leadSession: Session;
let target: Task;
let workerSession: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-relays-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = service.topics.createTopic({ title: "迁移" });
  const lead = store.createTask({ title: "迁移主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  target = store.createTask({ title: "装甲车", workspaceId: alpha.id, topicId: topic.id, managerTaskId: lead.id });
  const other = store.createTask({ title: "别处", workspaceId: alpha.id });
  const session = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${taskId}` });
  leadSession = session(lead.id);
  workerSession = session(other.id);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const lastMail = () => service.collab.readMailFromSession(leadSession.id).at(-1)?.text;
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));

describe("relays (传话)", () => {
  it("reports an actual inbox runtime failure as failed with its reason instead of claiming delivery or waiting", async () => {
    vi.spyOn(service.runtime, "resend").mockRejectedValue(new Error("runtime transport is unavailable"));
    const sent = service.relays.send(leadSession.id, { taskId: target.id, text: "需要送达" });
    const result = await service.relays.deliver(sent.id);
    expect(result).toMatchObject({ state: "failed", error: "runtime transport is unavailable" });
    expect(store.getItem(`i-relay-${sent.id}`)).toMatchObject({ delivery: "unsent", deliveryReason: "runtime transport is unavailable" });
    const receipt = lastMail();
    expect(receipt).toContain("传话没能送到");
    expect(receipt).toContain("runtime transport is unavailable");
    await until(() => !!store.getItem(`i-relay-receipt-${sent.id}`));
    expect(store.getItem(`i-relay-receipt-${sent.id}`)).toHaveProperty("messagePurpose", "notification");
  });

  it("joins an automatic task start before delivering a relay instead of opening another session", async () => {
    const start = service.runtime.startSession.bind(service.runtime);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const spy = vi.spyOn(service.runtime, "startSession").mockImplementationOnce(async (input) => { entered(); await gate; return start(input); });
    const starting = service.tasks.addSession(target.id, { profileId: "p-ds", text: "完整任务契约与前置证据" });
    await ready;
    const relay = service.relays.send(leadSession.id, { taskId: target.id, text: "补充要求" });
    const delivering = service.relays.deliver(relay.id);
    await Promise.resolve();
    release();
    const [worker, delivered] = await Promise.all([starting, delivering]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.listSessions({ taskId: target.id })).toHaveLength(1);
    expect(delivered.sessionId).toBe(worker.id);
    expect(userTexts(worker.id).join("\n")).toContain("完整任务契约与前置证据");
    expect(store.getItem(`i-relay-${relay.id}`)).toMatchObject({ sessionId: worker.id, text: expect.stringContaining("补充要求") });
  });

  it("shares a first conversation across simultaneous distinct relays", async () => {
    const a = service.relays.send(leadSession.id, { taskId: target.id, text: "要求甲" });
    const b = service.relays.send(leadSession.id, { taskId: target.id, text: "要求乙" });
    const [first, second] = await Promise.all([service.relays.deliver(a.id), service.relays.deliver(b.id)]);
    expect(first.sessionId).toBe(second.sessionId);
    expect(store.listSessions({ taskId: target.id })).toHaveLength(1);
    expect(store.getItem(`i-relay-${a.id}`)).toMatchObject({ sessionId: first.sessionId });
    expect(store.getItem(`i-relay-${b.id}`)).toMatchObject({ sessionId: first.sessionId });
  });

  it("allows a fresh relay after the shared first-session creation fails", async () => {
    vi.spyOn(service.runtime, "startSession").mockRejectedValueOnce(new Error("启动失败"));
    const a = service.relays.send(leadSession.id, { taskId: target.id, text: "要求甲" });
    const b = service.relays.send(leadSession.id, { taskId: target.id, text: "要求乙" });
    const failed = await Promise.all([service.relays.deliver(a.id), service.relays.deliver(b.id)]);
    expect(failed.every((r) => r.state === "failed")).toBe(true);
    expect(service.tasks.hasStartingSession(target.id)).toBe(false);
    const retry = await service.relays.deliver(service.relays.send(leadSession.id, { taskId: target.id, text: "重试" }).id);
    expect(retry.state).toBe("delivered");
    expect(store.listSessions({ taskId: target.id })).toHaveLength(1);
  });

  it("rechecks management after waiting for an in-flight session", async () => {
    const start = service.runtime.startSession.bind(service.runtime);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    vi.spyOn(service.runtime, "startSession").mockImplementationOnce(async (input) => { entered(); await gate; return start(input); });
    const starting = service.tasks.addSession(target.id, { profileId: "p-ds" });
    await ready;
    const relay = service.relays.send(leadSession.id, { taskId: target.id, text: "旧主控要求" });
    const delivering = service.relays.deliver(relay.id);
    const other = store.createTask({ title: "新主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
    service.tasks.updateTask(target.id, { managerTaskId: other.id });
    release();
    await starting;
    expect(await delivering).toMatchObject({ state: "failed", error: expect.stringContaining("归属已变更") });
    expect(store.getItem(`i-relay-${relay.id}`)).toBeUndefined();
    expect(store.listSessions({ taskId: target.id })).toHaveLength(1);
  });

  it("takes a relay only from a 主控, for a task of its topic", () => {
    expect(() => service.relays.send(workerSession.id, { taskId: target.id, text: "x" })).toThrow(/只有主控/);
    const outside = store.listTasks().find((t) => t.title === "别处")!;
    expect(() => service.relays.send(leadSession.id, { taskId: outside.id, text: "x" })).toThrow(/不在你的管理范围/);
    expect(() => service.relays.send(leadSession.id, { taskId: target.id, text: " " })).toThrow(/text/);
    expect(service.relays.send(leadSession.id, { taskId: target.id, text: "先做数据" })).toMatchObject({ state: "pending", toTaskId: target.id });
  });

  it("waits for the person: dismissed, or delivered into a new session (none yet), marked as from the 主控", async () => {
    const no = service.relays.send(leadSession.id, { taskId: target.id, text: "不用了" });
    expect(service.relays.dismiss(no.id).state).toBe("dismissed");
    expect(lastMail()).toBe("人没有让你的传话送到「装甲车」。");
    const yes = service.relays.send(leadSession.id, { taskId: target.id, text: "先迁数据表，界面等我通知" });
    const delivered = await service.relays.deliver(yes.id);
    expect(delivered).toMatchObject({ state: "delivered", sessionId: expect.any(String) });
    const text = userTexts(delivered.sessionId!)[0]!;
    expect(text).toContain("【主控「迁移主控」传话】");
    expect(text).toContain("先迁数据表，界面等我通知");
    expect(text).toContain("mailbox_send");
    expect(lastMail()).toBe("传话已送到「装甲车」。");
    await expect(service.relays.deliver(yes.id)).rejects.toThrow(/decided already/);
  });

  it("goes at once to a task that takes relays without asking, into its session", async () => {
    const first = await service.relays.deliver(service.relays.send(leadSession.id, { taskId: target.id, text: "开始" }).id);
    service.tasks.updateTask(target.id, { relayAuto: true });
    const sent = service.relays.send(leadSession.id, { taskId: target.id, text: "计划改了：先做界面" });
    await until(() => store.getRelay(sent.id)?.state === "delivered");
    expect(store.getRelay(sent.id)!.sessionId).toBe(first.sessionId);
    expect(userTexts(first.sessionId!).at(-1)).toContain("计划改了：先做界面");
  });

  it("dispatches managed work once and records success as mail without waking the lead", async () => {
    const resend = vi.spyOn(service.runtime, "resend");
    const sent = service.relays.send(leadSession.id, { taskId: target.id, text: "按已定范围完成投币逻辑" });
    const [first, second] = await Promise.all([service.relays.deliver(sent.id), service.relays.deliver(sent.id)]);
    expect(first).toEqual(second);
    expect(first.state).toBe("delivered");
    expect(store.listSessions({ taskId: target.id })).toHaveLength(1);
    expect(store.listItems(first.sessionId!).filter((i) => i.id === `i-relay-${sent.id}`)).toHaveLength(1);
    service.relays.watch();
    expect(service.collab.readMailFromSession(leadSession.id).filter((m) => m.text === "传话已送到「装甲车」。")).toHaveLength(1);
    expect(store.getItem(`i-relay-receipt-${sent.id}`)).toBeUndefined();
    expect(resend.mock.calls.filter(([sessionId, itemId]) => sessionId === leadSession.id && itemId === `i-relay-receipt-${sent.id}`)).toHaveLength(0);
  });

  it("keeps topic-only proposals manual and does not turn an unassigned peer into a managed task", async () => {
    const s = store.createSession({ ...leadSession, id: undefined, taskId: null, topicId: topic.id, runtimeRef: null });
    const sent = service.relays.send(s.id, { taskId: target.id, text: "专题协调意见" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.getRelay(sent.id)?.state).toBe("pending");
    expect(store.listSessions({ taskId: target.id })).toHaveLength(0);
    service.relays.dismiss(sent.id);
  });
});
