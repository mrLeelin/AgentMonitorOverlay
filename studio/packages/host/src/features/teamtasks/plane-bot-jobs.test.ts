import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dpapi } from "@amo-studio/account";
import { PLANE_BOARD_API, type ModelProfile, type PlaneBotExecutionChoice } from "@amo-studio/protocol";
import { removeTempDir, startFakeAppServer } from "@amo-studio/testkit";
import { afterEach, expect, it, vi } from "vitest";
import * as gitReview from "../gitreview/git.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { PlaneBoardSettings } from "./plane-settings.js";
import { amoToolsFor } from "../../mcp/tools.js";

const origin = "https://plane.test";
const project = "71eac826-1d93-4182-9832-b640d4ca1369";
const itemId = "21eac826-1d93-4182-9832-b640d4ca1369";
const otherItemId = "31eac826-1d93-4182-9832-b640d4ca1369";
const projectPath = `/workspaces/demo/projects/${project}`;
const source = origin + PLANE_BOARD_API + projectPath;
const viewerId = "plane-account";
const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test" }];
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function start(root: string) {
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(profiles);
  const host = new HostService(store, new CodexRuntime({ store, servers, profiles }), profiles, { commonDir: join(root, "common") });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await servers.close();
    store.close();
  };
  cleanup.push(close);
  return { host, store, servers, close, jobs: host.teamTasks.planeBots };
}

function gitAt(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" }).trim();
}

function prepare(transport?: "overlay" | "native", projectSubdir?: string) {
  const root = mkdtempSync(join(tmpdir(), "amo-studio-test-plane-bot-"));
  cleanup.push(() => { removeTempDir(root); });
  const repo = join(root, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => gitAt(repo, ...args);
  git("init", "--quiet", "-b", "main");
  const projectDir = projectSubdir ? join(repo, projectSubdir) : repo;
  if (projectSubdir) mkdirSync(projectDir);
  writeFileSync(join(projectDir, "fixture.txt"), "committed");
  gitAt(projectDir, "add", "fixture.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");

  let account = viewerId;
  vi.spyOn(PlaneBoardSettings.prototype, "current", "get").mockImplementation(() => ({
    server: origin, sealed: "fixture-encrypted-key", selected: { workspace: "demo", project }, identityId: account,
  }));
  vi.spyOn(dpapi, "unprotect").mockResolvedValue("fixture-plane-key");
  const item = { id: itemId, number: "DEMO-3", title: "修正处理流程", description: "工单详情。".repeat(800), url: origin + "/demo/browse/DEMO-3/", creator: "测试成员", archived: false };
  const comments = new Map<string, string>();
  const commentIds = new Map<string, string>();
  const writes: string[] = [];
  const writeTargets = new Map<string, string>();
  const lookups: string[] = [];
  const nativeComments = origin + "/api/v1" + projectPath;
  let receiptVisible = false;
  const fetchPlane = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-plane-key");
    const url = String(input);
    const target = [itemId, otherItemId].find((id) => url.includes(`/work-items/${id}`));
    if (url === source + "/work-items") return Response.json({ viewerId: account, writable: true });
    if (target && url === source + `/work-items/${target}` && init?.method === "GET") return Response.json(target === itemId ? item : { ...item, id: target, number: "DEMO-4", title: "另一张 Plane 工单" });
    if (transport && target && url === source + `/work-items/${target}` && init?.method === "POST") {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ action: "bot-comment", viewerId });
      if (transport === "native") return Response.json({ message: "不支持的工作项操作" }, { status: 400 });
      writes.push(body.resultId);
      writeTargets.set(body.resultId, target);
      if (comments.has(body.resultId)) return Response.json({ id: commentIds.get(body.resultId) });
      const otherComments = [...comments.keys()].filter((key) => writeTargets.get(key) === target).length;
      commentIds.set(body.resultId, otherComments ? `plane-comment-${otherComments + 1}` : "plane-comment");
      comments.set(body.resultId, body.text);
      throw new Error("connection lost after Plane created the comment");
    }
    if (transport && target && url.startsWith(nativeComments)) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body).toMatchObject({ access: "INTERNAL", external_source: "AMO Studio" });
        writes.push(body.external_id);
        writeTargets.set(body.external_id, target);
        comments.set(body.external_id, body.comment_html);
        commentIds.set(body.external_id, "plane-comment");
        throw new Error("connection lost after Plane created the comment");
      }
      lookups.push(target);
      const cursor = new URL(url).searchParams.get("cursor");
      if (!cursor) return Response.json({ results: [], next_page_results: true, next_cursor: "next" });
      expect(cursor).toBe("next");
      const results = receiptVisible ? [...comments.keys()].filter((id) => writeTargets.get(id) === target).map((id) => ({ id: commentIds.get(id), actor: viewerId, external_id: id, external_source: "AMO Studio" })) : [];
      return Response.json({ results, next_page_results: false, next_cursor: null });
    }
    throw new Error(`Unexpected Plane request ${url}`);
  });

  const instance = start(root);
  const { host, store } = instance;
  const workspace = store.addWorkspace({ name: "Git 夹具", path: projectDir });
  const bot = host.bots.save({ name: "审核员", purpose: "审查并计划", memory: "", profileId: "test", workspaceId: null, enabled: true });
  const request = { botId: bot.id, workspaceId: workspace.id, source, viewerId };
  return { ...instance, root, repo, git, workspace, bot, item, request, comments, writes, writeTargets, lookups, fetchPlane, switchAccount: (id: string) => { account = id; }, revealReceipt: () => { receiptVisible = true; } };
}

const approvalTarget = { source, viewerId };
const waitOptions = { timeout: 10_000 };

async function waitForPlan(jobs: HostService["teamTasks"]["planeBots"], id = itemId) {
  return vi.waitFor(async () => {
    const job = await jobs.forItem(id);
    expect(job).toMatchObject({ state: "awaiting-approval", plan: expect.any(String), planHash: expect.any(String), baseCommit: expect.any(String), behind: expect.any(Number) });
    return { text: job!.plan!, planHash: job!.planHash!, baseCommit: job!.baseCommit! };
  }, waitOptions);
}

async function waitForWorker(jobs: HostService["teamTasks"]["planeBots"], store: Store) {
  return vi.waitFor(async () => {
    const job = await jobs.forItem(itemId);
    expect(job).toMatchObject({ taskId: expect.any(String) });
    const worker = store.listSessions({ taskId: job!.taskId! })[0];
    expect(worker?.status).toBe("idle");
    return worker!;
  }, waitOptions);
}

async function dispatchForReview({ jobs, host, store, request }: ReturnType<typeof prepare>) {
  await jobs.intake(itemId, request);
  const plan = await waitForPlan(jobs);
  const [analysis] = host.bots.requests(null);
  await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash });
  const worker = await waitForWorker(jobs, store);
  // These fixtures submit the delivery explicitly after the fake worker's two text-only turns settle.
  await vi.waitFor(async () => {
    expect(store.findItems(worker.id, "turn", {}, { newest: true, limit: 1 })[0]).toMatchObject({ state: "completed" });
    expect(store.getSession(worker.id)?.status).toBe("idle");
    expect(await jobs.forTask(worker.taskId!)).toMatchObject({ state: "failed", canRetry: true });
  }, waitOptions);
  return { worker, analysis: analysis!, plan, taskId: worker.taskId! };
}

it("continues an approved worker that ended without a delivery in the same worktree", async () => {
  const { jobs, host, store, servers, repo, request, git, writes, bot } = prepare();
  const turns: Array<{ thread: string; cwd: string; text: string }> = [];
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    if (ctx.thread.cwd === repo) return ctx.agentMessage("修正 fixture.txt 并验证。");
    turns.push({ thread: ctx.thread.id, cwd: ctx.thread.cwd, text: ctx.userText });
    if (turns.length === 1) return ctx.agentMessage("只找到了工具目录，这轮没有读取原单或修改文件。");
    const worker = store.listSessions().find((session) => session.runtimeRef === ctx.thread.id)!;
    await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
    writeFileSync(join(ctx.thread.cwd, "fixture.txt"), "worker correction");
    host.orchestration.submit(worker.id, "已修正 fixture.txt", "检查了工作树差异");
    await ctx.agentMessage("已提交交付。");
  } }));

  await jobs.intake(itemId, request);
  const plan = await waitForPlan(jobs);
  const [botJob] = await jobs.forBot(bot.id);
  expect(await jobs.attention()).toMatchObject([{ id: botJob!.jobId, botName: bot.name, botSessionId: botJob!.botSessionId, state: "awaiting-approval" }]);
  await expect(jobs.decideForBot("other-bot", botJob!.jobId!, { approve: true, planHash: plan.planHash })).rejects.toMatchObject({ code: "bad_request" });
  await jobs.decideForBot(bot.id, botJob!.jobId!, { approve: true, planHash: plan.planHash });
  await vi.waitFor(async () => expect(await jobs.forItem(itemId)).toMatchObject({
    state: "review", delivery: { summary: "已修正 fixture.txt" },
  }), waitOptions);

  expect(turns).toHaveLength(2);
  expect(turns[1]).toMatchObject({ thread: turns[0]!.thread, cwd: turns[0]!.cwd });
  expect(turns[0]!.text).toContain("工单详情。");
  expect(turns[0]!.text).not.toContain("请勿修改文件、写入外部系统或创建任务");
  expect(turns[1]!.text).toContain("task_submit_result");
  expect(gitAt(turns[0]!.cwd, "rev-parse", "HEAD")).toBe(plan.baseCommit);
  expect(git("status", "--short")).toBe("");
  expect(writes).toEqual([]);
}, 15_000);

it("waits for a worker's business decision and continues on the answer", async () => {
  const { jobs, host, store, servers, repo, request } = prepare();
  let decisionId: string | undefined;
  const turns: string[] = [];
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    if (ctx.thread.cwd === repo) return ctx.agentMessage("确认文件中的称呼后修改。");
    turns.push(ctx.userText);
    const worker = store.listSessions().find((session) => session.runtimeRef === ctx.thread.id)!;
    if (!decisionId) {
      decisionId = host.collab.requestDecisionFromSession(worker.id, "使用哪个称呼？", ["甲", "乙"]).id;
      return ctx.agentMessage("等待答复。");
    }
    await vi.waitFor(() => expect(store.getSession(worker.id)?.status).toBe("running"));
    host.orchestration.submit(worker.id, "按用户答复处理", "已验证");
    await ctx.agentMessage("已提交交付。");
  } }));

  await jobs.intake(itemId, request);
  const plan = await waitForPlan(jobs);
  await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash });
  await vi.waitFor(async () => {
    const job = await jobs.forItem(itemId);
    expect(job).toMatchObject({ state: "awaiting-user", decisions: [{ id: decisionId, question: "使用哪个称呼？" }] });
    expect(store.listSessions({ taskId: job!.taskId! })[0]?.status).toBe("idle");
  }, waitOptions);
  expect(turns).toHaveLength(1);
  expect(store.getDecision(decisionId!)).toMatchObject({ state: "open", question: "使用哪个称呼？" });
  host.collab.answerDecision(decisionId!, "甲");
  await vi.waitFor(async () => expect(await jobs.forItem(itemId)).toMatchObject({
    state: "review", delivery: { summary: "按用户答复处理" },
  }), waitOptions);
  expect(turns).toHaveLength(2);
  expect(turns[1]).toContain("我的决定：甲");
}, 15_000);

it("keeps a worker paused when the person stops it", async () => {
  const { jobs, host, store, servers, repo, request } = prepare();
  let workerTurns = 0;
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    if (ctx.thread.cwd === repo) return ctx.agentMessage("拟定处理计划。");
    workerTurns++;
    await ctx.sleep(5_000);
    await ctx.agentMessage("这是被停止的执行回合。");
  } }));
  await jobs.intake(itemId, request);
  const plan = await waitForPlan(jobs);
  await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash });
  const worker = await vi.waitFor(async () => {
    const job = await jobs.forItem(itemId);
    const active = job?.taskId ? store.listSessions({ taskId: job.taskId })[0] : undefined;
    expect(active?.status).toBe("running");
    return active!;
  }, waitOptions);
  await host.sessions.interrupt(worker.id);
  await vi.waitFor(async () => {
    expect(store.getSession(worker.id)?.status).toBe("idle");
    expect(await jobs.forItem(itemId)).toMatchObject({ state: "paused" });
  }, waitOptions);
  expect(workerTurns).toBe(1);
  expect(host.sessions.inbox.held(worker.id)).toEqual([]);
}, 15_000);

it("persists the analysis, waits for approval, and keeps the worker uncreated", async () => {
  const { jobs, host, git, request } = prepare();
  const baseCommit = git("rev-parse", "HEAD");
  expect(await jobs.intake(itemId, request)).toMatchObject({ state: "planning" });
  const plan = await waitForPlan(jobs);
  const [analysis] = host.bots.requests(null);
  expect(plan.text).toContain("DEMO-3");
  expect(plan.planHash).toBe(createHash("sha256").update(`${analysis!.id}\n${baseCommit}\n${plan.text}`).digest("hex"));
  expect(await jobs.forItem(itemId)).toMatchObject({ taskId: null, baseCommit, behind: 0 });
  expect(host.bots.sidebar().workers).toEqual([]);
}, 15_000);

it("declines without dispatching or writing to Plane and accepts a new analysis", async () => {
  const { jobs, host, git, repo, request, fetchPlane } = prepare();
  await jobs.intake(itemId, request);
  const { planHash } = await waitForPlan(jobs);
  const [previous] = host.bots.requests(null);
  const stalePlan = { code: "conflict", message: "计划已变更，请刷新后再决定。" };
  await expect(jobs.decline(itemId, approvalTarget as Parameters<typeof jobs.decline>[1])).rejects.toMatchObject(stalePlan);
  await expect(jobs.decline(itemId, { ...approvalTarget, planHash: "0".repeat(64) })).rejects.toMatchObject(stalePlan);
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", taskId: null, planHash });
  const decline = () => jobs.decline(itemId, { ...approvalTarget, planHash });
  expect(await decline()).toMatchObject({ state: "declined", taskId: null });
  expect(await decline()).toMatchObject({ state: "declined", taskId: null });
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "declined", botId: request.botId, workspaceId: request.workspaceId });
  expect(host.bots.sidebar().workers).toEqual([]);
  expect(fetchPlane.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);

  writeFileSync(join(repo, "fixture.txt"), "second revision");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "second revision");
  expect(await jobs.intake(itemId, request)).toMatchObject({ state: "planning" });
  await waitForPlan(jobs);
  const requests = host.bots.requests(null);
  expect(requests).toHaveLength(2);
  expect(requests.find(({ id }) => id !== previous!.id)).toMatchObject({ status: "completed" });
  expect(await jobs.forItem(itemId)).toMatchObject({ taskId: null, baseCommit: git("rev-parse", "HEAD"), behind: 0 });
  expect(host.bots.sidebar().workers).toEqual([]);
  expect(fetchPlane.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
}, 15_000);

it("rejects decisions from an earlier intake even when the new plan text and base are identical", async () => {
  const { jobs, host, store, servers, bot, request } = prepare();
  const text = "修正工单处理流程，补上验证记录。";
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    await ctx.agentMessage(text);
  } }));
  await jobs.intake(itemId, request);
  const previous = await waitForPlan(jobs);
  await jobs.decline(itemId, { ...approvalTarget, planHash: previous.planHash });
  await jobs.intake(itemId, request);
  const current = await waitForPlan(jobs);
  expect(current).toMatchObject({ text, baseCommit: previous.baseCommit });
  expect(previous.text).toBe(text);
  expect(current.planHash).not.toBe(previous.planHash);
  const staleDecision = { ...approvalTarget, planHash: previous.planHash };
  await expect(jobs.approve(itemId, staleDecision)).rejects.toMatchObject({ code: "conflict" });
  await expect(jobs.decline(itemId, staleDecision)).rejects.toMatchObject({ code: "conflict", message: "计划已变更，请刷新后再决定。" });
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", taskId: null, planHash: current.planHash });
  expect(host.bots.sidebar().workers).toEqual([]);
  await jobs.approve(itemId, { ...approvalTarget, planHash: current.planHash });
  const worker = await waitForWorker(jobs, store);
  expect(host.bots.sidebar().workers).toEqual([{ botId: bot.id, taskId: worker.taskId }]);
}, 15_000);

it("rejects a stale plan hash and dispatches only once across concurrent and repeated approvals", async () => {
  const { jobs, host, store, bot, request } = prepare();
  await jobs.intake(itemId, request);
  const { planHash } = await waitForPlan(jobs);
  await expect(jobs.approve(itemId, { ...approvalTarget, planHash: "0".repeat(64) })).rejects.toMatchObject({ code: "conflict" });
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", taskId: null });
  const approve = () => jobs.approve(itemId, { ...approvalTarget, planHash });
  await Promise.all([approve(), approve()]);
  const worker = await waitForWorker(jobs, store);
  expect(await approve()).toMatchObject({ taskId: worker.taskId });
  expect(host.bots.sidebar().workers).toEqual([{ botId: bot.id, taskId: worker.taskId }]);
  expect(store.listSessions({ taskId: worker.taskId! }).map(({ id }) => id)).toEqual([worker.id]);
}, 15_000);

it.each(["first launch", "launch retry"] as const)("dispatches from the intake commit on %s despite new project commits", async (launch) => {
  const { jobs, host, store, repo, git, request } = prepare();
  await jobs.intake(itemId, request);
  const { baseCommit, planHash } = await waitForPlan(jobs);
  writeFileSync(join(repo, "fixture.txt"), "new source revision");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "new source revision");
  expect(git("rev-parse", "HEAD")).not.toBe(baseCommit);
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", baseCommit, behind: 1 });

  if (launch === "launch retry") vi.spyOn(host.tasks, "startSession").mockRejectedValueOnce(new Error("fixture could not start the worker"));
  await jobs.approve(itemId, { ...approvalTarget, planHash });
  if (launch === "launch retry") {
    const taskId = await vi.waitFor(async () => {
      const job = await jobs.forItem(itemId);
      expect(job).toMatchObject({ state: "failed", taskId: expect.any(String), canRetry: true });
      return job!.taskId!;
    }, waitOptions);
    await jobs.retry(taskId);
    expect(await jobs.forItem(itemId)).toMatchObject({ taskId });
  }
  const worker = await waitForWorker(jobs, store);
  expect(gitAt(worker.cwd!, "rev-parse", "HEAD")).toBe(baseCommit);
  expect(readFileSync(join(worker.cwd!, "fixture.txt"), "utf8")).toBe("committed");
}, 15_000);

it("recovers pending plans without dispatch and resumes approval recorded before shutdown", async () => {
  const fixture = prepare();
  const { root, jobs, request } = fixture;
  await jobs.intake(itemId, request);
  const { planHash, baseCommit } = await waitForPlan(jobs);
  await fixture.close();

  const pending = start(root);
  const unexpectedWorker = vi.spyOn(pending.host.bots, "worker");
  expect(await pending.jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", taskId: null, planHash, baseCommit });
  expect(unexpectedWorker).not.toHaveBeenCalled();
  expect(pending.host.bots.sidebar().workers).toEqual([]);

  // Simulate a shutdown after the approval was saved and before the worker started.
  expect(pending.store.db.prepare("UPDATE plane_bot_jobs SET approved_at = ? WHERE item_id = ? AND task_id IS NULL").run(new Date().toISOString(), itemId).changes).toBe(1);
  await pending.close();
  const approved = start(root);
  const worker = await waitForWorker(approved.jobs, approved.store);
  expect(approved.host.bots.sidebar().workers).toEqual([{ botId: request.botId, taskId: worker.taskId }]);
  expect(gitAt(worker.cwd!, "rev-parse", "HEAD")).toBe(baseCommit);
}, 15_000);

it("creates one fresh analysis from the current commit when retrying a completed turn that returned no plan", async () => {
  const { jobs, host, store, servers, git, repo, request } = prepare();
  let turns = 0;
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    if (++turns === 2) await ctx.agentMessage("修正工单处理流程，补上验证记录。");
  } }));
  await jobs.intake(itemId, request);
  await vi.waitFor(async () => expect(await jobs.forItem(itemId)).toMatchObject({ state: "failed", canRetry: true, taskId: null }), waitOptions);
  const [previous] = host.bots.requests(null);
  expect(previous).toMatchObject({ status: "completed" });
  expect(previous?.result ?? "").toBe("");
  writeFileSync(join(repo, "fixture.txt"), "revision before retry");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "revision before retry");
  const head = git("rev-parse", "HEAD");
  await Promise.all([jobs.intake(itemId, request), jobs.intake(itemId, request)]);
  const plan = await waitForPlan(jobs);
  expect(plan).toMatchObject({ text: "修正工单处理流程，补上验证记录。", baseCommit: head });
  expect(await jobs.forItem(itemId)).toMatchObject({ behind: 0 });
  const requests = host.bots.requests(null);
  expect(requests).toHaveLength(2);
  expect(requests.find(({ id }) => id !== previous!.id)).toMatchObject({ status: "completed" });
  expect(host.bots.sidebar().workers).toEqual([]);
  await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash });
  const worker = await waitForWorker(jobs, store);
  expect(gitAt(worker.cwd!, "rev-parse", "HEAD")).toBe(head);
}, 15_000);

it("records the current commit when retrying an analysis that never started", async () => {
  const { jobs, host, git, repo, request } = prepare();
  vi.spyOn(host.bots, "request").mockRejectedValueOnce(new Error("fixture could not start the analysis"));
  await jobs.intake(itemId, request);
  await vi.waitFor(async () => expect(await jobs.forItem(itemId)).toMatchObject({ state: "failed", canRetry: true, taskId: null }), waitOptions);
  expect(host.bots.requests(null)).toEqual([]);
  writeFileSync(join(repo, "fixture.txt"), "revision before the analysis");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "revision before the analysis");
  await jobs.intake(itemId, request);
  expect(await waitForPlan(jobs)).toMatchObject({ baseCommit: git("rev-parse", "HEAD") });
  expect(host.bots.requests(null)).toHaveLength(1);
}, 15_000);

it("keeps the approved commit when retrying a worker that failed to start", async () => {
  const { jobs, host, store, git, repo, request } = prepare();
  await jobs.intake(itemId, request);
  const { baseCommit, planHash } = await waitForPlan(jobs);
  vi.spyOn(host.bots, "worker").mockRejectedValueOnce(new Error("fixture could not create the worker"));
  await jobs.approve(itemId, { ...approvalTarget, planHash });
  await vi.waitFor(async () => expect(await jobs.forItem(itemId)).toMatchObject({ state: "failed", canRetry: true, taskId: null }), waitOptions);
  writeFileSync(join(repo, "fixture.txt"), "revision after approval");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "revision after approval");
  await jobs.intake(itemId, request);
  const worker = await waitForWorker(jobs, store);
  expect(gitAt(worker.cwd!, "rev-parse", "HEAD")).toBe(baseCommit);
  expect(host.bots.requests(null)).toHaveLength(1);
}, 15_000);

it.each(["overlay", "native"] as const)("isolates execution, requires user acceptance, and recovers a lost %s comment response once", async (transport) => {
  const { root, repo, item, host, store, close, jobs, bot, workspace, request, writes, comments, fetchPlane, revealReceipt } = prepare(transport);
  writeFileSync(join(repo, "fixture.txt"), "source checkout is dirty");
  await expect(jobs.intake(itemId, { ...request, viewerId: "other" })).rejects.toThrow(/刷新/);
  const [first, second] = await Promise.all([jobs.intake(itemId, request), jobs.intake(itemId, request)]);
  expect(first.botId).toBe(second.botId);
  const { planHash } = await waitForPlan(jobs);
  await jobs.approve(itemId, { ...approvalTarget, planHash });
  const worker = await waitForWorker(jobs, store);
  const job = (await jobs.forItem(itemId))!;
  const id = worker.taskId!;
  const planning = store.getSession(job.botSessionId!);
  expect(planning).toMatchObject({ workspaceId: workspace.id, options: { permission: "read-only" } });
  expect(worker!.cwd).not.toBe(repo);
  expect(readFileSync(join(worker!.cwd!, "fixture.txt"), "utf8")).toBe("committed");
  expect(readFileSync(join(repo, "fixture.txt"), "utf8")).toBe("source checkout is dirty");
  expect(host.teamTasks.board.reference(id)).toMatchObject({ number: "DEMO-3", title: item.title });
  expect((await jobs.intake(itemId, request)).taskId).toBe(id);
  expect(host.bots.sidebar().workers).toEqual([{ botId: bot.id, taskId: id }]);
  expect(() => host.tasks.patchTask(id, { column: "done" })).toThrow(/验收/);

  host.sessions.inbox.pause(worker!.id);
  const submit = amoToolsFor(host, { sessionId: worker!.id }).find((tool) => tool.name === "task_submit_result")!;
  expect((await submit.run({ summary: "初稿", verification: "需补测试" })).isError).toBeFalsy();
  const draft = host.orchestration.results(id).at(-1)!;
  expect((await jobs.forTask(id))?.state).toBe("review");
  host.orchestration.reviewByUser(id, draft.id, false, "补充测试");
  await vi.waitFor(() => expect(store.getItem(`i-${draft.id}-return`)).toMatchObject({ text: expect.stringContaining("补充测试") }));
  expect(writes).toEqual([]);
  expect((await submit.run({ summary: "修复 <行为>", verification: "回归 A\n回归 B" })).isError).toBeFalsy();
  const accepted = host.orchestration.results(id).at(-1)!;
  host.orchestration.reviewByUser(id, accepted.id, true, "通过");
  await vi.waitFor(async () => expect(await jobs.forTask(id)).toMatchObject({ state: "failed", failureStage: "writeback", canRetry: true }));
  expect(comments.get(accepted.id)).toContain(transport === "native" ? "修复 &lt;行为&gt;" : "修复 <行为>");
  expect(comments.get(accepted.id)).toContain(transport === "native" ? "回归 A<br>回归 B" : "回归 A\n回归 B");
  expect(writes).toEqual([accepted.id]);

  if (transport === "native") {
    await jobs.retry(id);
    expect(await jobs.forTask(id)).toMatchObject({ state: "failed", error: expect.stringContaining("避免重复发送") });
    expect(writes).toEqual([accepted.id]);
  }
  revealReceipt();
  await close();
  const recovered = start(root).host.teamTasks.planeBots;
  await vi.waitFor(async () => expect((await recovered.forTask(id))?.state).toBe("sent"));
  expect(writes).toEqual([accepted.id]);
  expect(comments.size).toBe(1);
  await recovered.retry(id);
  expect(fetchPlane.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(transport === "native" ? 2 : 1);
}, 30_000);

function managedChoice(plan: { baseCommit: string }, operationId: string, topicId?: string): PlaneBotExecutionChoice {
  return { mode: "managed", operationId, baseCommit: plan.baseCommit, ...(topicId ? { topic: { topicId } } : {}) };
}

it("keeps a Plane root in progress when its first reply has no delivery and shows how to inspect uncommitted inputs", async () => {
  const { jobs, host, store, servers, workspace, request } = prepare();
  const stopped = "模型报告无法派工，未提交交付。";
  servers.fakes.set("test", await startFakeAppServer({ script: (ctx) => ctx.agentMessage(ctx.userText.includes("【用户批准的 Plane 计划") ? stopped : "检查原项目的未提交改动。") }));
  host.tasks.reviewSettleMs = 30;
  const movedToReview = vi.fn();
  host.on("event", (event) => {
    if (event.type === "task.upserted" && event.task.lead && event.task.column === "review") movedToReview();
  });
  await jobs.intake(itemId, request);
  const plan = await waitForPlan(jobs);
  writeFileSync(join(workspace.path, "fixture.txt"), "uncommitted input");
  const { rootTaskId } = await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash, execution: managedChoice(plan, "inspect-source") });
  const session = await vi.waitFor(() => {
    const current = store.getSession(host.botLeads.currentTerm(rootTaskId!)?.sessionId ?? "");
    expect(current?.status).toBe("idle");
    expect(store.findItems(current!.id, "agent")).toContainEqual(expect.objectContaining({ markdown: stopped }));
    return current!;
  }, waitOptions);
  await new Promise((resolve) => setTimeout(resolve, host.tasks.reviewSettleMs * 3));
  expect(movedToReview).not.toHaveBeenCalled();
  expect(store.getTask(rootTaskId!)?.column).toBe("doing");
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "executing" });
  expect(store.findItems(session.id, "user")).toContainEqual(expect.objectContaining({ text: expect.stringContaining("从上述批准的原项目目录只读取证") }));
  expect(host.orchestration.results(rootTaskId!)).toEqual([]);
  expect(host.tasks.updateTask(rootTaskId!, { column: "review" }).column).toBe("doing");

  // Existing cards advanced by the old timer should also recover without inventing a delivery.
  store.updateTask(rootTaskId!, { column: "review" });
  host.tasks.recoverColumns();
  expect(store.getTask(rootTaskId!)?.column).toBe("doing");

  const proposal = await host.taskPlans.propose(session.id, { summary: "原项目只读取证", tasks: [{ key: "inspect", title: "检查改动", firstMessage: `只读检查 ${workspace.path}` }] });
  const worker = await vi.waitFor(() => {
    const current = store.listSessions({ taskId: proposal.created![0]!.taskId })[0];
    expect(current?.status).toBe("idle");
    return current!;
  }, waitOptions);
  const at = (path: string) => readFileSync(join(path, "fixture.txt"), "utf8");
  expect(at(worker.cwd!)).toBe("committed");
  expect(at(workspace.path)).toBe("uncommitted input");
  const evidence = `只读核对原目录 ${workspace.path} 与 ${plan.baseCommit}`;
  const report = host.orchestration.submit(worker.id, "fixture.txt 存在未提交改动", evidence);
  host.orchestration.review(session.id, report.id, true, "核对过原目录证据");
  const final = await vi.waitFor(() => host.orchestration.submit(session.id, report.summary, evidence), waitOptions);
  expect(final.worktrees).toMatchObject([{ changedPaths: [], workingTreeDirty: false }]);
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "review", delivery: { resultId: final.id } });
}, 20_000);

it("keeps two Plane roots in one topic independent and binds each comment to its human-approved result", async () => {
  const { jobs, host, store, servers, workspace, request, writes, writeTargets, lookups, switchAccount, revealReceipt } = prepare("overlay");
  servers.fakes.set("test", await startFakeAppServer({ script: (ctx) => ctx.agentMessage("核对已批准的改动并验证。") }));
  const topic = host.topics.createTopic({ title: "同专题两张工单", workspaceIds: [workspace.id] });
  const incoming = { ...request, topicId: topic.id };
  await jobs.intake(itemId, incoming);
  const otherIntake = await jobs.intake(otherItemId, incoming);
  const plans = [await waitForPlan(jobs), await waitForPlan(jobs, otherItemId)];
  const approval = { ...approvalTarget, planHash: plans[0]!.planHash, execution: managedChoice(plans[0]!, "managed-first", topic.id) };
  const [first, replay] = await Promise.all([jobs.approve(itemId, approval), jobs.approve(itemId, approval)]);
  const other = await jobs.decideForBot(request.botId, otherIntake.jobId!, { approve: true, planHash: plans[1]!.planHash, execution: managedChoice(plans[1]!, "managed-other", topic.id) });
  expect(first).toMatchObject({ mode: "managed", taskId: null, rootTaskId: expect.any(String) });
  expect(first.rootTaskId).toBe(replay.rootTaskId);
  expect(first.rootTaskId).not.toBe(other.rootTaskId);
  expect(store.listTasks().filter((task) => task.topicId === topic.id && task.lead)).toHaveLength(2);
  expect(store.getCanvas(topic.id)?.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "task", taskId: first.rootTaskId }), expect.objectContaining({ kind: "task", taskId: other.rootTaskId })]));
  expect(host.botLeads.currentTerm(first.rootTaskId!)?.source).toMatchObject({ kind: "plane", jobId: first.jobId });
  await expect(jobs.approve(itemId, { ...approvalTarget, planHash: plans[0]!.planHash })).rejects.toThrow("专属主控");
  expect(writes).toEqual([]);

  async function ready(rootTaskId: string, workerName: string) {
    const lead = await vi.waitFor(() => {
      const session = store.getSession(host.botLeads.currentTerm(rootTaskId)?.sessionId ?? "");
      expect(session?.status).toBe("idle");
      return session!;
    }, waitOptions);
    const proposal = await host.taskPlans.propose(lead.id, { summary: "执行批准范围", tasks: [{ key: "worker", title: workerName, firstMessage: "执行并验证" }] });
    const worker = await vi.waitFor(() => {
      const task = proposal.created![0]!.taskId;
      const session = store.listSessions({ taskId: task })[0];
      expect(session?.status).toBe("idle");
      expect(session?.cwd).not.toBe(workspace.path);
      return session!;
    }, waitOptions);
    writeFileSync(join(worker.cwd!, workerName), "verified bytes in isolated checkout");
    const delivery = host.orchestration.submit(worker.id, "执行完成", "从工作树读取实际变更");
    host.orchestration.review(lead.id, delivery.id, true, "通过");
    const result = await vi.waitFor(() => host.orchestration.submit(lead.id, "根交付", "核对工作树和执行证据"), waitOptions);
    return { lead, worker, result };
  }
  const a = await ready(first.rootTaskId!, "first.txt");
  const b = await ready(other.rootTaskId!, "other.txt");
  expect(a.worker.cwd).not.toBe(b.worker.cwd);
  expect((await jobs.forTask(first.rootTaskId!))?.delivery).toMatchObject({ worktrees: [{ taskId: a.worker.taskId, changedPaths: ["first.txt"], changeDigest: expect.any(String), resultId: expect.any(String) }] });
  await jobs.check(first.rootTaskId!, a.result.id);
  await vi.waitFor(async () => expect(await jobs.forTask(first.rootTaskId!)).toMatchObject({ state: "review", check: { resultId: a.result.id, status: "completed" } }), waitOptions);
  expect(writes).toEqual([]);
  host.orchestration.reviewByUser(first.rootTaskId!, a.result.id, false, "补充整体验证");
  expect((await jobs.forTask(other.rootTaskId!))?.state).toBe("review");
  expect(writes).toEqual([]);
  switchAccount("other-plane-account");
  host.orchestration.reviewByUser(other.rootTaskId!, b.result.id, true, "用户通过另一张原单");
  await vi.waitFor(async () => expect(await jobs.forTask(other.rootTaskId!)).toMatchObject({ state: "failed", failureStage: "writeback", writeback: { resultId: b.result.id, state: "pending" } }));
  expect(writes).toEqual([]);
  switchAccount(viewerId);
  await jobs.retry(other.rootTaskId!);
  expect(writes).toEqual([b.result.id]);
  expect(writeTargets.get(b.result.id)).toBe(otherItemId);
  revealReceipt();
  await jobs.retry(other.rootTaskId!);
  expect(await jobs.forTask(other.rootTaskId!)).toMatchObject({ state: "sent", writebackHistory: [{ resultId: b.result.id, state: "sent", commentId: "plane-comment" }] });
  expect(writes).toEqual([b.result.id]);
  expect(lookups.every((target) => target === otherItemId)).toBe(true);

  const revised = await vi.waitFor(() => host.orchestration.submit(a.lead.id, "补齐后的根交付", "整体验证已补齐"), waitOptions);
  expect(revised.id).not.toBe(a.result.id);
  host.orchestration.reviewByUser(first.rootTaskId!, revised.id, true, "用户通过第一张原单");
  await vi.waitFor(async () => expect(await jobs.forTask(first.rootTaskId!)).toMatchObject({ state: "failed", failureStage: "writeback" }));
  await jobs.retry(first.rootTaskId!);
  expect(await jobs.forTask(first.rootTaskId!)).toMatchObject({ state: "sent", writeback: { resultId: revised.id, state: "sent" } });
  expect(writes).toEqual([b.result.id, revised.id]);
  expect(writeTargets.get(revised.id)).toBe(itemId);
  host.tasks.updateTask(other.rootTaskId!, { column: "doing" });
  const later = host.orchestration.submit(b.lead.id, "后续修订交付", "再次核对现有执行证据");
  await vi.waitFor(() => host.orchestration.reviewByUser(other.rootTaskId!, later.id, true, "用户通过后续修订"), waitOptions);
  await vi.waitFor(async () => expect(await jobs.forTask(other.rootTaskId!)).toMatchObject({ state: "failed", failureStage: "writeback" }));
  await jobs.retry(other.rootTaskId!);
  expect(await jobs.forTask(other.rootTaskId!)).toMatchObject({ writebackHistory: [
    { resultId: later.id, state: "sent", commentId: "plane-comment-2" },
    { resultId: b.result.id, state: "sent", commentId: "plane-comment" },
  ] });
  expect(host.orchestration.results(other.rootTaskId!).find((result) => result.id === b.result.id)?.userReview?.state).toBe("accepted");
  expect(writes).toEqual([b.result.id, revised.id, later.id]);
}, 60_000);

it("holds dependent work until its accepted commit is actually integrated and holds stale Git baselines for reapproval", async () => {
  const { jobs, host, store, servers, workspace, request, git, repo } = prepare();
  servers.fakes.set("test", await startFakeAppServer({ script: (ctx) => ctx.agentMessage("修改 fixture.txt 并在接入后验证。") }));
  await jobs.intake(itemId, request);
  const old = await waitForPlan(jobs);
  writeFileSync(join(repo, "fixture.txt"), "changed before approval");
  git("add", "--", "fixture.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "drift");
  await expect(jobs.approve(itemId, { ...approvalTarget, planHash: old.planHash, execution: managedChoice(old, "stale") })).rejects.toThrow("基准");
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "awaiting-approval", baseDrift: { head: git("rev-parse", "HEAD") } });
  expect(store.db.prepare("SELECT count(*) AS n FROM plane_bot_approvals").get()).toEqual({ n: 0 });
  const planJob = (await jobs.forItem(itemId))!;
  await jobs.replan(planJob.botId, planJob.jobId!, { planHash: old.planHash });
  const plan = await waitForPlan(jobs);
  expect(plan.baseCommit).not.toBe(old.baseCommit);
  expect(plan.planHash).not.toBe(old.planHash);
  const job = await jobs.approve(itemId, { ...approvalTarget, planHash: plan.planHash, execution: managedChoice(plan, "current") });
  const rootId = job.rootTaskId!;
  const lead = await vi.waitFor(() => {
    const session = store.getSession(host.botLeads.currentTerm(rootId)?.sessionId ?? "");
    expect(session?.status).toBe("idle");
    return session!;
  }, waitOptions);
  const wrongWorkspace = store.addWorkspace({ name: "未批准目录", path: repo + "-outside" });
  await expect(host.taskPlans.propose(lead.id, { summary: "越界派工", tasks: [{ title: "错误项目", project: wrongWorkspace.id }] })).rejects.toThrow("已批准范围");
  const proposal = await host.taskPlans.propose(lead.id, { summary: "逐项接入改动", tasks: [
    { key: "up", title: "产出代码", firstMessage: "修改文件" },
    { key: "down", title: "集成验证", firstMessage: "接入后运行验证", dependsOn: ["up"] },
  ] });
  const [up, down] = proposal.created!.map((row) => row.taskId) as [string, string];
  const firstWorker = await vi.waitFor(() => {
    const session = store.listSessions({ taskId: up })[0];
    expect(session?.status).toBe("idle");
    return session!;
  }, waitOptions);
  expect(store.listSessions({ taskId: down })).toHaveLength(0);
  writeFileSync(join(firstWorker.cwd!, "fixture.txt"), "actual change from the approved baseline\n");
  gitAt(firstWorker.cwd!, "add", "--", "fixture.txt");
  gitAt(firstWorker.cwd!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "worker change");
  const commit = gitAt(firstWorker.cwd!, "rev-parse", "HEAD");
  const submission = host.orchestration.submit(firstWorker.id, "上游改动", "实际提交与文件核验");
  expect(submission.worktrees?.[0]).toMatchObject({ headCommit: commit, baseCommit: plan.baseCommit, changedPaths: ["fixture.txt"], workingTreeDirty: false });
  host.orchestration.review(lead.id, submission.id, true, "通过");
  const waiting = await vi.waitFor(() => {
    const data = host.taskPlans.worktreeIntegrations(down);
    expect(data.waiting).toEqual([{ prerequisiteTaskId: up, prerequisiteResultId: submission.id }]);
    expect(data.worktree).not.toBeNull();
    return data.worktree!;
  }, waitOptions);
  const receipt = { operationId: "integrate", prerequisiteTaskId: up, prerequisiteResultId: submission.id, worktreeId: waiting.id, evidence: { kind: "commit" as const, commit } };
  expect(() => host.taskPlans.worktrees.add(down, receipt)).toThrow("已接入");
  expect(store.listSessions({ taskId: down })).toHaveLength(0);
  gitAt(waiting.cwd, "merge", "--ff-only", commit);
  expect(host.taskPlans.worktrees.add(down, receipt)).toMatchObject({ verification: "git" });
  expect(host.taskPlans.worktrees.add(down, receipt)).toMatchObject({ operationId: "integrate" });
  const secondWorker = await vi.waitFor(() => {
    const session = store.listSessions({ taskId: down })[0];
    expect(session?.status).toBe("idle");
    expect(store.findItems(session!.id, "turn", {}, { newest: true, limit: 1 })[0]).toMatchObject({ state: "completed" });
    return session!;
  }, waitOptions);
  expect(secondWorker.cwd).toBe(waiting.cwd);
  const integrated = host.orchestration.submit(secondWorker.id, "已集成提交", "实际工作树验证");
  expect(integrated.worktrees?.[0]?.integrations?.[0]).toMatchObject({ prerequisiteResultId: submission.id, verification: "git" });
  host.orchestration.review(lead.id, integrated.id, true, "通过");
  expect(store.getTask(down)?.column).toBe("done");
  expect(host.orchestration.results(down).at(-1)).toMatchObject({ state: "accepted", prerequisiteResultIds: [submission.id], planePlanHash: plan.planHash });
  expect(host.sharedContext.isResultCurrent(down, host.orchestration.results(down).at(-1)!)).toBe(true);
  const final = await vi.waitFor(() => host.orchestration.submit(lead.id, "已完成集成", "提交和工作树核验"), waitOptions);
  expect((await jobs.forTask(rootId))?.delivery).toMatchObject({ integratedWorktree: { taskId: down } });
  writeFileSync(join(secondWorker.cwd!, "fixture.txt"), "changes after the reviewed execution evidence");
  expect(() => host.orchestration.reviewByUser(rootId, final.id, true, "通过已变化的工作树")).toThrow("工作树改动与已提交的证据不同");
  writeFileSync(join(secondWorker.cwd!, "fixture.txt"), "actual change from the approved baseline\n");
  writeFileSync(join(repo, "fixture.txt"), "second drift");
  git("add", "--", "fixture.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "second drift");
  expect(() => host.orchestration.reviewByUser(rootId, final.id, true, "旧版通过")).toThrow("Git 基准已变化");
  const alternate = wrongWorkspace.path;
  mkdirSync(alternate);
  gitAt(alternate, "init", "--quiet", "-b", "main");
  writeFileSync(join(alternate, "alternate.txt"), "prepared new approved repository\n");
  gitAt(alternate, "add", "alternate.txt");
  gitAt(alternate, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "new approved repository");
  host.topics.updateTopic(job.topicId!, { workspaceIds: [workspace.id, wrongWorkspace.id] });
  await jobs.replan(job.botId, job.jobId!, { planHash: plan.planHash, workspaceId: wrongWorkspace.id });
  const newPlan = await waitForPlan(jobs);
  const revised = { ...approvalTarget, planHash: newPlan.planHash, execution: managedChoice(newPlan, "reapproval", job.topicId!) };
  await expect(jobs.approve(itemId, revised)).rejects.toThrow("归档旧版下级");
  await host.tasks.archiveTask(down);
  await host.tasks.archiveTask(up);
  const reapproved = await jobs.approve(itemId, revised);
  expect(reapproved).toMatchObject({ rootTaskId: rootId, mode: "managed", baseCommit: newPlan.baseCommit, workspaceId: wrongWorkspace.id });
  await vi.waitFor(() => {
    const term = host.botLeads.currentTerm(rootId), session = term?.sessionId ? store.getSession(term.sessionId) : undefined;
    expect(term).toMatchObject({ generation: 2, source: { kind: "plane", jobId: job.jobId } });
    expect(session).toMatchObject({ workspaceId: wrongWorkspace.id });
  }, waitOptions);
  expect(host.orchestration.results(up).at(-1)?.id).toBe(submission.id);
  await expect(host.tasks.unarchiveTask(up)).rejects.toThrow("旧版 Plane 计划");
  expect(store.db.prepare("SELECT count(*) AS n FROM plane_bot_approvals").get()).toEqual({ n: 2 });
}, 60_000);

it("shows the latest delivery without requesting a check, then checks in the original read-only Bot chat on demand", async () => {
  const fixture = prepare(undefined, "registered-project");
  const { host, store, jobs, bot, fetchPlane, item, repo, git } = fixture;
  writeFileSync(join(repo, "outside-project.txt"), "before analysis");
  git("add", "outside-project.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "outside project fixture");
  const { analysis, worker, taskId, plan } = await dispatchForReview(fixture);
  const cwd = worker.cwd!;
  writeFileSync(join(cwd, "fixture.txt"), "worker committed change");
  gitAt(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qam", "fixture delivery commit");
  writeFileSync(join(cwd, "..", "outside-project.txt"), "outside the registered project");
  writeFileSync(join(cwd, "new evidence.txt"), "untracked evidence");
  fetchPlane.mockClear();

  const summary = "交付摘要样本";
  const verification = "验证记录样本";
  const delivery = host.orchestration.submit(worker.id, summary, verification);
  const pending = { resultId: delivery.id, summary, verification, state: "submitted", sessionId: worker.id, baseCommit: plan.baseCommit };
  expect(await jobs.forItem(itemId)).toMatchObject({ item: { number: item.number, title: item.title }, state: "review", delivery: pending });
  expect(await jobs.forTask(taskId)).not.toHaveProperty("check");
  expect(await jobs.forBot(bot.id)).toMatchObject([{ itemId, delivery: pending }]);
  expect(await jobs.forBot("another-bot")).toEqual([]);
  expect(host.bots.requests(null).map(({ id }) => id)).toEqual([analysis.id]);

  const changedAfterSettlement = vi.fn();
  host.on("event", (event) => {
    if (event.type !== "plane.bot.changed" || event.itemId !== itemId || event.taskId !== taskId) return;
    const row = store.db.prepare("SELECT json_extract(data, '$.status') AS status FROM studio_bot_requests WHERE id = (SELECT check_request_id FROM plane_bot_jobs WHERE task_id = ?)").get(taskId);
    if (row?.status === "completed") changedAfterSettlement();
  });
  await jobs.check(taskId, delivery.id);
  await vi.waitFor(() => expect(changedAfterSettlement).toHaveBeenCalled(), waitOptions);
  const requests = host.bots.requests(null);
  expect(requests).toHaveLength(2);
  const check = requests.find(({ id }) => id !== analysis.id)!;
  expect(check).toMatchObject({ botId: bot.id, status: "completed", destination: { sessionId: analysis.sessionId }, sessionId: analysis.sessionId });
  expect(check.text.split("\n")[0]).toBe("对照检查 Plane 工作项 DEMO-3 的交付。");
  for (const expected of [plan.text, summary, verification, 'modified "fixture.txt"', 'untracked "new evidence.txt"', plan.baseCommit]) expect(check.text).toContain(expected);
  expect(check.text).not.toContain("registered-project/fixture.txt");
  expect(check.text).not.toContain("outside-project.txt");
  expect(check.text.length).toBeLessThan(20_000);
  expect(await jobs.forTask(taskId)).toMatchObject({ state: "review", delivery: pending, check: {
    resultId: delivery.id, status: "completed", opinion: check.result, taskId: analysis.taskId, sessionId: analysis.sessionId,
  } });
  expect(check.result?.trim()).toBeTruthy();
  expect(store.getSession(check.sessionId!)?.options.permission).toBe("read-only");
  expect(amoToolsFor(host, { sessionId: check.sessionId! }).map(({ name }) => name)).toEqual(["bot_group_ask"]);
  await expect(host.bots.worker(check.id)).rejects.toMatchObject({ code: "conflict" });
  expect(store.getTask(taskId)?.column).toBe("review");
  expect(host.orchestration.results(taskId)).toEqual([delivery]);
  expect(fetchPlane).not.toHaveBeenCalled();
  store.db.prepare("UPDATE sessions SET cwd = NULL WHERE id = ?").run(worker.id);
  expect(await jobs.forTask(taskId)).toMatchObject({ delivery: { ...pending, sessionId: null } });
}, 15_000);

it("shares concurrent clicks before the Bot request exists, retries a failed check, and reuses a completed opinion", async () => {
  const fixture = prepare();
  const { host, jobs, servers, fetchPlane } = fixture;
  let reviewTurns = 0;
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    if (!ctx.userText.includes("验收材料-并发")) return ctx.agentMessage("完成标准：工单可验收。");
    if (++reviewTurns === 1) throw new Error("对照检查夹具失败");
    await ctx.agentMessage("建议验收，依据充分。");
  } }));
  const { worker, taskId } = await dispatchForReview(fixture);
  const result = host.orchestration.submit(worker.id, "验收材料-并发", "已验证");
  fetchPlane.mockClear();
  const request = host.bots.request.bind(host.bots);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const firstLaunch = vi.spyOn(host.bots, "request").mockImplementationOnce(async (...args) => {
    await gate;
    return request(...args);
  });
  const clicks = Promise.all([jobs.check(taskId, result.id), jobs.check(taskId, result.id)]);
  try {
    await Promise.race([clicks, vi.waitFor(() => expect(firstLaunch).toHaveBeenCalledTimes(1), waitOptions)]);
    expect(host.bots.requests(null)).toHaveLength(1);
  } finally {
    release();
  }
  await clicks;
  const failed = await vi.waitFor(async () => {
    const job = await jobs.forTask(taskId);
    expect(job?.check).toMatchObject({ resultId: result.id, status: "failed", error: expect.any(String) });
    expect(job?.check).not.toHaveProperty("opinion");
    const requests = host.bots.requests(null);
    expect(requests).toHaveLength(2);
    return requests.find(({ status }) => status === "failed")!.id;
  }, waitOptions);
  expect(firstLaunch).toHaveBeenCalledTimes(1);
  await jobs.check(taskId, result.id);
  await vi.waitFor(async () => expect((await jobs.forTask(taskId))?.check).toMatchObject({ resultId: result.id, status: "completed", opinion: "建议验收，依据充分。" }), waitOptions);
  await jobs.check(taskId, result.id);
  expect(firstLaunch).toHaveBeenCalledTimes(2);
  const requests = host.bots.requests(null);
  expect(requests).toHaveLength(3);
  expect(requests.find(({ result: opinion }) => opinion === "建议验收，依据充分。")?.id).not.toBe(failed);
  expect(fetchPlane).not.toHaveBeenCalled();
}, 15_000);

it("hides the old opinion on a replacement delivery and rejects checks against the returned version", async () => {
  const fixture = prepare();
  const { host, jobs, fetchPlane } = fixture;
  const { worker, taskId } = await dispatchForReview(fixture);
  host.sessions.inbox.pause(worker.id);
  const first = host.orchestration.submit(worker.id, "交付初稿", "仍缺验证");
  fetchPlane.mockClear();
  await jobs.check(taskId, first.id);
  await vi.waitFor(async () => expect((await jobs.forTask(taskId))?.check).toMatchObject({ resultId: first.id, status: "completed", opinion: expect.any(String) }), waitOptions);
  host.orchestration.reviewByUser(taskId, first.id, false, "补充验证");
  const returned = await jobs.forTask(taskId);
  expect(returned).not.toHaveProperty("delivery");
  await expect(jobs.check(taskId, first.id)).rejects.toMatchObject({ code: "conflict" });

  const second = host.orchestration.submit(worker.id, "交付新版", "已补验证");
  const current = await jobs.forTask(taskId);
  expect(current).toMatchObject({ state: "review", delivery: { resultId: second.id } });
  expect(current).not.toHaveProperty("check");
  await expect(jobs.check(taskId, first.id)).rejects.toMatchObject({ code: "conflict" });
  expect(host.bots.requests(null)).toHaveLength(2);
  await jobs.check(taskId, second.id);
  await vi.waitFor(async () => expect((await jobs.forTask(taskId))?.check).toMatchObject({ resultId: second.id, status: "completed" }), waitOptions);
  expect(host.bots.requests(null)).toHaveLength(3);
  expect(fetchPlane).not.toHaveBeenCalled();
}, 15_000);

it("opens a new read-only chat when the original analysis chat is archived", async () => {
  const fixture = prepare();
  const { host, store, jobs, workspace } = fixture;
  const { worker, analysis, taskId } = await dispatchForReview(fixture);
  await vi.waitFor(() => expect(store.getSession(analysis.sessionId!)?.status).toBe("idle"), waitOptions);
  await host.sessions.archive(analysis.sessionId!);
  const delivery = host.orchestration.submit(worker.id, "交付：原分析已归档", "验证完成");
  await jobs.check(taskId, delivery.id);
  const check = await vi.waitFor(async () => {
    const job = await jobs.forTask(taskId);
    expect(job?.check).toMatchObject({ status: "completed", taskId: analysis.taskId, sessionId: expect.any(String) });
    return job!.check!;
  }, waitOptions);
  expect(check.sessionId).not.toBe(analysis.sessionId);
  expect(store.getSession(check.sessionId!)).toMatchObject({ workspaceId: workspace.id, options: { permission: "read-only" }, archivedAt: null });
}, 15_000);

it.each([{ enabled: false }, { permission: "workspace-write" }])("refuses a check when the planning Bot is no longer eligible (%j)", async (changes) => {
  const fixture = prepare();
  const { host, jobs, bot, fetchPlane } = fixture;
  const { worker, taskId } = await dispatchForReview(fixture);
  const delivery = host.orchestration.submit(worker.id, "交付：Bot 权限变更", "验证完成");
  host.bots.save({ ...bot, ...changes }, bot.id);
  fetchPlane.mockClear();
  await expect(jobs.check(taskId, delivery.id)).rejects.toMatchObject({ code: "bad_request" });
  expect(host.bots.requests(null)).toHaveLength(1);
  expect(await jobs.forTask(taskId)).not.toHaveProperty("check");
  expect(fetchPlane).not.toHaveBeenCalled();
}, 15_000);

it("revalidates the submitted delivery after Git reads before recording the check", async () => {
  const fixture = prepare();
  const { host, jobs, store } = fixture;
  const { worker, taskId } = await dispatchForReview(fixture);
  host.sessions.inbox.pause(worker.id);
  const delivery = host.orchestration.submit(worker.id, "会在读取 Git 时被退回", "仍缺验证");
  const realGit = gitReview.git;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const git = vi.spyOn(gitReview, "git").mockImplementation(async (cwd, args, ...options) => {
    if (cwd === worker.cwd && args[0] === "diff") await gate;
    return realGit(cwd, args, ...options);
  });
  const checking = expect(jobs.check(taskId, delivery.id)).rejects.toMatchObject({ code: "conflict" });
  try {
    await vi.waitFor(() => expect(git.mock.calls.some(([cwd, args]) => cwd === worker.cwd && args[0] === "diff")).toBe(true), waitOptions);
    host.orchestration.reviewByUser(taskId, delivery.id, false, "补充验证");
  } finally {
    release();
  }
  await checking;
  expect(host.bots.requests(null)).toHaveLength(1);
  expect(store.db.prepare("SELECT check_result_id, check_request_id FROM plane_bot_jobs WHERE task_id = ?").get(taskId))
    .toEqual({ check_result_id: null, check_request_id: null });
}, 15_000);

it("checks a legacy delivery with its original analysis and replaces an orphaned check request", async () => {
  const fixture = prepare();
  const { host, jobs, store } = fixture;
  const { worker, analysis, taskId } = await dispatchForReview(fixture);
  const cwd = worker.cwd!;
  writeFileSync(join(cwd, "committed-only.txt"), "already committed");
  gitAt(cwd, "add", "committed-only.txt");
  gitAt(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "legacy fixture commit");
  writeFileSync(join(cwd, "fixture.txt"), "uncommitted change");
  writeFileSync(join(cwd, "legacy evidence.txt"), "untracked evidence");
  const delivery = host.orchestration.submit(worker.id, "旧单交付", "验证完成");
  store.db.prepare("UPDATE plane_bot_jobs SET base_commit = NULL, plan = NULL, plan_hash = NULL, approved_at = NULL, check_result_id = ?, check_request_id = ? WHERE task_id = ?")
    .run(delivery.id, "missing-check-request", taskId);
  const pending = await jobs.forTask(taskId);
  expect(pending?.delivery).toMatchObject({ resultId: delivery.id, sessionId: worker.id });
  expect(pending?.delivery).not.toHaveProperty("baseCommit");
  expect(pending).not.toHaveProperty("check");
  await jobs.check(taskId, delivery.id);
  await vi.waitFor(async () => expect((await jobs.forTask(taskId))?.check).toMatchObject({ resultId: delivery.id, status: "completed" }), waitOptions);
  const requests = host.bots.requests(null);
  expect(requests).toHaveLength(2);
  const check = requests.find(({ id }) => id !== analysis.id)!;
  expect(check.id).not.toBe("missing-check-request");
  for (const expected of [analysis.result!, "fixture.txt", "legacy evidence.txt"]) expect(check.text).toContain(expected);
  expect(check.text).not.toContain("committed-only.txt");
  expect(check.text).not.toContain("基准提交：");
}, 15_000);

it("lists the newest twenty jobs for a Bot across Plane projects and accounts", async () => {
  const { jobs, store, request, fetchPlane } = prepare();
  const add = store.db.prepare(`INSERT INTO plane_bot_jobs
    (id, request_id, source, viewer_id, item_id, bot_id, workspace_id, prompt, item_data) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)`);
  for (let index = 0; index < 22; index++) {
    const item = { id: `item-${index}`, number: `OTHER-${index}`, title: `工单 ${index}`, creator: "夹具" };
    add.run(`job-${index}`, `request-${index}`, `https://other-plane.test/project-${index}`, `account-${index}`, item.id, request.botId, request.workspaceId, JSON.stringify(item));
  }
  add.run("different-job", "different-request", source, viewerId, itemId, "another-bot", request.workspaceId, JSON.stringify({ id: itemId, number: "OTHER", title: "另一个 Bot", creator: "夹具" }));
  const recent = await jobs.forBot(request.botId);
  expect(recent).toHaveLength(20);
  expect(recent.map(({ item }) => item.number)).toEqual(Array.from({ length: 20 }, (_, index) => `OTHER-${21 - index}`));
  expect(recent.every(({ botId }) => botId === request.botId)).toBe(true);
  expect(fetchPlane).not.toHaveBeenCalled();
});

it("resumes a completed analysis when Team Tasks is enabled again", async () => {
  const { jobs, host, servers, request } = prepare();
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  servers.fakes.set("test", await startFakeAppServer({ script: async (ctx) => {
    await waiting;
    await ctx.agentMessage("拟定计划和验证方法。");
  } }));
  try {
    await jobs.intake(itemId, request);
    await vi.waitFor(() => expect(host.bots.requests(null)[0]?.sessionId).toEqual(expect.any(String)), waitOptions);
    host.config.updateSettings({ teamTasksEnabled: false });
  } finally {
    finish();
  }
  await vi.waitFor(() => expect(host.bots.requests(null)[0]?.status).toBe("completed"), waitOptions);
  expect(await jobs.forItem(itemId)).toMatchObject({ state: "planning", taskId: null });
  host.config.updateSettings({ teamTasksEnabled: true });
  expect((await waitForPlan(jobs)).text).toBe("拟定计划和验证方法。");
  expect(host.bots.requests(null)).toHaveLength(1);
  expect(host.bots.sidebar().workers).toEqual([]);
}, 15_000);

it("starts another main session in the worker checkout and reviews the actual submitting session", async () => {
  const fixture = prepare();
  const { host, jobs, repo, store } = fixture;
  const { worker, taskId, plan } = await dispatchForReview(fixture);
  expect(() => host.tasks.updateTask(taskId, { workspaceId: null })).toThrow(/接单时的 Git 项目/);
  const { id: _id, createdAt: _created, updatedAt: _updated, archivedAt: _archived, cwd: _cwd, ...sessionFields } = worker;
  const old = store.createSession({ ...sessionFields, runtimeRef: null });
  expect(() => host.orchestration.submit(old.id, "旧会话交付", "结果写在了原目录")).toThrow(/独立工作树/);
  await host.runtime.archive(worker.id);

  const next = await host.tasks.addSession(taskId, { profileId: worker.profileId });
  expect(next.cwd).toBe(worker.cwd);
  expect(gitAt(next.cwd!, "rev-parse", "HEAD")).toBe(plan.baseCommit);
  writeFileSync(join(next.cwd!, "new.txt"), "worker delivery");
  const result = host.orchestration.submit(next.id, "新会话交付", "检查 new.txt");
  expect(await jobs.forTask(taskId)).toMatchObject({ state: "review", delivery: { resultId: result.id, sessionId: next.id, baseCommit: plan.baseCommit } });
  expect(gitAt(repo, "status", "--short")).toBe("");
}, 15_000);

it("rejects Plane worker promotion before changing sessions, including a saved request", async () => {
  const fixture = prepare();
  const { host, store } = fixture;
  const { worker, taskId } = await dispatchForReview(fixture);
  expect(() => host.tasks.leadPromotion.request(worker.id, "已检查现状，继续处理工单")).toThrow(/不能设为主控/);
  expect(host.tasks.leadPromotion.status(taskId)).toBeNull();
  store.setKv("tasks.lead-promotions", JSON.stringify({ [taskId]: {
    taskId, sourceSessionId: worker.id, state: "switching", oldSessionIds: [worker.id], summary: "旧的切换申请",
  } }));
  await host.botLeads.flush();
  expect(host.tasks.leadPromotion.status(taskId)).toMatchObject({ state: "switching", summary: "旧的切换申请" });
  expect(host.botLeads.taskView(taskId).state).toBeNull();
  expect(store.getSession(worker.id)?.archivedAt).toBeNull();
}, 15_000);

it("allows a fresh intake after the person permanently deletes the old worker", async () => {
  const fixture = prepare();
  const { host, jobs, request } = fixture;
  const { taskId, analysis } = await dispatchForReview(fixture);
  await host.tasks.archiveTask(taskId);
  host.data.purge("task", taskId);
  expect(await jobs.forTask(taskId)).toBeNull();
  expect(await jobs.forItem(itemId)).toBeNull();
  expect(await jobs.forBot(request.botId)).toEqual([]);
  await jobs.intake(itemId, request);
  await waitForPlan(jobs);
  expect(host.bots.requests(null)).toHaveLength(2);
  expect((await jobs.forItem(itemId))?.botSessionId).not.toBe(analysis.sessionId);
}, 15_000);
