import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelProfile, QuestionReply, Session, SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";

// 2026-11-17, the Free 主控: a 下级's decision woke it (a notification turn), it asked the person with Codex's
// request_user_input_async and that turn ended, leaving the session 等待回答 with no turn running. The person's answer
// (work) was held as if a turn of another purpose still ran, nothing ever ended the wait, and 停止 and 立即发送 found no
// turn to stop. codex-questions.test.ts drives CodexRuntime alone, past the router's purpose boundary, so it never saw it.

type QuestionItem = Extract<SessionItem, { type: "question" }>;
const profiles: ModelProfile[] = [{ id: "test", label: "测试", runtime: "codex", provider: null, model: "test-model" }];
const SUMMER: QuestionReply = { action: "answer", answers: [{ id: "q1", selected: ["夏天"] }] };
let folder: string, store: Store, servers: FakeServers, runtime: CodexRuntime, service: HostService, manager: Session;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), "amo-studio-test-async-answer-"));
  store = new Store(join(folder, "studio.db"));
  servers = new FakeServers(profiles);
  runtime = new CodexRuntime({ store, servers, profiles });
  service = new HostService(store, runtime, profiles, { commonDir: join(folder, "common") });
  const workspace = store.addWorkspace({ name: "项目", path: folder });
  const lead = store.createTask({ title: "主控", workspaceId: workspace.id, lead: true });
  manager = await service.tasks.addSession(lead.id, { profileId: "test" });
});
afterEach(async () => { vi.restoreAllMocks(); await servers.close(); store.close(); removeTempDir(folder); });

const status = () => store.getSession(manager.id)?.status;
const held = () => store.findItems(manager.id, "user", { delivery: "held" }).map((i) => (i.type === "user" ? i.text : ""));
const latestTurn = () => store.findItems(manager.id, "turn", {}, { newest: true, limit: 1 })[0];
const lastAgent = () => store.listItems(manager.id).filter((i): i is Extract<SessionItem, { type: "agent" }> => i.type === "agent" && !i.streaming).at(-1)?.markdown;
const turnStarts = (text: string) => servers.fakes.get("test")!.calls.filter((c) => c.method === "turn/start" && (c.params as { threadId?: string }).threadId === store.getSession(manager.id)?.runtimeRef && JSON.stringify(c.params).includes(text));

/** A 下级's decision wakes the 主控; in that notification turn Codex asks the person async, and the turn ends. */
async function askedInNotificationTurn(): Promise<QuestionItem> {
  await service.sessions.inbox.put(manager.id, "[[ask-async]] 【直属任务请求决定】按哪种方案做？", undefined, "i-decision-notice", { purpose: "notification" });
  await vi.waitFor(() => {
    expect(lastAgent()).toBe("FAKE-ASKED");
    expect(latestTurn()).toMatchObject({ state: "completed", messagePurpose: "notification" });
    expect(status()).toBe("awaiting-answer");
  }, { timeout: 4000 });
  return store.findItems(manager.id, "question", { source: "codex-async", state: "pending" })[0] as QuestionItem;
}

/** The message started a turn of its own, and that turn is over. */
async function wentIn(text: string): Promise<void> {
  await vi.waitFor(() => expect(turnStarts(text)).toHaveLength(1), { timeout: 4000 });
  await vi.waitFor(() => expect(status()).toBe("idle"), { timeout: 4000 });
}

it("the card's answer goes in at once as the next turn's work", async () => {
  const question = await askedInNotificationTurn();
  await service.sessions.answerQuestion(manager.id, question.id, SUMMER);
  expect(held()).toEqual([]);
  await wentIn("「你最喜欢哪个季节？」：夏天");
  expect(latestTurn()).toMatchObject({ messagePurpose: "work" });
  expect(store.getItem(question.id)).toMatchObject({ state: "answered" });
}, 15_000);

it("a typed reply answers the open question and goes in at once", async () => {
  const question = await askedInNotificationTurn();
  await service.sessions.sendMessage(manager.id, "冬天");
  expect(held()).toEqual([]);
  await wentIn("冬天");
  expect(store.getItem(question.id)).toMatchObject({ state: "answered" });
}, 15_000);

it("停止 ends the wait for an async question: back to idle, the question closed unanswered", async () => {
  const question = await askedInNotificationTurn();
  await service.sessions.interrupt(manager.id);
  await vi.waitFor(() => expect(status()).toBe("idle"));
  expect(store.getItem(question.id)).toMatchObject({ state: "dismissed" });
  await service.sessions.sendMessage(manager.id, "接着做");
  await wentIn("接着做");
}, 15_000);

it("停止 ends a wait left behind after the question was answered (no card, no turn)", async () => {
  const question = await askedInNotificationTurn();
  // Answered while its message did not go in: what the Free 主控 was left with.
  await runtime.answerQuestion(manager.id, question.id, SUMMER);
  expect(status()).toBe("awaiting-answer");
  await service.sessions.interrupt(manager.id);
  await vi.waitFor(() => expect(status()).toBe("idle"));
}, 15_000);

it("停止 while the turn that asked runs on: one press ends the turn and the wait", async () => {
  await service.sessions.inbox.put(manager.id, "[[ask-async:600]] 【直属任务请求决定】按哪种方案做？", undefined, "i-decision-notice", { purpose: "notification" });
  await vi.waitFor(() => {
    expect(store.findItems(manager.id, "question", { source: "codex-async", state: "pending" })).toHaveLength(1);
    expect(latestTurn()).toMatchObject({ state: "running" });
  });
  const [question] = store.findItems(manager.id, "question", { source: "codex-async" });
  await service.sessions.interrupt(manager.id);
  // Before (2026-11-17): the turn stopped, the open card put the session back to 等待回答, and a second 停止 ended that.
  await vi.waitFor(() => expect(latestTurn()).not.toMatchObject({ state: "running" }), { timeout: 4000 });
  await vi.waitFor(() => expect(status()).toBe("idle"), { timeout: 4000 });
  expect(store.getItem(question!.id)).toMatchObject({ state: "dismissed" });
}, 15_000);

it("立即发送 takes in a message held while the person was asked, with no turn left to wait for", async () => {
  const question = await askedInNotificationTurn();
  // Messages from elsewhere wait while the person is asked (the inbox's design)…
  await service.sessions.inbox.put(manager.id, "等你回答时来的工作", undefined, "i-held-work", { purpose: "work" });
  expect(held()).toHaveLength(1);
  // …and 立即发送 takes one in now. Before, it waited for a turn that was over and failed after STOP_GRACE_MS.
  const sent = service.sessions.sendNow(manager.id, "i-held-work");
  sent.catch(() => undefined);
  await vi.waitFor(() => expect(turnStarts("等你回答时来的工作")).toHaveLength(1), { timeout: 3000 });
  await sent;
  // Not the person's answer (2026-11-17: before, any message closed the card as answered): the card stays open, and
  // once that turn is over the session waits for the person again.
  await vi.waitFor(() => expect(latestTurn()).toMatchObject({ state: "completed", messagePurpose: "work" }), { timeout: 4000 });
  await vi.waitFor(() => expect(status()).toBe("awaiting-answer"), { timeout: 4000 });
  expect(store.getItem(question.id)).toMatchObject({ state: "pending" });
}, 15_000);

it("立即发送 across purposes stops the turn that asked, and leaves the person's question open", async () => {
  await service.sessions.inbox.put(manager.id, "[[ask-async:600]] 【直属任务请求决定】按哪种方案做？", undefined, "i-decision-notice", { purpose: "notification" });
  await vi.waitFor(() => {
    expect(store.findItems(manager.id, "question", { source: "codex-async", state: "pending" })).toHaveLength(1);
    expect(latestTurn()).toMatchObject({ state: "running", messagePurpose: "notification" });
  });
  const [question] = store.findItems(manager.id, "question", { source: "codex-async" });
  await service.sessions.inbox.put(manager.id, "跨用途立即发送的工作", undefined, "i-cross-work", { purpose: "work" });
  expect(held()).toEqual(["跨用途立即发送的工作"]);
  // The notification turn gives way to the work message (the router's purpose boundary), as for the person's 停止 —
  // but nobody stopped waiting for the person, and an agent's message is no answer.
  await service.sessions.sendNow(manager.id, "i-cross-work");
  await vi.waitFor(() => expect(turnStarts("跨用途立即发送的工作")).toHaveLength(1), { timeout: 4000 });
  await vi.waitFor(() => expect(latestTurn()).toMatchObject({ state: "completed", messagePurpose: "work" }), { timeout: 4000 });
  await vi.waitFor(() => expect(status()).toBe("awaiting-answer"), { timeout: 4000 });
  expect(store.getItem(question!.id)).toMatchObject({ state: "pending" });
}, 15_000);

// The other side: only a turn that is over stops counting. One still running keeps its purpose boundary.

it("while the turn that asked runs on, a message of another purpose waits for it, then goes in as the answer", async () => {
  await service.sessions.inbox.put(manager.id, "[[ask-async:600]] 【直属任务请求决定】按哪种方案做？", undefined, "i-decision-notice", { purpose: "notification" });
  await vi.waitFor(() => {
    expect(store.findItems(manager.id, "question", { source: "codex-async", state: "pending" })).toHaveLength(1);
    expect(latestTurn()).toMatchObject({ state: "running", messagePurpose: "notification" });
  });
  const [question] = store.findItems(manager.id, "question", { source: "codex-async" });
  await service.sessions.sendMessage(manager.id, "冬天");
  expect(held()).toEqual(["冬天"]);
  expect(turnStarts("冬天")).toHaveLength(0);
  await vi.waitFor(() => expect(latestTurn()).toMatchObject({ state: "completed" }), { timeout: 4000 });
  // Once that turn is over only the person's answer is awaited (2026-11-17): their message goes in as the next turn and
  // answers the card. Before, it waited behind the card until the card was answered or 立即发送 pressed.
  await wentIn("冬天");
  expect(held()).toEqual([]);
  expect(store.getItem(question!.id)).toMatchObject({ state: "answered" });
}, 15_000);

it("a blocking question of the running turn still holds a message of another purpose", async () => {
  await service.sessions.inbox.put(manager.id, "[[ask]] 【直属任务请求决定】按哪种方案做？", undefined, "i-ask-notice", { purpose: "notification" });
  await vi.waitFor(() => expect(store.findItems(manager.id, "question", { source: "codex-input", state: "pending" })).toHaveLength(1));
  expect(status()).toBe("awaiting-answer");
  await service.sessions.sendMessage(manager.id, "别的事");
  expect(held()).toEqual(["别的事"]);
  await service.sessions.interrupt(manager.id);
  await vi.waitFor(() => expect(status()).toBe("idle"), { timeout: 4000 });
}, 15_000);

it("a turn a restarted Host took over still counts as running, though its turn/started came before", async () => {
  await service.sessions.inbox.put(manager.id, "[[ask-async:600]] 【直属任务请求决定】按哪种方案做？", undefined, "i-decision-notice", { purpose: "notification" });
  await vi.waitFor(() => expect(latestTurn()).toMatchObject({ state: "running" }));
  await vi.waitFor(() => expect(status()).toBe("awaiting-answer"));
  // The next Host on the same data: no activeTurnId yet, while the turn row still runs.
  const again = new FakeServers(profiles);
  try {
    expect(new CodexRuntime({ store, servers: again, profiles }).betweenTurns(manager.id)).toBe(false);
  } finally {
    await again.close();
  }
  await vi.waitFor(() => expect(latestTurn()).toMatchObject({ state: "completed" }), { timeout: 4000 });
}, 15_000);
