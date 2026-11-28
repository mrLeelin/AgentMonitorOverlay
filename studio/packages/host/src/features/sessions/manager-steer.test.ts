import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { amoToolsFor } from "../../mcp/tools.js";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startLeadFixture } from "../botleads/lead.test-support.js";

// The direct manager's work 传话 and answers join the child's running Codex work turn (2026-11-17,
// plans/done/lead-instructions-mid-turn.md). In the Free 专题 one 传话 waited out a 23-minute turn and arrived 10 minutes
// late, and an answer was found by mailbox_read 7 minutes late. `[[busy:N]]` keeps the fake turn on a command, and
// steered input comes back in its reply as `FAKE-STEERED: …`.

const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
let folder: string, store: Store, servers: FakeServers, runtime: CodexRuntime, service: HostService, manager: Session, worker: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-manager-steer-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  runtime = new CodexRuntime({ store, servers, profiles });
  service = new HostService(store, runtime, profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "项目", path: folder });
  const top = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  const child = store.createTask({ title: "执行", workspaceId: workspace.id, managerTaskId: top.id });
  manager = await startLeadFixture(service, top, "test");
  worker = await service.tasks.addSession(child.id, { profileId: "test", options: { permission: "workspace-write" } });
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });

const tool = (s: Session, name: string) => amoToolsFor(service, { sessionId: s.id }).find((t) => t.name === name)!;
const status = (s: Session) => store.getSession(s.id)?.status;
const calls = (s: Session, method: string) => servers.fakes.get("test")!.calls.filter((c) => c.method === method && (c.params as { threadId?: string }).threadId === store.getSession(s.id)?.runtimeRef);
const held = (s: Session) => store.findItems(s.id, "user", { delivery: "held" });
const lastAgent = (s: Session) => store.listItems(s.id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).at(-1)?.markdown ?? "";
const relay = async (text: string, purpose: "work" | "reopen" | "inquiry", from = manager) => expect((await tool(from, "task_message").run({ taskId: worker.taskId, text, purpose })).isError).not.toBe(true);
const running = (s: Session) => vi.waitFor(() => expect(status(s)).toBe("running"));
const idle = (s: Session) => vi.waitFor(() => expect(status(s)).toBe("idle"), { timeout: 5000 });
/** Each time the text went to Codex: a turn of its own, or steered into one. */
const sent = (s: Session, text: string) => [...calls(s, "turn/start"), ...calls(s, "turn/steer")].filter((c) => JSON.stringify(c.params).includes(text));
const rows = (s: Session, text: string) => store.listItems(s.id).filter((i) => i.type === "user" && i.text.includes(text));
const times = (text: string, part: string) => text.split(part).length - 1;
const settle = () => new Promise((r) => setTimeout(r, 400));

it("the direct manager's work 传话 joins the child's running work turn", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(calls(worker, "turn/steer")).toHaveLength(1));
  expect(held(worker)).toEqual([]);
  await vi.waitFor(() => expect(lastAgent(worker)).toMatch(/^FAKE-STEERED: /), { timeout: 5000 });
  await idle(worker);
  // Once: not steered again, nor sent again as a turn of its own.
  expect(times(lastAgent(worker), "保留 G19")).toBe(1);
  expect(sent(worker, "保留 G19")).toHaveLength(1);
  expect(rows(worker, "保留 G19")).toHaveLength(1);
  expect(calls(worker, "turn/start")).toHaveLength(1);
}, 15_000);

it("a work 传话 joins a turn the manager started with reopen (the Free 主控's case)", async () => {
  await relay("[[busy:1500]] 重新做：配置 Free 并实现代码", "reopen");
  await running(worker);
  expect(store.findItems(worker.id, "turn", {}, { newest: true, limit: 1 })[0]).toMatchObject({ messagePurpose: "reopen" });
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(calls(worker, "turn/steer")).toHaveLength(1));
  await vi.waitFor(() => expect(lastAgent(worker)).toMatch(/^FAKE-STEERED: /), { timeout: 5000 });
  await idle(worker);
  expect(times(lastAgent(worker), "保留 G19")).toBe(1);
  expect(sent(worker, "保留 G19")).toHaveLength(1);
  expect(calls(worker, "turn/start")).toHaveLength(1);
}, 15_000);

it("the manager's answer to the child's question joins its running turn and is not sent again", async () => {
  const decision = service.collab.requestDecisionFromSession(worker.id, "按哪种方案做？", ["A", "B"]);
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 先做不依赖答案的部分");
  await running(worker);
  expect((await tool(manager, "task_decision_answer").run({ decisionId: decision.id, answer: "选 A" })).isError).not.toBe(true);
  await vi.waitFor(() => expect(calls(worker, "turn/steer")).toHaveLength(1));
  await vi.waitFor(() => expect(service.collab.mail({ sessionId: worker.id }).find((m) => m.id === store.getDecision(decision.id)?.mailId)).toMatchObject({ state: "forwarded" }));
  await vi.waitFor(() => expect(lastAgent(worker)).toMatch(/^FAKE-STEERED: /), { timeout: 5000 });
  await idle(worker);
  expect(times(lastAgent(worker), "选 A")).toBe(1);
  expect(sent(worker, "选 A")).toHaveLength(1);
  expect(calls(worker, "turn/start")).toHaveLength(1);
  // Nor left in the mailbox to be read again.
  expect(JSON.stringify(await tool(worker, "mailbox_read").run({}))).not.toContain("选 A");
}, 15_000);

it("stopped before reading it, the child keeps the 传话 for the person's next message instead of starting again", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:3000]] 做事");
  await running(worker);
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(calls(worker, "turn/steer")).toHaveLength(1));
  await service.sessions.interrupt(worker.id);
  // Codex dropped it unread: back in the inbox. Before, it went on as a turn of its own and the stopped child ran again.
  await vi.waitFor(() => expect(held(worker).map((i) => (i.type === "user" ? i.text : ""))).toEqual([expect.stringContaining("保留 G19")]), { timeout: 5000 });
  await idle(worker);
  await settle();
  expect(calls(worker, "turn/start")).toHaveLength(1);
  // The person's next message takes it in.
  await service.sessions.sendMessage(worker.id, "接着做");
  await vi.waitFor(() => expect(sent(worker, "保留 G19")).toHaveLength(2), { timeout: 5000 });
  await idle(worker);
  expect(held(worker)).toEqual([]);
  expect(rows(worker, "保留 G19")).toHaveLength(1);
}, 20_000);

it("a 传话 the running turn refuses waits for the turn to end instead of becoming 没送到", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  vi.spyOn(runtime, "resend").mockRejectedValueOnce(new Error("turn/steer: activeTurnNotSteerable"));
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(rows(worker, "保留 G19")[0]).toMatchObject({ delivery: "held" }));
  await idle(worker);
  await vi.waitFor(() => expect(sent(worker, "保留 G19")).toHaveLength(1), { timeout: 5000 });
  await idle(worker);
  expect(calls(worker, "turn/start")).toHaveLength(2);
  expect(store.listItems(worker.id).filter((i) => i.type === "notice" && i.message.includes("没能送进会话"))).toEqual([]);
}, 15_000);

// What still waits for the turn to end.

it("while the child answers an inquiry, the manager's work 传话 waits for that turn to end", async () => {
  await relay("[[busy:1500]] 只读：现在进展如何？", "inquiry");
  await running(worker);
  await relay("接着做下一步", "work");
  await vi.waitFor(() => expect(held(worker)).toHaveLength(1));
  expect(calls(worker, "turn/steer")).toHaveLength(0);
  await vi.waitFor(() => expect(calls(worker, "turn/start")).toHaveLength(2), { timeout: 5000 });
  await idle(worker);
}, 15_000);

it("one going in does not take the others with it: they wait for the turn to end, and go once", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  await relay("只读：现在进展如何？", "inquiry");
  await vi.waitFor(() => expect(held(worker)).toHaveLength(1));
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(calls(worker, "turn/steer")).toHaveLength(1));
  expect(sent(worker, "只读：现在进展如何")).toHaveLength(0);
  await vi.waitFor(() => expect(sent(worker, "只读：现在进展如何")).toHaveLength(1), { timeout: 5000 });
  await idle(worker);
  await settle();
  expect(sent(worker, "只读：现在进展如何")).toHaveLength(1);
  expect(sent(worker, "保留 G19")).toHaveLength(1);
}, 15_000);

it("a 传话 from a manager further up waits for the turn to end", async () => {
  const top = store.getTask(manager.taskId!)!;
  const middle = store.createTask({ title: "分主控", workspaceId: top.workspaceId, topicId: top.topicId, lead: true, managerTaskId: top.id });
  store.updateTask(worker.taskId!, { managerTaskId: middle.id });
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  await relay("越级：先别恢复", "work");
  await vi.waitFor(() => expect(held(worker)).toHaveLength(1));
  expect(calls(worker, "turn/steer")).toHaveLength(0);
  await vi.waitFor(() => expect(sent(worker, "越级：先别恢复")).toHaveLength(1), { timeout: 5000 });
  await idle(worker);
}, 15_000);

it("a compaction takes no 传话 (Codex refuses to steer into it)", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  // As runCommand("compact") marks it: Codex keeps a compaction turn to itself (activeTurnNotSteerable).
  (runtime as unknown as { sessionState(id: string): { compacting: boolean } }).sessionState(worker.id).compacting = true;
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(held(worker)).toHaveLength(1));
  expect(calls(worker, "turn/steer")).toHaveLength(0);
  await vi.waitFor(() => expect(sent(worker, "保留 G19")).toHaveLength(1), { timeout: 5000 });
  await idle(worker);
}, 15_000);

it("a child the person stopped does not take it in", async () => {
  await service.sessions.sendMessage(worker.id, "[[busy:1500]] 做事");
  await running(worker);
  service.sessions.inbox.pause(worker.id);
  await relay("保留 G19，先别恢复", "work");
  await vi.waitFor(() => expect(held(worker)).toHaveLength(1));
  expect(calls(worker, "turn/steer")).toHaveLength(0);
  await service.sessions.interrupt(worker.id);
  await vi.waitFor(() => expect(status(worker)).not.toBe("running"), { timeout: 5000 });
}, 15_000);

it("a notice going up still waits for the manager's running turn to end", async () => {
  await service.sessions.sendMessage(manager.id, "[[busy:1500]] 看一下进度");
  await running(manager);
  service.orchestration.submit(worker.id, "完成", "检查通过");
  await vi.waitFor(() => expect(held(manager)).toHaveLength(1));
  expect(calls(manager, "turn/steer")).toHaveLength(0);
  await vi.waitFor(() => expect(calls(manager, "turn/start")).toHaveLength(2), { timeout: 5000 });
  await idle(manager);
}, 15_000);
