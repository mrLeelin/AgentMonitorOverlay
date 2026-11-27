import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
import { DEFAULT_BOT_PREFERENCES, type HostEvent, type ModelProfile } from "@amo-studio/protocol";
import { saveAccount, type Protector } from "@amo-studio/account";
import { RelayStore, startRelayServer } from "@amo-studio/relay";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { botPermission, botSessionPrompt } from "./data.js";

const profiles: ModelProfile[] = [
  { id: "mock", label: "Mock", runtime: "codex", provider: null, model: null },
  { id: "dsh-memory-fixture", label: "DSH", runtime: "dsh", provider: null, model: null },
];
const input = { name: "审核员", profileId: "mock", purpose: "Review changes", memory: "Read staged changes", workspaceId: null, enabled: true };
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function start(seed?: (store: Store) => void) {
  const root = mkdtempSync(join(tmpdir(), "amo-bots-test-"));
  const store = new Store(join(root, "studio.db"));
  seed?.(store);
  const servers = new FakeServers(profiles);
  const runtime = new CodexRuntime({ store, servers, profiles });
  const host = new HostService(store, runtime, profiles, { commonDir: join(root, "common") });
  cleanup.push(async () => { host.duty.stop(); host.bots.webhooks.stop(); host.teamLink.stop(); await servers.close(); store.close(); await removeTempDir(root); });
  return { host, store, root, servers, runtime };
}

it("migrates old memory to one directory per Bot and uses on-disk Markdown without changing its work directory", async () => {
  const { host, root, servers } = start((store) => {
    store.db.prepare("INSERT INTO studio_bots (id, name_key, data) VALUES (?, ?, ?)").run("legacy-bot", input.name, JSON.stringify(input));
  });
  const files = host.bots.files("legacy-bot");
  expect(files.folder).toBe(join(root, "bots", "legacy-bot"));
  expect(readFileSync(join(files.folder, "SOUL.md"), "utf8")).toBe(input.purpose);
  expect(readFileSync(join(files.folder, "MEMORY.md"), "utf8")).toBe(input.memory);
  const other = host.bots.save({ ...input, name: "另一个审核员", memory: "keep separate" });
  expect(host.bots.files(other.id).folder).not.toBe(files.folder);
  writeFileSync(join(files.folder, "MEMORY.md"), "updated outside Studio", "utf8");
  expect(() => host.bots.save({ ...input, expectedFiles: { purpose: input.purpose, memory: input.memory } }, "legacy-bot")).toThrow("长期记忆已变化");
  await host.bots.home("legacy-bot", false);
  expect(servers.fakes.get("mock")?.calls.find(({ method }) => method === "thread/start")?.params).toMatchObject({ cwd: join(root, "common"), developerInstructions: expect.stringContaining("updated outside Studio") });
  expect(host.bots.list().find(({ id }) => id === other.id)?.memory).toBe("keep separate");
  await host.bots.remove("legacy-bot");
  expect(existsSync(files.folder)).toBe(false);
  expect(existsSync(host.bots.files(other.id).folder)).toBe(true);
});

it("keeps notes in the owning Bot folder and rejects stale writes and traversal", () => {
  const { host } = start();
  const bot = host.bots.save(input);
  const other = host.bots.save({ ...input, name: "另一个 Bot" });
  expect(host.bots.saveNote(bot.id, "审查笔记.md", { text: "第一版", expected: null }).notes).toEqual(["审查笔记.md"]);
  expect(() => host.bots.saveNote(bot.id, "审查笔记.md", { text: "冲突", expected: null })).toThrow("记忆文件已变化");
  expect(() => host.bots.saveNote(bot.id, "../SOUL.md", { text: "替换", expected: null })).toThrow("Markdown 文件名");
  expect(host.bots.note(bot.id, "审查笔记.md").text).toBe("第一版");
  expect(host.bots.files(other.id).notes).toEqual([]);
});

it("organizes direct chats with the Bot's model once a day and consumes them after writing", async () => {
  const { host, store, servers, runtime } = start();
  const bot = host.bots.save(input);
  const other = host.bots.save({ ...input, name: "另一个 Bot" });
  const job = host.duty.items().find(({ action }) => action.kind === "bot" && action.botId === bot.id)!;
  expect(job).toMatchObject({ enabled: true, builtin: true, schedule: { daily: "03:00" } });
  const otherJob = host.duty.items().find(({ action }) => action.kind === "bot" && action.botId === other.id)!;
  host.duty.update(otherJob.id, { enabled: false });
  const home = await host.bots.home(bot.id);
  const otherHome = await host.bots.home(other.id);
  const createdAt = new Date().toISOString();
  const add = (id: string, text: string) => store.appendItem({ id, sessionId: home.id, createdAt, type: "user", text });
  add("one-off", "本次给我中文总结");
  add("quoted", "> 请记住：这是引用的内容");
  add("sensitive", "请记住：API Key = fixture");
  store.appendItem({ id: "webhook", sessionId: home.id, createdAt, type: "user", text: "请记住：外部输入", raw: { runtime: "codex", method: "user/inbox" } });
  store.appendItem({ id: "other", sessionId: otherHome.id, createdAt, type: "user", text: "请记住：另一个 Bot 的偏好" });
  store.appendItem({ id: "agent", sessionId: home.id, createdAt, type: "agent", markdown: "请记住：模型回复", streaming: false });
  const evidence = "英文审查结论读起来费劲，中文对我更方便。";
  const fact = "审查结论优先使用中文。";
  await host.sessions.sendMessage(home.id, evidence);
  await vi.waitFor(() => expect(store.findItems(home.id, "turn").at(-1)).toMatchObject({ state: "completed" }));
  const model = vi.spyOn(runtime, "replyOnly").mockImplementation(async ({ text }) => {
    const parsed = JSON.parse(text) as { memory: string; chats: Array<{ source: number; user: string }> };
    const candidate = parsed.chats.find((chat) => chat.user === evidence)!;
    return JSON.stringify([{ source: candidate.source, evidence, text: fact }]);
  });
  const next = host.duty.nextRun(job)!;
  host.duty.now = () => next - 1;
  host.duty.tick();
  expect(host.duty.runs()).toHaveLength(0);
  host.duty.now = () => next;
  host.duty.tick();
  await vi.waitFor(() => expect(host.duty.runs()).toMatchObject([{ itemId: job.id, ok: true, summary: "已写入 1 条长期记忆。" }]));
  expect(model).toHaveBeenCalledTimes(1);
  expect(model.mock.calls[0]?.[0]).toMatchObject({ profileId: "mock", text: JSON.stringify({
    memory: input.memory,
    chats: [{ source: 1, user: "本次给我中文总结" }, { source: 2, user: evidence, reply: `FAKE: ${evidence}` }],
  }) });
  const file = join(host.bots.files(bot.id).folder, "MEMORY.md");
  expect(readFileSync(file, "utf8")).toMatch(/^Read staged changes\n\n## 自动整理 · \d{4}-\d{2}-\d{2}\n\n- 审查结论优先使用中文。\n$/u);
  expect(host.bots.list().find(({ id }) => id === other.id)?.memory).toBe(input.memory);
  await host.bots.home(bot.id, true);
  expect(servers.fakes.get("mock")?.calls.filter(({ method }) => method === "thread/start").at(-1)?.params).toMatchObject({ developerInstructions: expect.stringContaining(fact) });
  host.duty.now = () => next + 1000;
  expect((await host.duty.runNow(job.id)).runs[0]).toMatchObject({ ok: true, skipped: true });
  expect(model).toHaveBeenCalledTimes(1);
  host.bots.save({ ...input, memory: "手动删除了自动记忆" }, bot.id);
  host.duty.now = () => next + 2000;
  expect((await host.duty.runNow(job.id)).runs[0]).toMatchObject({ ok: true, skipped: true });
  expect(readFileSync(file, "utf8")).toBe("手动删除了自动记忆");
});

it("retries the same direct chat after a bad draft or a concurrent edit without overwriting memory", async () => {
  const { host, store, runtime } = start();
  const bot = host.bots.save(input);
  const home = await host.bots.home(bot.id);
  const evidence = "结论最好排在细节前面。";
  store.appendItem({ id: "direct", sessionId: home.id, type: "user", text: evidence, createdAt: new Date().toISOString() });
  const id = `duty-bot-memory:${bot.id}`;
  const file = join(host.bots.files(bot.id).folder, "MEMORY.md");
  const draft = JSON.stringify([{ source: 1, evidence, text: evidence }]);
  const model = vi.spyOn(runtime, "replyOnly")
    .mockResolvedValueOnce(JSON.stringify([{ source: 1, evidence: "伪造的依据", text: evidence }]))
    .mockImplementationOnce(async () => { writeFileSync(file, "手工编辑", "utf8"); return draft; })
    .mockResolvedValueOnce(draft);
  expect((await host.duty.runNow(id)).runs[0]).toMatchObject({ ok: false, summary: expect.stringContaining("聊天原话") });
  expect(readFileSync(file, "utf8")).toBe(input.memory);
  expect((await host.duty.runNow(id)).runs[0]).toMatchObject({ ok: false, summary: expect.stringContaining("已变化") });
  expect(readFileSync(file, "utf8")).toBe("手工编辑");
  expect((await host.duty.runNow(id)).runs[0]).toMatchObject({ ok: true, summary: "已写入 1 条长期记忆。" });
  expect(readFileSync(file, "utf8")).toMatch(/^手工编辑\n[\s\S]+结论最好排在细节前面。\n$/u);
  expect(model).toHaveBeenCalledTimes(3);
});

it("keeps a previously disabled memory schedule with its time and removes it when its Bot is deleted", async () => {
  const { host } = start((store) => {
    const at = new Date().toISOString();
    store.db.prepare("INSERT INTO studio_bots (id, name_key, data) VALUES (?, ?, ?)").run("legacy-bot", input.name, JSON.stringify(input));
    store.setKv("duty.items", JSON.stringify([{ id: "old-job", title: "记忆整理", enabled: false, schedule: { daily: "23:00" },
      action: { kind: "bot", botId: "legacy-bot", job: "memory", prompt: "整理" }, createdAt: at, updatedAt: at }]));
  });
  host.bots.patch("legacy-bot", { name: "改名的 Bot" });
  expect(host.duty.items().filter(({ action }) => action.kind === "bot")).toMatchObject([{ id: "old-job", enabled: false, schedule: { daily: "23:00" } }]);
  await host.bots.remove("legacy-bot");
  expect(host.duty.items().some(({ id }) => id === "old-job")).toBe(false);
});

it("suspends saved memory schedules on DSH and restores their selected time and switch on Codex", () => {
  const { host } = start();
  const dsh = host.bots.save({ ...input, name: "DSH Bot", profileId: "dsh-memory-fixture" });
  expect(host.duty.items().some(({ action }) => action.kind === "bot" && action.botId === dsh.id)).toBe(false);

  const bot = host.bots.save(input);
  const job = host.duty.items().find(({ action }) => action.kind === "bot" && action.botId === bot.id)!;
  host.duty.update(job.id, { schedule: { daily: "22:15" } });
  host.duty.now = () => new Date(job.updatedAt).getTime() + 48 * 3600_000;
  host.bots.save({ changes: { profileId: dsh.profileId }, expectedFiles: {} }, bot.id);
  expect(host.duty.state().next[job.id]).toBeUndefined();
  expect(() => host.duty.runNow(job.id)).toThrow(/Codex 和 Claude/);
  host.duty.tick();
  expect(host.duty.runs()).toEqual([]);

  host.bots.save({ changes: { profileId: input.profileId }, expectedFiles: {} }, bot.id);
  expect(host.duty.items().find((item) => item.id === job.id)).toMatchObject({ enabled: true, schedule: { daily: "22:15" } });
  expect(host.duty.state().next[job.id]).toEqual(expect.any(String));
});

it("emits completion alerts only for the Bot with the matching preference", async () => {
  const { host } = start();
  const bot = host.bots.save({ ...input, preferences: { ...DEFAULT_BOT_PREFERENCES, notifications: { ...DEFAULT_BOT_PREFERENCES.notifications, completed: true } } });
  const other = host.bots.save({ ...input, name: "不提醒的 Bot" });
  const notices: HostEvent[] = [];
  host.on("event", (event) => { if (event.type === "bot.notification") notices.push(event); });
  await host.bots.request(bot.id, { id: "notify", text: "审查" });
  await host.bots.request(other.id, { id: "silent", text: "审查" });
  await vi.waitFor(() => expect(host.bots.requests(null).every((request) => request.status === "completed")).toBe(true));
  expect(notices).toMatchObject([{ type: "bot.notification", botId: bot.id, notice: "completed" }]);
});

it("resolves shared and private skills for new chats, tracks plugin updates and keeps existing snapshots", async () => {
  const { host, store, root, servers, runtime } = start();
  const codexHome = join(root, "codex-home");
  vi.stubEnv("AMO_STUDIO_TEST", "1");
  vi.stubEnv("AMO_STUDIO_TEST_CODEX_HOME", codexHome);
  const fixture = (dir: string, name: string) => {
    const path = join(dir, name, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nname: ${name}\ndescription: Fixture skill\n---\nCheck the fixture.\n`, "utf8");
    return path;
  };
  const sharedPath = fixture(join(root, "test-skill-home", ".agents", "skills"), "shared-review");
  const plugin = (version: string) => fixture(join(codexHome, "plugins", "cache", "team", "reviewer", version, "skills"), "plugin-review");
  let pluginPath = plugin("1.0");
  let disabled = false;
  const discovery = vi.spyOn(runtime, "listProfileCommands").mockImplementation(async () => ({
    commands: [{ name: "plugin-review", description: "插件审查", group: "skill", skillPath: pluginPath, skillPluginId: "reviewer@team", ...(disabled ? { skillDisabled: true } : {}) }],
  }));
  try {
    const general = await host.bots.skillCatalog({});
    const shared = general.skills.find((skill) => skill.name === "shared-review")!;
    const cached = general.skills.find((skill) => skill.name === "plugin-review")!;
    expect(cached.unavailable).toBe("请在单个 Bot 中添加");
    await expect(host.bots.saveSharedSkills([cached])).rejects.toThrow("有效的技能");
    await host.bots.saveSharedSkills([shared, shared]);
    expect(host.bots.sharedSkills()).toHaveLength(1);

    const catalog = await host.bots.skillCatalog({ profileId: "mock", workspaceId: null });
    const privateSkill = catalog.skills.find((skill) => skill.name === "plugin-review")!;
    expect(privateSkill.id).toBe(cached.id);
    expect(privateSkill.unavailable).toBeUndefined();
    const bot = host.bots.save({ ...input, skills: [privateSkill, shared] });
    expect(host.bots.save(input, bot.id).skills).toHaveLength(2);
    const second = host.bots.save({ ...input, name: "助手" });
    const home = await host.bots.home(bot.id);
    const peer = await host.bots.home(second.id);
    const sent = (method: string) => servers.fakes.get("mock")!.calls.filter((call) => call.method === method).at(-1)?.params;
    const firstPrompt = botSessionPrompt(store, home.id)!;
    expect(firstPrompt).toContain(pluginPath.replaceAll("\\", "/"));
    expect(firstPrompt.match(/shared-review/g)).toHaveLength(2); // Name and file path, once each.
    expect(botSessionPrompt(store, peer.id)).toContain(sharedPath.replaceAll("\\", "/"));
    expect(botSessionPrompt(store, peer.id)).not.toContain("plugin-review");
    expect(sent("thread/start")).toMatchObject({ developerInstructions: botSessionPrompt(store, peer.id), sandbox: "read-only" });

    pluginPath = plugin("2.0");
    const fresh = await host.bots.home(bot.id, true);
    expect(sent("thread/start")).toMatchObject({ developerInstructions: expect.stringContaining(pluginPath.replaceAll("\\", "/")) });
    expect(botSessionPrompt(store, home.id)).toBe(firstPrompt);
    const branch = await host.sessions.fork(home.id);
    expect(botSessionPrompt(store, branch.id)).toBe(firstPrompt);
    expect(sent("thread/fork")).toMatchObject({ developerInstructions: firstPrompt });

    disabled = true;
    const last = await host.bots.home(bot.id, true);
    expect(botSessionPrompt(store, last.id)).not.toContain("plugin-review");
    expect(store.findItems(last.id, "notice")).toEqual([expect.objectContaining({ message: expect.stringContaining("plugin-review") })]);
    expect((await host.bots.skillCatalog({ profileId: "mock" })).skills.find((skill) => skill.id === privateSkill.id)?.unavailable).toBe("插件未启用");
    expect(discovery).toHaveBeenCalledWith("mock", expect.anything(), true);
  } finally { vi.unstubAllEnvs(); }
});

it("resolves a configured project skill in the actual worktree and skips it in another project", async () => {
  const { host, store, root } = start();
  vi.stubEnv("AMO_STUDIO_TEST", "1");
  const makeWorkspace = (name: string) => {
    const path = join(root, name);
    const skillPath = join(path, ".agents", "skills", "project-review", "SKILL.md");
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "---\nname: project-review\ndescription: Verify the project.\n---\nReview the worktree.\n", "utf8");
    return { path, skillPath };
  };
  const project = makeWorkspace("project");
  const checkout = makeWorkspace("worktree");
  const other = makeWorkspace("other");
  try {
    const workspace = host.projects.addWorkspace({ path: project.path });
    const another = host.projects.addWorkspace({ path: other.path });
    const catalog = await host.bots.skillCatalog({ profileId: "mock", workspaceId: workspace.id });
    const skill = catalog.skills.find((item) => item.name === "project-review")!;
    const bot = host.bots.save({ ...input, workspaceId: workspace.id, skills: [skill] });
    const { task } = await host.tasks.createTask({ title: "Origin", workspaceId: workspace.id });
    const source = await host.tasks.startSession({ taskId: task.id, topicId: null }, workspace, { profileId: "mock" }, checkout.path);
    const review = await host.bots.request(bot.id, { id: "review-worktree", destination: "new", sourceSessionId: source.id, text: "Review this checkout" });
    expect(botSessionPrompt(store, review.sessionId!)).toContain(checkout.skillPath.replaceAll("\\", "/"));
    expect(botSessionPrompt(store, review.sessionId!)).not.toContain(project.skillPath.replaceAll("\\", "/"));
    const { session } = await host.tasks.createTask({ title: "Other", workspaceId: another.id, firstSession: { profileId: "mock" } });
    const unrelated = await host.bots.request(bot.id, { id: "review-other", destination: "new", sourceSessionId: session!.id, text: "Review another project" });
    expect(botSessionPrompt(store, unrelated.sessionId!)).toBeUndefined();
    expect(store.findItems(unrelated.sessionId!, "notice")).toEqual([expect.objectContaining({ message: expect.stringContaining("project-review") })]);
    await vi.waitFor(() => expect(host.bots.requests(null).filter((request) => request.status === "completed")).toHaveLength(2));
  } finally { vi.unstubAllEnvs(); }
});

it("keeps a Bot's grants across older clients' saves and resets model-specific choices when switching models", () => {
  const { host, store } = start();
  const bot = host.bots.save({ ...input, model: "mock-model", effort: "high", fast: true, permission: "full-auto" });
  expect(host.bots.list()[0]).toMatchObject({ fast: true, permission: "full-auto" });
  expect(host.bots.save(input, bot.id)).toMatchObject({ model: "mock-model", effort: "high", fast: true, permission: "full-auto" });
  expect(() => host.bots.save({ ...input, permission: "bypassPermissions" }, bot.id)).toThrow("支持的权限");
  expect(() => host.bots.save({ ...input, fast: "true" }, bot.id)).toThrow("快速模式");
  expect(host.bots.save({ ...input, model: "other" }, bot.id)).toMatchObject({ model: "other", effort: null, fast: null, permission: "full-auto" });
  expect(host.bots.save({ ...input, model: null, effort: null, fast: false, permission: null }, bot.id)).toMatchObject({ model: null, effort: null, fast: false, permission: "read-only" });
  store.db.prepare("UPDATE studio_bots SET data = json_remove(data, '$.permission', '$.fast') WHERE id = ?").run(bot.id);
  expect(host.bots.save(input, bot.id)).toMatchObject({ permission: "read-only", fast: null });
});

it("validates Bot permission choices against the runtime and the selected Claude endpoint", () => {
  expect(botPermission(null, "claude")).toBe("plan");
  expect(botPermission("auto", "claude")).toBe("auto");
  expect(() => botPermission("auto", "claude", "https://provider.example")).toThrow("第三方模型");
  expect(botPermission("full-access", "dsh")).toBe("full-access");
  expect(() => botPermission("full-auto", "dsh")).toThrow("支持的权限");
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

it("stores an Orca mascot avatar and refuses unknown mascot ids", () => {
  const { host } = start();
  const bot = host.bots.save({ ...input, avatar: "mascot:A1" });
  expect(host.bots.list()[0]?.avatar).toBe("mascot:A1");
  expect(host.bots.save({ ...input, avatar: "mascot:S2" }, bot.id).avatar).toBe("mascot:S2");
  expect(() => host.bots.save({ ...input, avatar: "mascot:Z9" }, bot.id)).toThrow("头像格式无效");
  expect(() => host.bots.save({ ...input, avatar: "mascot:" }, bot.id)).toThrow("头像格式无效");
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
  await expect(host.sessions.terminal(first.sessionId!, false)).rejects.toThrow("Bot 聊天");
  const next = await host.bots.home(bot.id, true);
  expect(next.id).not.toBe(first.sessionId);
  expect(host.bots.chats(bot.id).map((chat) => chat.id)).toEqual(expect.arrayContaining([first.sessionId, next.id]));
  const previous = await host.bots.request(bot.id, { id: "review-2", destination: { sessionId: first.sessionId }, text: "Follow up on the fixture" });
  expect(previous.sessionId).toBe(first.sessionId);
  await vi.waitFor(() => expect(host.bots.requests(null).find((r) => r.id === "review-2")?.status).toBe("completed"));
});

it("pins the Bot's chosen permission at chat creation and preserves it on turns, forks and restore", async () => {
  const { host, servers } = start();
  const bot = host.bots.save({ ...input, permission: "workspace-write", fast: false });
  const home = await host.bots.home(bot.id);
  const last = (method: string) => servers.fakes.get("mock")!.calls.filter((c) => c.method === method).at(-1)?.params;
  expect(home.options).toMatchObject({ permission: "workspace-write", fast: false });
  expect(last("thread/start")).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  host.bots.save({ ...input, permission: "full-auto" }, bot.id);
  expect((await host.sessions.updateSessionOptions(home.id, { permission: "full-auto" })).options.permission).toBe("workspace-write");
  await host.bots.request(bot.id, { id: "old-permission", text: "Review" });
  await vi.waitFor(() => expect(host.bots.requests(null)[0]?.status).toBe("completed"));
  expect(last("turn/start")).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  const fork = await host.sessions.fork(home.id);
  expect(fork.options.permission).toBe("workspace-write");
  expect(last("thread/fork")).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  await host.sessions.archive(fork.id);
  await host.sessions.unarchive(fork.id);
  expect(last("thread/resume")).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  const fresh = await host.bots.home(bot.id, true);
  expect(fresh.options.permission).toBe("full-auto");
  expect(last("thread/start")).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  host.bots.save({ ...input, permission: null }, bot.id);
  const readOnly = await host.tasks.addSession(fresh.taskId!, { profileId: "mock", options: { permission: "full-auto" } });
  expect(readOnly.options.permission).toBe("read-only");
  expect(last("thread/start")).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" });
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
  const item = duty.items.find((i) => i.action.kind === "bot" && !i.action.job)!;
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

it("shares only this group's history and routes a turn-bound peer question once", async () => {
  const { host, store } = start();
  const alpha = host.bots.save(input);
  const beta = host.bots.save({ ...input, name: "Claude" });
  const outsider = host.bots.save({ ...input, name: "外部成员" });
  const group = host.bots.saveGroup({ name: "复核组", memberIds: [alpha.id, beta.id] });
  const other = host.bots.saveGroup({ name: "另一组", memberIds: [alpha.id, outsider.id] });
  await host.bots.post(other.id, { id: "private", text: "另一组的独立消息", targetIds: [] });
  const home = await host.bots.home(alpha.id);
  const initial = await host.bots.post(group.id, { id: "seed", text: "请介绍你自己", targetIds: [beta.id] });
  await vi.waitFor(() => expect(host.bots.posts(group.id)[0]?.replies[0]?.status).toBe("completed"));
  const working = await host.bots.post(group.id, { id: "handoff", text: "请问一下 Claude [[slow]]", targetIds: [alpha.id] });
  const source = working.replies[0]!;
  const sessionId = source.sessionId!;
  await vi.waitFor(() => expect(host.bots.posts(group.id)[0]?.replies[0]?.status).toBe("running"));
  const inbox = store.getItem(`bot-request:${source.id}`);
  expect(inbox?.type).toBe("user");
  if (inbox?.type !== "user") throw new Error("missing group input");
  expect(inbox.text).toContain('"from":"Claude"');
  expect(inbox.text).not.toContain("另一组的独立消息");
  expect(inbox.text).not.toContain(outsider.id);
  const ask = (target: string, text = "你在吗？") => host.bots.askGroupMember(sessionId, source.id, target, text);
  await expect(host.bots.askGroupMember(home.id, source.id, beta.id, "你在吗？")).rejects.toThrow("本会话");
  for (const target of [outsider.id, alpha.id]) await expect(ask(target)).rejects.toThrow("另一位已启用的成员");
  host.bots.patch(beta.id, { enabled: false });
  await expect(ask(beta.id)).rejects.toThrow("已启用");
  host.bots.patch(beta.id, { enabled: true });
  host.bots.save({ ...input, name: beta.name, preferences: { ...DEFAULT_BOT_PREFERENCES, allowGroupAsk: false } }, beta.id);
  await expect(ask(beta.id)).rejects.toThrow("不接收其他 Bot 的提问");
  host.bots.save({ ...input, name: beta.name, preferences: DEFAULT_BOT_PREFERENCES }, beta.id);
  const [question, retry] = await Promise.all([ask(beta.id), ask(beta.id)]);
  expect(retry.id).toBe(question.id);
  expect(question).toMatchObject({ author: { botId: alpha.id, botName: alpha.name }, targetIds: [beta.id], text: "你在吗？" });
  expect(question.replies[0]?.sessionId).toBe(initial.replies[0]?.sessionId);
  expect(host.bots.posts(group.id)).toHaveLength(3);
  await expect(ask(beta.id, "另一个问题")).rejects.toThrow("已经向该成员提过问");
  await expect(host.bots.post(group.id, { id: question.id, text: question.text, targetIds: question.targetIds })).rejects.toThrow("另一条群消息");
  const peer = question.replies[0]!;
  await vi.waitFor(() => expect(host.bots.posts(group.id)[0]?.replies[0]?.status).toBe("running"));
  await expect(host.bots.askGroupMember(peer.sessionId!, peer.id, alpha.id, "继续转发")).rejects.toThrow("请直接回复");
  await host.bots.stopGroupReply(group.id, question.id, beta.id);
  await host.bots.stopGroupReply(group.id, working.id, alpha.id);
  await vi.waitFor(() => expect(host.bots.posts(group.id).find((post) => post.id === working.id)?.replies[0]?.status).toBe("stopped"));
  await expect(ask(beta.id)).rejects.toThrow("当前群组消息");
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
  await vi.waitFor(() => expect(status(later.id)).toBe("completed"), { timeout: 5000 });
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
