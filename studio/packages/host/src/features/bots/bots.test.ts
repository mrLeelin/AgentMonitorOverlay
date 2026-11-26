import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
import type { ModelProfile } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

const profiles: ModelProfile[] = [{ id: "mock", label: "Mock", runtime: "codex", provider: null, model: null }];
const input = { name: "审核员", profileId: "mock", purpose: "Review changes", memory: "Read staged changes", workspaceId: null, enabled: true };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function start() {
  const root = mkdtempSync(join(tmpdir(), "amo-bots-test-"));
  const store = new Store(join(root, "studio.db"));
  const servers = new FakeServers(profiles);
  const runtime = new CodexRuntime({ store, servers, profiles });
  const host = new HostService(store, runtime, profiles, { commonDir: join(root, "common") });
  cleanup.push(async () => { host.duty.stop(); host.bots.webhooks.stop(); host.teamLink.stop(); await servers.close(); store.close(); await removeTempDir(root); });
  return { host, store, root };
}

it("preserves model and effort on older clients' saves and supports returning to channel defaults", () => {
  const { host } = start();
  const bot = host.bots.save({ ...input, model: "mock-model", effort: "high" });
  expect(host.bots.save(input, bot.id)).toMatchObject({ model: "mock-model", effort: "high" });
  expect(host.bots.save({ ...input, model: "other" }, bot.id)).toMatchObject({ model: "other", effort: null });
  expect(host.bots.save({ ...input, model: null, effort: null }, bot.id)).toMatchObject({ model: null, effort: null });
});

it("stores a square PNG avatar, preserves it on older input and resets it with null", () => {
  const { host } = start();
  const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYToAAAAASUVORK5CYII=";
  const bot = host.bots.save({ ...input, avatar });
  expect(host.bots.list()[0]?.avatar).toBe(avatar);
  expect(host.bots.save({ ...input, memory: "new" }, bot.id).avatar).toBe(avatar);
  expect(() => host.bots.save({ ...input, avatar: "data:image/svg+xml;base64,PHN2Zz4=" }, bot.id)).toThrow("头像格式无效");
  expect(host.bots.save({ ...input, avatar: null }, bot.id).avatar).toBeNull();
});

it("routes a request to the home once, ties the result to its own turn, and keeps the old chat on reset", async () => {
  const { host, store } = start();
  const bot = host.bots.save(input);
  const { session: source } = await host.tasks.createTask({ title: "Origin", firstSession: { profileId: "mock" } });
  const request = { id: "review-1", sourceSessionId: source!.id, text: "Review the fixture" };
  const [first, retry] = await Promise.all([host.bots.request(bot.id, request), host.bots.request(bot.id, request)]);
  expect(first.sessionId).toBeTruthy();
  expect(retry.sessionId).toBe(first.sessionId);
  expect(first.sessionId).not.toBe(source!.id);
  expect(host.bots.list()[0]?.homeSessionId).toBe(first.sessionId);
  await vi.waitFor(() => expect(host.bots.requests(source!.id)[0]).toMatchObject({ status: "completed", result: expect.any(String) }));
  expect(host.snapshot().tasks.find((task) => task.id === first.taskId)?.botId).toBe(bot.id);
  expect(host.bots.sidebar().previews[bot.id]).toBeTruthy();
  expect(store.findItems(first.sessionId!, "user")).toHaveLength(1);
  expect(store.findItems(source!.id, "turn")).toHaveLength(0);
  await expect(host.sessions.archive(first.sessionId!)).rejects.toThrow("主聊天");
  const changed = await host.sessions.updateSessionOptions(first.sessionId!, { permission: "full-auto" });
  expect(changed.options.permission).toBe("read-only");
  await expect(host.sessions.terminal(first.sessionId!, false)).rejects.toThrow("只读 Bot");
  const next = await host.bots.home(bot.id, true);
  expect(next.id).not.toBe(first.sessionId);
  expect(host.bots.chats(bot.id).map((chat) => chat.id)).toEqual(expect.arrayContaining([first.sessionId, next.id]));
  const previous = await host.bots.request(bot.id, { id: "review-2", destination: { sessionId: first.sessionId }, text: "Follow up on the fixture" });
  expect(previous.sessionId).toBe(first.sessionId);
  await vi.waitFor(() => expect(host.bots.requests(null).find((r) => r.id === "review-2")?.status).toBe("completed"));
});

it("keeps saved chats and blocks new Bot work while Bots is disabled", async () => {
  const { host } = start();
  const bot = host.bots.save(input);
  const home = await host.bots.home(bot.id);
  expect(host.config.settings().botsEnabled).toBe(true);
  expect(host.config.settings().confirmBotHomeReset).toBe(true);
  host.config.updateSettings({ botsEnabled: false, confirmBotHomeReset: false });
  expect(host.config.settings()).toMatchObject({ botsEnabled: false, confirmBotHomeReset: false });
  await expect(host.bots.home(bot.id)).rejects.toThrow("Bots 已关闭");
  await expect(host.sessions.sendMessage(home.id, "请继续")).rejects.toThrow("Bots 已关闭");
  await expect(host.bots.request(bot.id, { id: "disabled-request", text: "请核对" })).rejects.toThrow("Bots 已关闭");
  expect(host.bots.requests(null)).toHaveLength(0);
  expect(host.bots.chats(bot.id).map((chat) => chat.id)).toEqual([home.id]);
  host.config.updateSettings({ botsEnabled: true });
  expect((await host.bots.home(bot.id)).id).toBe(home.id);
});

it("lets only the originating agent dispatch a mention and delivers one reply back to its inbox", async () => {
  const { host, store } = start();
  const bot = host.bots.save(input);
  const { session } = await host.tasks.createTask({ title: "来源任务", firstSession: { profileId: "mock" } });
  const source = session!.id;
  const mention = { id: "picked-review", sourceSessionId: source, text: "@审核员 请看第二个方案" };
  await host.bots.mention(bot.id, mention);
  await host.bots.mention(bot.id, mention);
  expect(host.bots.requests(source)).toHaveLength(0);
  await expect(host.bots.ask("other", mention.id, "wrong")).rejects.toThrow("本会话");
  const question = "第二个方案是复用已有会话，请核对它的恢复逻辑。";
  const request = await host.bots.ask(source, mention.id, question);
  expect(store.getItem(`bot-request:${request.id}`)).toMatchObject({ text: expect.stringContaining("来源任务") });
  await vi.waitFor(() => expect(store.getItem(`bot-reply:${request.id}`)).toMatchObject({ sessionId: source, text: expect.stringContaining(question) }));
  await host.bots.ask(source, mention.id, question);
  expect(store.findItems(request.sessionId!, "user")).toHaveLength(1);
  await vi.waitFor(() => expect(store.findItems(source, "turn")).toHaveLength(2));
  expect(host.bots.requests(source)).toHaveLength(1);
});

it("binds every recipient to one mention without duplicating a delivery on retry", async () => {
  const { host, store } = start();
  const a = host.bots.save(input);
  const b = host.bots.save({ ...input, name: "审核员2" });
  const { session } = await host.tasks.createTask({ title: "双人审核", firstSession: { profileId: "mock" } });
  const origin = session!.id;
  const mention = { id: "pair", sourceSessionId: origin, recipients: [{ botId: a.id, destination: "home" }, { botId: b.id, destination: "new" }], text: "@审核员 @审核员2 你们是谁？" };
  await host.bots.mentionMany(mention);
  await host.bots.mentionMany(mention);
  expect(store.findItems(origin, "user")).toHaveLength(1);
  await expect(host.bots.mentionMany({ ...mention, recipients: [...mention.recipients].reverse() })).rejects.toThrow("另一条消息");
  await expect(host.bots.ask(origin, "pair", "介绍自己")).rejects.toThrow("对应 Bot");
  await expect(host.bots.ask(origin, "pair:3", "介绍自己")).rejects.toThrow("对应 Bot");
  const first = await host.bots.ask(origin, "pair:1", "介绍自己");
  const second = await host.bots.ask(origin, "pair:2", "介绍自己");
  expect(first.botId).toBe(a.id);
  expect(second.botId).toBe(b.id);
  await host.bots.ask(origin, "pair:2", "介绍自己");
  expect(store.findItems(second.sessionId!, "user")).toHaveLength(1);
  await vi.waitFor(() => expect(host.bots.requests(origin).filter((r) => r.reported)).toHaveLength(2));
});

it("recovers a completed review if the Host stopped before the reply reached the source inbox", async () => {
  const { host, root } = start();
  const bot = host.bots.save(input);
  const { session } = await host.tasks.createTask({ title: "Recovery source", firstSession: { profileId: "mock" } });
  const source = session!.id;
  const put = host.sessions.inbox.put.bind(host.sessions.inbox);
  vi.spyOn(host.sessions.inbox, "put").mockImplementation((...args) => {
    if (args[3]?.startsWith("bot-reply:")) return Promise.reject(new Error("simulated offline inbox"));
    return put(...args);
  });
  await host.bots.mention(bot.id, { id: "recover-mention", sourceSessionId: source, text: "@审核员 检查重试" });
  const request = await host.bots.ask(source, "recover-mention", "检查重试");
  await vi.waitFor(() => expect(host.bots.requests(source)[0]?.status).toBe("completed"));
  const recoveredStore = new Store(join(root, "studio.db"));
  const servers = new FakeServers(profiles);
  const recovered = new HostService(recoveredStore, new CodexRuntime({ store: recoveredStore, servers, profiles }), profiles, { commonDir: join(root, "common") });
  cleanup.push(async () => { recovered.duty.stop(); recovered.bots.webhooks.stop(); recovered.teamLink.stop(); await servers.close(); recoveredStore.close(); });
  await vi.waitFor(() => expect(recovered.bots.requests(source)[0]?.reported).toBe(true));
  expect(recoveredStore.getItem(`bot-reply:${request.id}`)).toMatchObject({ sessionId: source });
  expect(recoveredStore.findItems(source, "user")).toHaveLength(2);
});

it("starts a separate worktree-scoped chat and rejects an unrelated chat destination", async () => {
  const { host, store } = start();
  const bot = host.bots.save(input);
  const { task } = await host.tasks.createTask({ title: "Origin" });
  const worktree = join(host.commonWorkspace().path, "worktree");
  const source = await host.tasks.startSession({ taskId: task.id, topicId: null }, host.commonWorkspace(), { profileId: "mock" }, worktree);
  const separate = await host.bots.request(bot.id, { id: "review-fresh", destination: "new", sourceSessionId: source!.id, text: "Inspect this worktree" });
  expect(separate.sessionId).toBeTruthy();
  expect(store.getSession(separate.sessionId!)).toMatchObject({ cwd: worktree, options: { permission: "read-only" } });
  expect(store.getSession(separate.sessionId!)?.taskId).not.toBe(task.id);
  const refused = await host.bots.request(bot.id, { id: "review-refused", destination: { sessionId: source!.id }, text: "This must stay isolated" });
  expect(refused).toMatchObject({ status: "failed", sessionId: null });
  await vi.waitFor(() => expect(host.bots.requests(null).find((r) => r.id === "review-fresh")?.status).toBe("completed"));
});

it("uses the existing duty scheduler to run a Bot in a new chat", async () => {
  const { host } = start();
  const bot = host.bots.save(input);
  const duty = host.duty.create({ title: "Scheduled review", schedule: { daily: "08:00" }, action: { kind: "bot", botId: bot.id, prompt: "Check the daily fixture" } });
  const item = duty.items.find((i) => i.action.kind === "bot")!;
  host.duty.runNow(item.id);
  await vi.waitFor(() => { host.duty.tick(); expect(host.bots.requests(null)[0]?.status).toBe("completed"); });
  await vi.waitFor(() => { host.duty.tick(); expect(host.duty.state().runs.find((r) => r.itemId === item.id)).toMatchObject({ ok: true }); });
});

it("starts a real isolated Git worktree for an approved result once", async () => {
  const { host, store, root } = start();
  const project = join(root, "worker-project");
  mkdirSync(project);
  const git = (...args: string[]) => execFileSync("git", ["-C", project, ...args], { windowsHide: true, encoding: "utf8" });
  git("init", "--quiet", "-b", "main");
  writeFileSync(join(project, "fixture.txt"), "committed fixture");
  git("add", "fixture.txt");
  git("-c", "user.name=Test fixture", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  writeFileSync(join(project, "fixture.txt"), "uncommitted original checkout");
  const workspace = store.addWorkspace({ path: project, name: "worker-project" });
  const bot = host.bots.save({ ...input, workspaceId: workspace.id });
  await host.bots.request(bot.id, { id: "approve-worker", text: "Check the fixture" });
  await vi.waitFor(() => expect(host.bots.requests(null)[0]?.status).toBe("completed"));
  const [first, second] = await Promise.all([host.bots.worker("approve-worker"), host.bots.worker("approve-worker")]);
  expect(first.task.id).toBe(second.task.id);
  expect(first.session?.cwd).toBeTruthy();
  expect(readFileSync(join(first.session!.cwd!, "fixture.txt"), "utf8")).toBe("committed fixture");
  expect(readFileSync(join(project, "fixture.txt"), "utf8")).toBe("uncommitted original checkout");
  expect(first.session?.options.permission).toBe("workspace-write");
});

it("fans out to group members, keeps separate conversations and does not repeat on retry", async () => {
  const { host, store } = start();
  const alpha = host.bots.save(input);
  const beta = host.bots.save({ ...input, name: "β reviewer" });
  // Start the shared fake profile before two calls attempt to use it concurrently.
  await host.bots.home(alpha.id);
  const group = host.bots.saveGroup({ name: "复核组", memberIds: [alpha.id, beta.id] });
  const first = await host.bots.post(group.id, { id: "post-1", text: "Inspect the same change", targetIds: [alpha.id, beta.id] });
  expect(first.replies.map((r) => r.botId).sort()).toEqual([alpha.id, beta.id].sort());
  expect(new Set(first.replies.map((r) => r.sessionId)).size).toBe(2);
  await vi.waitFor(() => expect(host.bots.posts(group.id)[0]?.replies.map(({ status, result }) => ({ status, result }))).toEqual([expect.objectContaining({ status: "completed" }), expect.objectContaining({ status: "completed" })]));
  const next = await host.bots.post(group.id, { id: "post-2", text: "Second opinion", targetIds: [alpha.id] });
  expect(next.replies[0]?.sessionId).toBe(first.replies.find((r) => r.botId === alpha.id)?.sessionId);
  await host.bots.post(group.id, { id: "post-2", text: "Second opinion", targetIds: [alpha.id] });
  expect(store.findItems(next.replies[0]!.sessionId!, "user")).toHaveLength(2);
});

it("stops only the group reply requested, including a message held behind a different turn", async () => {
  const { host, store } = start();
  const alpha = host.bots.save(input);
  const beta = host.bots.save({ ...input, name: "回归审核员" });
  const group = host.bots.saveGroup({ name: "复核组", memberIds: [alpha.id, beta.id] });
  const post = (id: string, text: string) => host.bots.post(group.id, { id, text, targetIds: [alpha.id] });
  const status = (id: string) => host.bots.posts(group.id).find((item) => item.id === id)?.replies[0]?.status;
  const first = await post("slow", "[[slow]]");
  await vi.waitFor(() => expect(status("slow")).toBe("running"));
  const queued = await post("in-queue", "Skip this");
  const later = await post("next", "Continue with this one");
  expect(queued.replies[0]?.status).toBe("queued");
  expect(later.replies[0]?.sessionId).toBe(first.replies[0]?.sessionId);
  await expect(host.bots.removeGroup(group.id)).rejects.toThrow("运行或排队");
  await expect(host.bots.remove(alpha.id)).rejects.toThrow("运行或排队");
  await host.bots.stopGroupReply(group.id, queued.id, alpha.id);
  expect(status(queued.id)).toBe("stopped");
  expect(status(first.id)).toBe("running");
  expect(status(later.id)).toBe("queued");
  await host.bots.stopGroupReply(group.id, first.id, alpha.id);
  await vi.waitFor(() => expect(status(first.id)).toBe("stopped"));
  await host.bots.stopGroupReply(group.id, first.id, alpha.id);
  await vi.waitFor(() => expect(status(later.id)).toBe("completed"));
  const turns = store.findItems(first.replies[0]!.sessionId!, "turn");
  expect(turns).toHaveLength(2);
});

it("preserves ordinary group messages, update fields independently and retain historical replies when deleting members", async () => {
  const { host, store } = start();
  const alpha = host.bots.save(input);
  const beta = host.bots.save({ ...input, name: "回归审核员" });
  const gamma = host.bots.save({ ...input, name: "测试员" });
  const group = host.bots.saveGroup({ name: "复核组", memberIds: [alpha.id, beta.id] });
  const none = { id: "note", text: "只记录一条消息", targetIds: [] };
  expect(await host.bots.post(group.id, none)).toMatchObject({ ...none, replies: [], dispatchComplete: true });
  expect(await host.bots.post(group.id, none)).toMatchObject({ ...none, replies: [] });
  await expect(host.bots.post(group.id, { ...none, text: "另一个内容" })).rejects.toThrow("编号已用于");
  await expect(host.bots.post(group.id, { id: "non-member", text: "发给外部", targetIds: [gamma.id] })).rejects.toThrow("已启用的群组成员");
  const { replies: [reply] } = await host.bots.post(group.id, { id: "historic", text: "确认结果", targetIds: [alpha.id] });
  await vi.waitFor(() => expect(host.bots.posts(group.id)[0]?.replies[0]?.status).toBe("completed"));
  expect(host.bots.patch(alpha.id, { name: "首席审核员" })).toMatchObject({ name: "首席审核员", purpose: input.purpose, memory: input.memory });
  expect(store.getTask(reply!.taskId!)?.title).toBe("首席审核员");
  expect(host.bots.patchGroup(group.id, { name: "审核小组" })).toMatchObject({ name: "审核小组", memberIds: [alpha.id, beta.id] });
  expect(host.bots.patchGroup(group.id, { memberIds: [alpha.id, gamma.id] })).toMatchObject({ name: "审核小组", memberIds: [alpha.id, gamma.id] });
  await host.bots.remove(alpha.id);
  expect(host.bots.list().map((bot) => bot.id)).not.toContain(alpha.id);
  expect(host.bots.groups()[0]?.memberIds).toEqual([gamma.id]);
  expect(host.bots.posts(group.id)[0]?.replies[0]).toMatchObject({ status: "completed", botName: input.name });
  await expect(host.bots.home(alpha.id)).rejects.toThrow("找不到");
  expect(host.bots.save({ ...input, name: "首席审核员" }).id).not.toBe(alpha.id);
  await host.bots.removeGroup(group.id);
  expect(host.bots.groups()).toEqual([]);
  expect(() => host.bots.posts(group.id)).toThrow("找不到");
  expect(store.getSession(reply!.sessionId!)?.options.permission).toBe("read-only");
  expect(store.findItems(reply!.sessionId!, "turn")).toHaveLength(1);
});

it("accepts a scoped webhook event over Relay, deduplicates delivery, and keeps results private by default", async () => {
  const { host, root, store } = start();
  const relayStore = new RelayStore(":memory:");
  const relay = await startRelayServer({ store: relayStore, host: "127.0.0.1", port: 0 });
  cleanup.push(async () => { await relay.close(); relayStore.close(); });
  const account = relayStore.register("bot-user", "mock-password");
  const other = relayStore.register("another-user", "mock-password");
  const env = { AMO_HOME: join(root, "platform"), COMPUTERNAME: "DEV-PC" };
  const protector: Protector = { protect: async (value) => Buffer.from(value).toString("base64"), unprotect: async (value) => Buffer.from(value, "base64").toString() };
  await saveAccount({ server: relay.url, name: account.name, key: account.key }, { env, protector });
  host.teamLink.start({ env, protector });
  await vi.waitFor(() => expect(host.teamLink.login()?.account.name).toBe(account.name));
  const bot = host.bots.save(input);
  const hook = await host.bots.addWebhook(bot.id, false);
  expect(await host.bots.listWebhooks(bot.id)).toEqual([{ id: hook.id, botId: bot.id, url: hook.url, allowResult: false }]);
  const post = (token: string, text: string) => fetch(hook.url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "push-123", text }) });
  expect((await post("wrong", "check release notes")).status).toBe(401);
  expect((await post(hook.token, "check release notes")).status).toBe(202);
  expect((await post(hook.token, "check release notes")).status).toBe(202);
  expect((await post(hook.token, "replace previous content")).status).toBe(409);
  const device = host.teamLink.login()!.deviceId;
  const limited = await fetch(`${relay.url}/api/bot-hook-inbox?device=${encodeURIComponent(device)}`, { headers: { Authorization: `Bearer ${other.key}` } });
  expect(await limited.json()).toEqual([]);
  await vi.waitFor(async () => {
    await host.bots.webhooks.sync();
    const response = await fetch(`${hook.url}/events/push-123`, { headers: { Authorization: `Bearer ${hook.token}` } });
    expect(await response.json()).toEqual({ eventId: "push-123", status: "completed" });
  });
  const [request] = host.bots.requests(null);
  expect(request).toMatchObject({ status: "completed", result: expect.any(String) });
  expect(store.findItems(request!.sessionId!, "user")).toHaveLength(1);
  await host.bots.removeWebhook(bot.id, hook.id);
  expect((await post(hook.token, "reset")).status).toBe(401);
});
