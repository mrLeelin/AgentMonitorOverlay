import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { SCHEDULER_TASK_KEY } from "../../core/shared.js";

// 进行中 ⇄ 待审阅 by the sessions (2026-10-26): Studio moves the card when the task's sessions all stop, and back when
// one starts again.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-columns-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  service.tasks.reviewSettleMs = 100;
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const column = (task: Task) => store.getTask(task.id)?.column;
const status = (id: string) => store.getSession(id)?.status;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("changes the workspace for future sessions without interrupting an existing session", async () => {
  const betaPath = join(root, "beta");
  mkdirSync(betaPath);
  const beta = service.projects.addWorkspace({ path: betaPath });
  const { task, session } = await service.tasks.createTask({ workspaceId: alpha.id, firstSession: { profileId: "p-ds", text: "[[shell: cmd /c echo hold]]" } });
  await until(() => status(session!.id) === "awaiting-approval");

  const starting = service.tasks.addSession(task.id, { profileId: "p-ds" });
  expect(() => service.tasks.updateTask(task.id, { workspaceId: beta.id })).toThrow(/会话正在创建/);
  await starting;

  const grants = vi.spyOn(service.remote.grants, "of").mockReturnValue([{ taskId: task.id, account: "test", device: "peer", name: "Test peer", grantedAt: task.createdAt }]);
  expect(() => service.tasks.updateTask(task.id, { workspaceId: beta.id })).toThrow(/收回.*远程授权/);
  grants.mockRestore();

  expect(service.tasks.updateTask(task.id, { workspaceId: beta.id })).toMatchObject({ workspaceId: beta.id, column: "doing" });
  const next = await service.tasks.addSession(task.id, { profileId: "p-ds" });

  expect(next.workspaceId).toBe(beta.id);
  expect(store.getSession(session!.id)).toMatchObject({ workspaceId: alpha.id, status: "awaiting-approval" });
  expect(servers.fakes.get("p-ds")?.calls.filter((call) => call.method === "thread/start").map((call) => call.params)).toMatchObject([{ cwd: alpha.path }, { cwd: alpha.path }, { cwd: beta.path }]);
});

describe("主控等待下辖任务返回", () => {
  const lead = () => store.createTask({ title: "总主控", workspaceId: alpha.id, column: "doing", lead: true });
  const child = (manager: Task, input: Partial<Task> = {}) => store.createTask({ title: "执行任务", workspaceId: alpha.id, managerTaskId: manager.id, column: "doing", ...input });

  it("keeps an idle lead doing while a child has not delivered, even if that child's turn has stopped", async () => {
    const top = lead();
    const worker = child(top);
    const main = await service.tasks.addSession(top.id, { profileId: "p-ds", text: "[[slow]]" });
    service.sessions.inbox.pause(main.id);
    const execution = await service.tasks.addSession(worker.id, { profileId: "p-ds", text: "已结束本轮" });
    await until(() => column(worker) === "review");
    await service.sessions.interrupt(main.id);
    await pause(250);
    expect(column(top)).toBe("doing");
    service.orchestration.submit(execution.id, "完成实现", "测试通过");
    await until(() => column(top) === "review");
  });

  it("waits for every descendant, reopens on return, and settles again after resubmission", async () => {
    const top = lead();
    const domain = child(top, { title: "二级主控", lead: true, column: "review" });
    const worker = child(domain);
    const main = await service.tasks.addSession(top.id, { profileId: "p-ds", text: "[[slow]]" });
    const coordinator = await service.tasks.addSession(domain.id, { profileId: "p-ds" });
    const execution = await service.tasks.addSession(worker.id, { profileId: "p-ds" });
    service.sessions.inbox.pause(main.id);
    service.sessions.inbox.pause(coordinator.id);
    service.sessions.inbox.pause(execution.id);
    await service.sessions.interrupt(main.id);
    await pause(250);
    expect(column(top)).toBe("doing");
    expect(column(domain)).toBe("doing");
    const result = service.orchestration.submit(execution.id, "完成实现", "测试通过");
    await until(() => column(domain) === "review");
    expect(column(top)).toBe("doing");
    service.orchestration.review(coordinator.id, result.id, true, "验收通过");
    const summary = service.orchestration.submit(coordinator.id, "汇总完成", "下级已验收");
    await until(() => column(top) === "review");
    service.orchestration.review(main.id, summary.id, false, "补充验证");
    expect(column(top)).toBe("doing");
    await pause(250);
    expect(column(top)).toBe("doing");
    service.orchestration.submit(coordinator.id, "补充后汇总", "补充验证通过");
    await until(() => column(top) === "review");
  });

  it("repairs an existing review lead on startup and blocks premature manual review", () => {
    const top = lead();
    child(top, { column: "todo" });
    store.updateTask(top.id, { column: "review" });
    new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
    expect(column(top)).toBe("doing");
    expect(service.tasks.updateTask(top.id, { column: "review" }).column).toBe("doing");
  });

  it("rechecks the last child's state during settling and reopens on a new pending session start", async () => {
    const top = lead();
    const worker = child(top);
    service.tasks.updateTask(worker.id, { column: "done" });
    service.tasks.updateTask(worker.id, { column: "doing" });
    await pause(250);
    expect(column(top)).toBe("doing");
    service.tasks.updateTask(worker.id, { column: "done" });
    await until(() => column(top) === "review");
    let finish!: () => void;
    const starting = service.tasks.trackSessionStart(worker.id, () => new Promise<void>((resolve) => { finish = resolve; }));
    expect(column(top)).toBe("doing");
    await pause(250);
    expect(column(top)).toBe("doing");
    finish();
    await starting;
    await until(() => column(top) === "review");
  });

  it("rechecks both managers on transfer, ignores other trees, and releases archived work", async () => {
    const top = lead();
    const other = lead();
    const { task: worker } = await service.tasks.createTask({ title: "待转交任务", workspaceId: alpha.id, managerTaskId: top.id, column: "todo" });
    service.tasks.updateTask(other.id, { column: "review" });
    service.tasks.setManager(worker.id, other.id);
    expect(column(other)).toBe("doing");
    await until(() => column(top) === "review");
    expect(column(other)).toBe("doing");
    await service.tasks.archiveTask(worker.id);
    await until(() => column(other) === "review");
  });

  it("preserves a lead's submitted final delivery when an accepted child starts a read-only inquiry", async () => {
    const top = lead();
    const worker = child(top);
    const main = await service.tasks.addSession(top.id, { profileId: "p-ds" });
    const execution = await service.tasks.addSession(worker.id, { profileId: "p-ds" });
    service.sessions.inbox.pause(main.id);
    const delivery = service.orchestration.submit(execution.id, "实现完成", "测试通过");
    service.orchestration.review(main.id, delivery.id, true, "验收通过");
    const final = service.orchestration.submit(main.id, "最终汇总", "所有下级已验收");
    const inquiry = await service.tasks.addSession(worker.id, { profileId: "p-ds", text: "[[slow]] 只读查询", purpose: "inquiry" });
    const now = new Date().toISOString();
    const background = store.appendItem({ id: "readonly-background", sessionId: inquiry.id, type: "background", taskId: "readonly-query", command: "git status", state: "running", startedAt: now, createdAt: now });
    service.publish({ type: "item.appended", item: background });
    expect(column(top)).toBe("review");
    expect(service.orchestration.results(top.id).at(-1)).toMatchObject({ id: final.id, state: "submitted" });
    await service.sessions.interrupt(inquiry.id);
  });

  it("invalidates an old submitted final delivery when startup repairs its premature review column", async () => {
    const top = lead();
    const main = await service.tasks.addSession(top.id, { profileId: "p-ds" });
    service.sessions.inbox.pause(main.id);
    const final = service.orchestration.submit(main.id, "旧汇总", "旧证据");
    child(top, { column: "todo" });
    service.removeAllListeners("event");
    const rebuilt = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
    expect(column(top)).toBe("doing");
    expect(rebuilt.orchestration.results(top.id).at(-1)).toMatchObject({ id: final.id, state: "returned" });
  });

  it("reopens a completed lead when a new unfinished child is assigned", async () => {
    const top = lead();
    service.tasks.updateTask(top.id, { column: "done" });
    await service.tasks.createTask({ title: "新增待办", workspaceId: alpha.id, managerTaskId: top.id });
    expect(column(top)).toBe("doing");
  });
});

describe("放进待办 (2026-11-05)", () => {
  it("moves a waiting task into doing when its first session starts with work", async () => {
    const { task } = await service.tasks.createTask({ workspaceId: alpha.id, title: "待办主控", lead: true });
    const session = await service.tasks.addSession(task.id, { profileId: "p-ds", text: "[[slow]]" });
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(session.id);
    await until(() => column(task) === "review");
  });

  it("keeps the first sentence on the task (the title from its first line) until it is cleared", async () => {
    const { task, session } = await service.tasks.createTask({ workspaceId: alpha.id, firstMessage: "  改一下掉落表\n按新的稀有度分档  " });
    expect(session).toBeNull();
    expect(task).toMatchObject({ title: "改一下掉落表", column: "todo", firstMessage: "改一下掉落表\n按新的稀有度分档" });
    expect(store.getTask(task.id)!.firstMessage).toBe("改一下掉落表\n按新的稀有度分档");
    // The first session took it into its composer: the task lets it go.
    expect(service.tasks.updateTask(task.id, { firstMessage: "" }).firstMessage).toBeUndefined();
    expect(store.getTask(task.id)!.firstMessage).toBeUndefined();
    expect(() => service.tasks.updateTask(task.id, { firstMessage: 3 })).toThrow(/must be text/);
    // Started at once: nothing kept.
    const started = await service.tasks.createTask({ workspaceId: alpha.id, firstSession: { profileId: "p-ds", text: "直接开始" }, firstMessage: "不该留下" });
    expect(started.task.firstMessage).toBeUndefined();
  });

  it("files uploaded first-message images, validates them, and clears them with the first sentence", async () => {
    const images = ["before.png", "after.png"].map((name) => service.attachments.save(Buffer.from("image"), { name, mime: "image/png" }));
    const ids = images.map((image) => image.id);
    const { task, session } = await service.tasks.createTask({ workspaceId: alpha.id, firstMessage: { text: "比较这两张图", attachments: ids } });
    expect(session).toBeNull();
    expect(task).toMatchObject({ firstMessage: "比较这两张图", firstMessageAttachments: ids });
    expect(store.countItems([], [task.id]).attachmentIds).toEqual(ids);

    service.tasks.updateTask(task.id, { firstMessage: "" });
    expect(store.getTask(task.id)).not.toHaveProperty("firstMessage");
    expect(store.getTask(task.id)).not.toHaveProperty("firstMessageAttachments");
    expect(store.countItems([], [task.id]).attachmentIds).toEqual([]);
    const before = store.listTasks().length;
    await expect(service.tasks.createTask({ workspaceId: alpha.id, firstMessage: { text: "图片", attachments: ["att-00000000-0000-0000-0000-000000000000"] } })).rejects.toThrow(/attachment .* not found/);
    expect(store.listTasks()).toHaveLength(before);
  });
});

describe("进行中 ⇄ 待审阅", () => {
  it("reopens a completed task when the person sends another message, then moves it to 待审阅 when the turn ends", async () => {
    const task = store.createTask({ title: "继续已完成任务", workspaceId: alpha.id, column: "doing" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(s.id, "第一轮");
    await until(() => column(task) === "review");
    service.tasks.updateTask(task.id, { column: "done" });

    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => status(s.id) === "running");
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(s.id);
    await until(() => column(task) === "review");
  });

  it("goes to 待审阅 once the turn is over, and back to 进行中 when the person talks to it again", async () => {
    const task = store.createTask({ title: "改表", workspaceId: alpha.id, column: "doing" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => status(s.id) === "running");
    await pause(250);
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(s.id);
    await until(() => column(task) === "review");

    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => column(task) === "doing");
    await service.sessions.interrupt(s.id);
    await until(() => column(task) === "review");
  });

  it("stays 进行中 while another session of the task still works", async () => {
    const task = store.createTask({ title: "两个会话", workspaceId: alpha.id, column: "doing" });
    const a = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    const b = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(a.id, "[[slow]]");
    await service.sessions.sendMessage(b.id, "很快答完");
    await until(() => status(a.id) === "running");
    await until(() => status(b.id) === "idle" || status(b.id) === "completed");
    await pause(300);
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(a.id);
    await until(() => column(task) === "review");
  });

  it("leaves 待办 and the scheduler's task alone, and a card the person moved until a session starts or stops", async () => {
    const todo = store.createTask({ title: "待办", workspaceId: alpha.id, column: "todo" });
    const d = await service.tasks.addSession(todo.id, { profileId: "p-ds" });
    const scheduler = store.createTask({ title: "调度", workspaceId: alpha.id, column: "doing" });
    store.setKv(SCHEDULER_TASK_KEY, scheduler.id);
    const sch = await service.tasks.addSession(scheduler.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(d.id, "再看一眼");
    await service.sessions.sendMessage(sch.id, "排一下");
    await until(() => status(d.id) === "idle" && status(sch.id) === "idle");
    await pause(300);
    expect(column(todo)).toBe("todo");
    expect(column(scheduler)).toBe("doing");

    // Moved back to 进行中 by the person while nothing runs: it stays there; renaming a session changes nothing.
    const task = store.createTask({ title: "手动", workspaceId: alpha.id, column: "review" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    service.tasks.updateTask(task.id, { column: "doing" });
    await service.sessions.renameSession(s.id, "改个名");
    await pause(300);
    expect(column(task)).toBe("doing");
  });

  it("reopens completed work when a new session starts, but keeps a task manually completed during a running turn", async () => {
    const task = store.createTask({ title: "新会话继续", workspaceId: alpha.id, column: "done" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds", text: "[[slow]]" });
    await until(() => status(s.id) === "running");
    expect(column(task)).toBe("doing");
    service.tasks.updateTask(task.id, { column: "done" });
    await service.sessions.renameSession(s.id, "继续运行中");
    await pause(250);
    expect(column(task)).toBe("done");
    await service.sessions.interrupt(s.id);
    await pause(250);
    expect(column(task)).toBe("done");
  });
});
