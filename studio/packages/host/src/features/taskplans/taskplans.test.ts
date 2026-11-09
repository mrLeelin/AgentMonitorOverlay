import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { roleCardFor } from "../guide/role.js";

// Stage 16: a 主控 proposes splitting the work into tasks; the person accepts (changed) or dismisses it.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-gpt", label: "GPT Sol", runtime: "codex", provider: "amo-ds", model: "gpt-sol" },
  { id: "p-plain", label: "Plain", runtime: "codex", provider: "amo-plain", model: null },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let events: HostEvent[];
let alpha: Workspace;
let beta: Workspace;
let topic: Topic;
let leadTask: Task;
let leadSession: Session;
let worker: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-taskplans-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  events = [];
  service.on("event", (e) => events.push(e));
  for (const name of ["alpha", "beta"]) mkdirSync(join(root, name));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  beta = store.addWorkspace({ path: join(root, "beta"), name: "beta" });
  topic = service.topics.createTopic({ title: "迁移" });
  leadTask = store.createTask({ title: "迁移主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  const workerTask = store.createTask({ title: "执行", workspaceId: alpha.id, topicId: topic.id });
  const session = (taskId: string) => store.createSession({ taskId, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: `thr-${taskId}` });
  leadSession = session(leadTask.id);
  worker = session(workerTask.id);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await servers.close();
  store.close();
  removeTempDir(root);
});

const proposal = {
  summary: "把装甲车迁到两个项目",
  tasks: [
    { key: "a", title: "装甲车数据", project: "alpha", description: "先迁数据", firstMessage: "迁装甲车的数据表", model: "GPT Sol" },
    { key: "b", title: "装甲车界面", project: "beta", dependsOn: ["a"] },
    { key: "c", title: "弹射闪电" },
  ],
};

/** Already-open proposals from an older Host remain editable and acceptable after upgrading. */
async function legacyProposal(input: Parameters<typeof service.taskPlans.propose>[1] = proposal) {
  const s = store.createSession({ ...leadSession, id: undefined, taskId: null, topicId: topic.id, runtimeRef: null });
  const plan = await service.taskPlans.propose(s.id, input);
  const pending = { ...plan, fromTaskId: leadTask.id, fromSessionId: leadSession.id };
  store.putTaskPlan(pending);
  return pending;
}

function acceptPrerequisite(taskId: string): void {
  const owner = store.listSessions({ taskId })[0]!;
  const result = service.orchestration.submit(owner.id, "前置完成", "隔离验证通过");
  service.orchestration.review(leadSession.id, result.id, true, "验收通过");
}

describe("task plans (拆任务提案)", () => {
  it("takes a proposal only from a 主控, and checks it", async () => {
    await expect(service.taskPlans.propose(worker.id, proposal)).rejects.toThrow(/只有主控/);
    await expect(service.taskPlans.propose(leadSession.id, { ...proposal, summary: " " })).rejects.toThrow(/summary/);
    await expect(service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", project: "nope" }] })).rejects.toThrow(/project nope/);
    await expect(service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", model: "nope" }] })).rejects.toThrow(/DS, GPT Sol/);
    await expect(service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ key: "a", title: "a", dependsOn: ["b"] }, { key: "b", title: "b", dependsOn: ["a"] }] })).rejects.toThrow(/cycle/);
    const plan = await service.taskPlans.propose(leadSession.id, proposal);
    expect(plan).toMatchObject({ topicId: topic.id, fromSessionId: leadSession.id, fromTaskId: leadTask.id, state: "accepted" });
    expect(plan.created).toHaveLength(3);
    expect(store.listSessions({ taskId: plan.created![0]!.taskId })).toHaveLength(1);
    expect(store.listSessions({ taskId: plan.created![1]!.taskId })).toHaveLength(0);
    expect(plan.tasks.map((t) => [t.key, t.workspaceId, t.profileId, t.dependsOn])).toEqual([
      ["a", alpha.id, "p-gpt", []],
      ["b", beta.id, "p-ds", ["a"]],
      ["c", alpha.id, "p-ds", []],
    ]);
    expect(service.taskPlans.list().map((p) => p.id)).toEqual([plan.id]);
    expect(events.some((e) => e.type === "taskplan.upserted")).toBe(true);
  });

  it("accepts it as changed: tasks with descriptions, on the canvas in a group per project, dependencies, and mail to the 主控", async () => {
    const plan = await legacyProposal();
    const accepted = await service.taskPlans.accept(plan.id, {
      run: false,
      tasks: [{ ...plan.tasks[0]!, title: "装甲车数据表" }, { ...plan.tasks[1]! }, { ...plan.tasks[2]!, include: false }],
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.created!.map((c) => c.key)).toEqual(["a", "b"]);
    const [data, ui] = accepted.created!.map((c) => store.getTask(c.taskId)!);
    // Left in 待办 (2026-11-05): the first message stays with the task for its first session.
    expect(data).toMatchObject({ title: "装甲车数据表", workspaceId: alpha.id, topicId: topic.id, managerTaskId: leadTask.id, column: "todo", description: "先迁数据", firstMessage: "迁装甲车的数据表" });
    expect(ui).toMatchObject({ title: "装甲车界面", workspaceId: beta.id, column: "todo" });
    expect(store.listSessions({ taskId: data!.id })).toEqual([]);
    const canvas = service.canvases.canvas(topic.id);
    expect(canvas.groups.map((g) => g.title).sort()).toEqual(["alpha", "beta"]);
    expect(canvas.nodes.filter((n) => n.kind === "task").map((n) => [n.kind === "task" && n.taskId, canvas.groups.find((g) => g.id === n.groupId)?.title])).toEqual([
      [data!.id, "alpha"],
      [ui!.id, "beta"],
    ]);
    expect(canvas.edges.map((e) => [e.from, e.to])).toEqual([[data!.id, ui!.id]]);
    const mail = service.collab.readMailFromSession(leadSession.id);
    expect(mail.at(-1)!.text).toContain("建了 2 个任务（1 个没有采用）");
    expect(mail.at(-1)!.text).toContain(data!.id);
    await expect(service.taskPlans.accept(plan.id, { run: false })).rejects.toThrow(/decided already/);
  });

  it("takes a particular model and an effort per task, checked as session_start's; the session starts with them; another account picked drops them (2026-10-26)", async () => {
    await expect(service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", model: "Plain", effort: "max" }] })).rejects.toThrow(/effort 只能是：low, high/);
    await expect(service.taskPlans.propose(leadSession.id, { summary: "x", tasks: [{ title: "a", effort: "high" }] })).rejects.toThrow(/没有思考强度可选/);
    const plan = await legacyProposal({
      summary: "用便宜的型号先做",
      tasks: [
        { key: "a", title: "慢慢查", model: "Plain/Fake Slow", firstMessage: "查一下" },
        { key: "b", title: "认真改", model: "Plain", effort: "LOW", firstMessage: "改一下" },
        { key: "c", title: "换个账号", model: "Plain", effort: "high", firstMessage: "看一下" },
      ],
    });
    expect(plan.tasks.map((t) => [t.profileId, t.options])).toEqual([
      ["p-plain", { model: "fake-slow" }],
      ["p-plain", { effort: "low" }],
      ["p-plain", { effort: "high" }],
    ]);
    const done = await service.taskPlans.accept(plan.id, { run: true, tasks: plan.tasks.map((t) => (t.key === "c" ? { ...t, profileId: "p-gpt" } : t)) });
    expect(done.state).toBe("accepted");
    const started = (title: string) => {
      const task = store.listTasks().find((t) => t.title === title)!;
      return store.listSessions({ taskId: task.id })[0]!;
    };
    expect(started("慢慢查")).toMatchObject({ profileId: "p-plain", options: { model: "fake-slow" } });
    expect(started("认真改")).toMatchObject({ profileId: "p-plain", options: { effort: "low" } });
    expect(started("换个账号").profileId).toBe("p-gpt");
    expect(started("换个账号").options.effort).toBeUndefined();
  });

  it("dismisses it with a note the 主控 reads", async () => {
    const plan = await legacyProposal();
    expect(service.taskPlans.dismiss(plan.id, { note: "先只做装甲车" })).toMatchObject({ state: "dismissed", note: "先只做装甲车" });
    expect(service.collab.readMailFromSession(leadSession.id).at(-1)!.text).toBe("人没有采用你的拆任务提案「把装甲车迁到两个项目」：先只做装甲车");
    expect(store.listTasks().length).toBe(2);
  });

  it("binds the proposing lead and description before the first session can read its role", async () => {
    const plan = await legacyProposal({ summary: "先验证归属", tasks: [{ key: "a", title: "执行", description: "执行范围", firstMessage: "开始" }] });
    const cards: string[] = [];
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner, workspace) => {
      expect(store.getTask(owner.taskId!)?.managerTaskId).toBe(leadTask.id);
      expect(store.getTask(owner.taskId!)?.description).toBe("执行范围");
      cards.push(roleCardFor(service, { ...owner, workspaceId: workspace.id, kind: "main", runtime: "codex" }));
      return store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, topicId: null, runtimeRef: null });
    });
    await service.taskPlans.accept(plan.id, { run: true });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain(`直属主控：${leadTask.title}（${leadTask.id}）`);
    expect(cards[0]).toContain("执行范围");
  });

  it("rejects a stale proposing lead before creating tasks or canvas groups", async () => {
    const plan = await legacyProposal();
    service.tasks.updateTask(leadTask.id, { lead: false });
    await expect(service.taskPlans.accept(plan.id, { run: true })).rejects.toThrow(/来源主控已失效/);
    expect(store.listTasks()).toHaveLength(2);
    expect(service.canvases.canvas(topic.id).groups).toEqual([]);
  });

  it("creates a domain lead before starting it, and starts dependents only after accepted work is done", async () => {
    const seen: Array<{ lead: boolean; manager: string | null | undefined }> = [];
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => {
      const task = store.getTask(owner.taskId!)!;
      seen.push({ lead: !!task.lead, manager: task.managerTaskId });
      return store.createSession({ ...leadSession, id: undefined, taskId: task.id, runtimeRef: null });
    });
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "分工", tasks: [
      { key: "art", title: "资源负责人", lead: true, firstMessage: "组织资源制作" },
      { key: "logic", title: "资源接入", dependsOn: ["art"], firstMessage: "接入资源" },
    ] });
    expect(seen).toEqual([{ lead: true, manager: leadTask.id }]);
    const first = plan.created![0]!.taskId, second = plan.created![1]!.taskId;
    service.tasks.updateTask(first, { column: "review" });
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: second })).toHaveLength(0);
    service.tasks.updateTask(first, { column: "done" });
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: second })).toHaveLength(0);
    acceptPrerequisite(first);
    await service.taskPlans.startReady();
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: second })).toHaveLength(1);
    expect(seen).toEqual([{ lead: true, manager: leadTask.id }, { lead: false, manager: leadTask.id }]);
  });

  it("resumes a persisted dependency queue without duplicating previously started tasks", async () => {
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "有前后置", tasks: [
      { key: "a", title: "先做" }, { key: "b", title: "后做", dependsOn: ["a"] },
    ] });
    const first = plan.created![0]!.taskId, second = plan.created![1]!.taskId;
    acceptPrerequisite(first);
    const { TaskPlansFeature } = await import("./service.js");
    const restored = new TaskPlansFeature(service);
    await restored.startReady();
    await restored.startReady();
    expect(store.listSessions({ taskId: first })).toHaveLength(1);
    expect(store.listSessions({ taskId: second })).toHaveLength(1);
  });

  it("rechecks waiting work for archiving, transfer and an already-created session before auto-starting", async () => {
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "等待前置验收", tasks: [
      { key: "a", title: "前置" },
      ...["archived", "transferred", "manual", "valid"].map((key) => ({ key, title: key, dependsOn: ["a"] })),
    ] });
    const id = (key: string) => plan.created!.find((item) => item.key === key)!.taskId;
    await service.tasks.archiveTask(id("archived"));
    const peer = store.createTask({ title: "另一个主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
    service.tasks.setManager(id("transferred"), peer.id);
    store.createSession({ ...leadSession, id: undefined, taskId: id("manual"), runtimeRef: null });
    service.tasks.updateTask(id("a"), { column: "review" });
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: id("valid") })).toHaveLength(0);
    acceptPrerequisite(id("a"));
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: id("archived") })).toHaveLength(0);
    expect(store.listSessions({ taskId: id("transferred") })).toHaveLength(0);
    expect(store.listSessions({ taskId: id("manual") })).toHaveLength(1);
    expect(store.listSessions({ taskId: id("valid") })).toHaveLength(1);
  });

  it("freezes the explicitly planned requirement before queuing and records actual prerequisite results", async () => {
    vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
    const draft = service.sharedContext.save(leadSession.id, { rootTaskId: leadTask.id, title: "共同需求", baseRevision: 0, body: "三枚投币", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户目标" }] });
    const first = service.sharedContext.publishVersion(leadSession.id, draft.id, draft.revision);
    const contextBasis = { contextId: first.id, version: 1 };
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "按一版派工", tasks: [
      { key: "a", title: "前置资源", contextBasis }, { key: "b", title: "后置集成", contextBasis, dependsOn: ["a"] },
    ] });
    const a = plan.created![0]!.taskId, b = plan.created![1]!.taskId;
    const changed = service.sharedContext.save(leadSession.id, { rootTaskId: leadTask.id, title: "共同需求", baseRevision: first.revision, body: "五枚投币", changeNote: "调整数量", sources: [{ kind: "user_requirement", source: "用户调整" }] });
    service.sharedContext.publishVersion(leadSession.id, changed.id, changed.revision);
    expect(service.sharedContext.binding(b)?.version).toBe(1);
    expect(store.listSessions({ taskId: b })).toHaveLength(0);
    const worker = store.listSessions({ taskId: a })[0]!;
    service.sharedContext.getForSession(worker.id);
    service.sharedContext.adopt(worker.id, contextBasis);
    acceptPrerequisite(a);
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: b })).toHaveLength(1);
    expect(service.sharedContext.binding(b)?.version).toBe(1);
    expect(service.sharedContext.prerequisites(b)).toEqual([service.orchestration.results(a).at(-1)!.id]);
  });

  it("does not start a bound dependent with an accepted prerequisite from the wrong version", async () => {
    vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
    const draft = service.sharedContext.save(leadSession.id, { rootTaskId: leadTask.id, title: "共同需求", baseRevision: 0, body: "三枚投币", changeNote: "初版", sources: [{ kind: "user_requirement", source: "用户目标" }] });
    const first = service.sharedContext.publishVersion(leadSession.id, draft.id, draft.revision);
    const changed = service.sharedContext.save(leadSession.id, { rootTaskId: leadTask.id, title: "共同需求", baseRevision: first.revision, body: "五枚投币", changeNote: "调整数量", sources: [{ kind: "user_requirement", source: "用户调整" }] });
    service.sharedContext.publishVersion(leadSession.id, changed.id, changed.revision);
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "版本不同的分工", tasks: [
      { key: "a", title: "前置资源", contextBasis: { contextId: first.id, version: 1 } },
      { key: "b", title: "后置集成", contextBasis: { contextId: first.id, version: 2 }, dependsOn: ["a"] },
    ] });
    const a = plan.created![0]!.taskId, b = plan.created![1]!.taskId, worker = store.listSessions({ taskId: a })[0]!;
    service.sharedContext.getForSession(worker.id);
    service.sharedContext.adopt(worker.id, { contextId: first.id, version: 1 });
    acceptPrerequisite(a);
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: b })).toHaveLength(0);
    service.tasks.updateTask(a, { column: "doing" });
    service.sharedContext.apply(leadSession.id, { contextId: first.id, version: 2, taskIds: [a] });
    service.sharedContext.getForSession(worker.id);
    service.sharedContext.adopt(worker.id, { contextId: first.id, version: 2 });
    acceptPrerequisite(a);
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: b })).toHaveLength(1);
  });

  it("revokes old queued dispatch when its manager subtree transfers away and back", async () => {
    vi.spyOn(service.sessions.inbox, "put").mockResolvedValue({ delivered: true, waiting: 0 });
    vi.spyOn(service.tasks, "startSession").mockImplementation(async (owner) => store.createSession({ ...leadSession, id: undefined, taskId: owner.taskId, runtimeRef: null }));
    const top = store.createTask({ title: "原管理根", workspaceId: alpha.id, topicId: topic.id, lead: true });
    const other = store.createTask({ title: "另一个管理根", workspaceId: alpha.id, topicId: topic.id, lead: true });
    service.tasks.setManager(leadTask.id, top.id);
    const plan = await service.taskPlans.propose(leadSession.id, { summary: "排队派工", tasks: [
      { key: "a", title: "前置" }, { key: "b", title: "等待前置", dependsOn: ["a"] },
    ] });
    const a = plan.created![0]!.taskId, b = plan.created![1]!.taskId;
    service.tasks.setManager(leadTask.id, other.id);
    service.tasks.setManager(leadTask.id, top.id);
    acceptPrerequisite(a);
    await service.taskPlans.startReady();
    expect(store.listSessions({ taskId: b })).toHaveLength(0);
    expect(JSON.parse(store.getKv("taskplans.pending-starts")!.value)[b]).toBeUndefined();
  });
});
