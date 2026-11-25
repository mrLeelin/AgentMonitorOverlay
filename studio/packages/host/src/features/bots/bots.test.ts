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
