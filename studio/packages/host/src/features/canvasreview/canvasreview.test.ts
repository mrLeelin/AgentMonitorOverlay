import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasItem, HostEvent, ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { amoToolsFor } from "../../mcp/tools.js";

// 画布审阅 (2026-10-27): items laid out on a topic's canvas, bubbles on its cards, the person's answers back to the
// asking session, and a session to talk one item over.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;
let topic: Topic;
let task: Task;
let caller: Session;
let events: HostEvent[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-review-canvas-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  topic = store.createTopic({ title: "relay 审阅" });
  task = store.createTask({ title: "主控", workspaceId: alpha.id, topicId: topic.id, lead: true });
  caller = await service.tasks.addSession(task.id, { profileId: "p-ds" });
  await service.sessions.renameSession(caller.id, "主会话");
  events = [];
  service.on("event", (e) => events.push(e));
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
const userTexts = (sessionId: string) => store.listItems(sessionId).flatMap((i) => (i.type === "user" ? [i.text] : []));
const items = () => service.canvases.canvas(topic.id).nodes.filter((n): n is CanvasItem => n.kind === "item");
const tool = (name: string) => amoToolsFor(service, { sessionId: caller.id }).find((t) => t.name === name)!;
const run = async (name: string, args: Record<string, unknown>) => {
  const out = await tool(name).run(args);
  if (out.isError) throw new Error(out.content[0]!.text);
  return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
};

describe("画布审阅", () => {
  it("lays items out in a new group, numbers on, and adds to that group by its title", async () => {
    const first = await run("canvas_items_post", { group: "本周提交", items: [{ title: "协议改了", body: "客户端要一起升", refs: ["abc123"] }, { title: "重连" }] });
    expect(first.items).toMatchObject([{ num: 1, title: "协议改了" }, { num: 2, title: "重连" }]);
    const doc = service.canvases.canvas(topic.id);
    expect(doc.groups).toMatchObject([{ id: first.groupId, title: "本周提交" }]);
    expect(items().map((i) => [i.num, i.status, i.sessionId, i.groupId])).toEqual([
      [1, "todo", caller.id, first.groupId],
      [2, "todo", caller.id, first.groupId],
    ]);
    // Inside the group, side by side, not overlapping.
    const g = doc.groups[0]!.rect;
    for (const i of items()) expect(i.pos.x >= g.x && i.pos.y >= g.y && i.pos.x + 240 <= g.x + g.w && i.pos.y + 124 <= g.y + g.h).toBe(true);
    const more = await run("canvas_items_post", { group: "本周提交", items: [{ title: "日志", status: "confirmed" }] });
    expect(more).toMatchObject({ groupId: first.groupId, items: [{ num: 3 }] });
    expect(service.canvases.canvas(topic.id).groups).toHaveLength(1);
    expect(tool("canvas_items_post").autoApprove).toBe(true);
    await expect(run("canvas_items_post", { items: [{ title: "x", status: "maybe" }] })).rejects.toThrow(/status/);
    await expect(run("canvas_items_post", { items: [] })).rejects.toThrow(/non-empty/);
  });

  it("updates an item by #n, and canvas_read lists items, bubbles and answers", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }, { title: "重连" }] });
    const updated = await run("canvas_item_update", { item: "#2", status: "confirmed", conclusion: "保持现状" });
    expect(updated).toMatchObject({ num: 2, status: "confirmed", conclusion: "保持现状" });
    await expect(run("canvas_item_update", { item: "#9", status: "done" })).rejects.toThrow(/no review item/);
    await run("canvas_callout", { target: "#1", kind: "question", text: "要不要兼容旧客户端？", options: ["兼容", "不兼容"] });
    const read = await tool("canvas_read").run({});
    const outline = read.content[0]!.text;
    expect(outline).toContain("#1【待看】协议改了");
    expect(outline).toContain("#2【已确认】重连");
    expect(outline).toContain("结论：保持现状");
    expect(outline).toContain("问题（等人回答） · 你写的");
    const json = JSON.parse(read.content[1]!.text);
    expect(json.groups[0].items.map((i: { num: number }) => i.num)).toEqual([1, 2]);
    expect(json.callouts).toMatchObject([{ kind: "question", state: "open", mine: true, on: "#1「协议改了」" }]);
  });

  it("pins bubbles to items, task cards, notes and groups, and refuses what is not on the canvas", async () => {
    const { groupId } = await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }] });
    service.canvases.setTaskOnCanvas(task.id, { onCanvas: true });
    const onItem = await run("canvas_callout", { target: "1", text: "客户端要一起升" });
    expect(onItem).toMatchObject({ kind: "note", state: "open", target: items()[0]!.id, sessionId: caller.id });
    expect((await run("canvas_callout", { target: task.id, kind: "question", text: "先做哪个？", deep: true })).deep).toBe(true);
    expect((await run("canvas_callout", { target: String(groupId), text: "整组先看" })).target).toBe(groupId);
    await expect(run("canvas_callout", { target: "nope", text: "x" })).rejects.toThrow(/nothing on this canvas/);
    await expect(run("canvas_callout", { target: "#1", text: "x", options: ["a"] })).rejects.toThrow(/options are for a question/);
    expect(service.canvasReview.callouts(topic.id)).toHaveLength(3);
    expect(events.filter((e) => e.type === "callout.upserted")).toHaveLength(3);
  });

  it("sends the person's answer to the asking session, keeps it, and the agent closes the bubble", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了" }] });
    const q = await run("canvas_callout", { target: "#1", kind: "question", text: "要不要兼容旧客户端？" });
    await run("canvas_callout", { target: "#1", text: "只是说明，不算在等的问题里" });
    expect(store.waitingQuestions()).toEqual({ [topic.id]: { count: 1, first: { id: q.id, text: "要不要兼容旧客户端？", createdAt: expect.any(String) } } });
    const answered = await service.canvasReview.answer(String(q.id), { text: "兼容一个版本" });
    expect(store.waitingQuestions()).toEqual({});
    expect(answered).toMatchObject({ state: "answered", answer: { text: "兼容一个版本" } });
    expect(answered.answer!.sent).not.toBe("none");
    await until(() => userTexts(caller.id).some((t) => t.includes("【画布回答】")));
    const message = userTexts(caller.id).find((t) => t.includes("【画布回答】"))!;
    expect(message).toContain("#1「协议改了」");
    expect(message).toContain("你写的：要不要兼容旧客户端？");
    expect(message).toContain("人的回答：兼容一个版本");
    expect(message).toContain(`canvas_callout_close（calloutId: ${String(q.id)}）`);
    expect(await run("canvas_callout_close", { calloutId: q.id })).toEqual({ closed: [q.id] });
    expect(service.canvasReview.getCallout(String(q.id)).state).toBe("closed");
    // Closed ones stay listed for the page, but not in canvas_read.
    expect(service.canvasReview.callouts(topic.id).map((c) => c.state)).toEqual(["open", "closed"]);
    expect(service.canvases.canvasOutline(topic.id).json.callouts.map((c) => c.kind)).toEqual(["note"]);
    await expect(service.canvasReview.answer(String(q.id), { text: "再说" })).rejects.toThrow(/closed/);
  });

  it("an answer to a gone session is kept, not sent; closing by target closes every bubble on that card", async () => {
    await run("canvas_items_post", { items: [{ title: "协议改了" }] });
    const q = await run("canvas_callout", { target: "#1", kind: "question", text: "兼容？" });
    await run("canvas_callout", { target: "#1", text: "注意" });
    await service.sessions.archive(caller.id);
    expect((await service.canvasReview.answer(String(q.id), { text: "兼容" })).answer).toMatchObject({ text: "兼容", sent: "none" });
    expect(service.canvasReview.closeFor(topic.id, { target: "#1" }).closed).toHaveLength(2);
  });

  it("就这条展开聊: a session in the laying session's task, seeded with the item, listed on it", async () => {
    await run("canvas_items_post", { group: "审阅", items: [{ title: "协议改了", body: "客户端要一起升", refs: ["packages/relay/src/protocol.ts"] }] });
    const item = items()[0]!;
    await run("canvas_items_post", { items: [{ title: "兼容约束", body: "至少保留一个版本", status: "confirmed" }] });
    await run("canvas_item_update", { item: "#2", conclusion: "保留旧协议" });
    const related = items()[1]!;
    service.canvases.mutateCanvas(topic.id, (doc) => ({ ...doc, links: [{ id: "context-link", from: related.id, to: item.id, fromSide: "right", toSide: "left", label: "参考" }] }));
    const session = await service.canvasReview.discuss(topic.id, "#1", {});
    expect(session).toMatchObject({ taskId: task.id, profileId: "p-ds", title: "#1 协议改了" });
    expect(store.getSession(session.id)?.startedBy ?? null).toBeNull();
    expect(items()[0]!.threads).toEqual([session.id]);
    await until(() => userTexts(session.id).length > 0);
    const first = userTexts(session.id)[0]!;
    expect(first).toContain("【就这条展开聊】");
    expect(first).toContain("客户端要一起升");
    expect(first).toContain("packages/relay/src/protocol.ts");
    expect(first).toContain(`canvas_item_update（item: "#1"）`);
    expect(first).toContain("Studio 会自动将确认结果回传来源会话");
    expect(first).toContain("结论：保留旧协议");
    expect(first).toContain("关联卡 → 本卡；标签：参考");
    const update = amoToolsFor(service, { sessionId: session.id }).find((t) => t.name === "canvas_item_update")!;
    const result = await update.run({ item: "#1", conclusion: "兼容一个版本", status: "confirmed" });
    expect(result.isError).not.toBe(true);
    expect(items()[0]).toMatchObject({ conclusion: "兼容一个版本", status: "confirmed", threads: [session.id] });
    expect(service.canvases.canvasOutline(topic.id).outline).toContain("兼容一个版本");
    expect(items()[1]).toMatchObject({ conclusion: "保留旧协议", status: "confirmed" });
    await expect(service.canvasReview.discuss(topic.id, item.id + "x", {})).rejects.toThrow(/no review item/);
  });

  it("returns each UI confirmation and automatically resumes the source only when the group is settled", async () => {
    await run("canvas_items_post", { group: "按钮", items: [{ title: "颜色" }, { title: "文字" }] });
    const confirm = (num: number, conclusion: string) => service.canvases.mutateCanvas(topic.id, (doc) => ({ ...doc, nodes: doc.nodes.map((n) => n.kind === "item" && n.num === num ? { ...n, status: "confirmed", conclusion } : n) }));
    confirm(1, "蓝色");
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(1);
    expect(service.canvasReview.returns.status(topic.id).receipts).toMatchObject([{ state: "returned", targetLabel: "主控" }]);
    expect(userTexts(caller.id).filter((s) => s.includes("【画布本轮已确认】"))).toHaveLength(0);
    confirm(2, "开始");
    await until(() => userTexts(caller.id).some((s) => s.includes("【画布本轮已确认】")));
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(2);
    const text = userTexts(caller.id).find((s) => s.includes("【画布本轮已确认】"))!;
    expect(text).toContain("蓝色");
    expect(text).toContain("开始");
    expect(text).toContain("按原任务已经获得的授权继续推进");
    confirm(2, "开始");
    service.canvases.mutateCanvas(topic.id, (doc) => ({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, pos: { x: n.pos.x + 10, y: n.pos.y } })) }));
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(2);
    expect(userTexts(caller.id).filter((s) => s.includes("【画布本轮已确认】"))).toHaveLength(1);
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
  });

  it("coalesces changed conclusions while busy, then sends the latest once; reopening revokes held continuation", async () => {
    await run("canvas_items_post", { group: "按钮", items: [{ title: "颜色" }, { title: "文字" }] });
    service.sessions.roleUpdate(caller.id).told();
    store.updateTask(task.id, { description: "只讨论，不修改文件" });
    store.updateSession(caller.id, { status: "running" });
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    service.canvasReview.updateItem(topic.id, "#2", { status: "confirmed", conclusion: "开始" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "queued");
    const heldId = service.sessions.inbox.held(caller.id)[0]!.id;
    service.canvasReview.updateItem(topic.id, "#1", { conclusion: "绿色" });
    await until(() => service.sessions.inbox.held(caller.id).some((r) => r.type === "user" && r.text.includes("绿色")));
    expect(service.sessions.inbox.held(caller.id).map((r) => r.id)).toEqual([heldId]);
    expect(store.getItem(heldId)).toMatchObject({ text: expect.stringContaining("只讨论，不修改文件") });
    service.canvasReview.updateItem(topic.id, "#2", { status: "discuss" });
    expect(service.sessions.inbox.held(caller.id)).toHaveLength(0);
    expect(store.getItem(heldId)).toMatchObject({ delivery: "unsent", text: expect.stringContaining("已撤回") });
    service.canvasReview.updateItem(topic.id, "#2", { status: "confirmed" });
    await until(() => service.sessions.inbox.held(caller.id).length === 1);
    expect(service.sessions.inbox.held(caller.id)[0]!.id).not.toBe(heldId);
    service.publish({ type: "session.upserted", session: store.updateSession(caller.id, { status: "idle" }) });
    await until(() => service.sessions.inbox.held(caller.id).length === 0);
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
  });

  it("does not turn the source's own completion into a self-waking loop", async () => {
    await run("canvas_items_post", { group: "按钮", items: [{ title: "颜色" }] });
    await run("canvas_item_update", { item: "#1", status: "confirmed", conclusion: "蓝色" });
    await run("canvas_item_update", { item: "#1", status: "done" });
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(0);
    expect(service.canvasReview.returns.status(topic.id).rounds).toHaveLength(0);
  });

  it("separates groups and sources; parked cards do not block the round", async () => {
    const other = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    service.canvasReview.postItems(caller.id, topic.id, { group: "A", items: [{ title: "颜色" }, { title: "以后" }] });
    service.canvasReview.postItems(caller.id, topic.id, { group: "B", items: [{ title: "独立" }] });
    service.canvasReview.postItems(other.id, topic.id, { group: "A", items: [{ title: "另一个来源" }] });
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed" });
    service.canvasReview.updateItem(topic.id, "#2", { status: "parked" });
    await until(() => userTexts(caller.id).some((s) => s.includes("【画布本轮已确认】")));
    const message = userTexts(caller.id).find((s) => s.includes("【画布本轮已确认】"))!;
    expect(message).toContain("搁置");
    expect(message).not.toContain("独立");
    expect(message).not.toContain("另一个来源");
    expect(userTexts(other.id)).toHaveLength(0);
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
  });

  it("keeps confirmed conclusions visible when the source is archived, without choosing an unrelated session", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    await service.sessions.archive(caller.id);
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    expect(items()[0]).toMatchObject({ status: "confirmed", conclusion: "蓝色" });
    expect(service.canvasReview.returns.status(topic.id).receipts).toMatchObject([{ state: "blocked" }]);
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(0);
    expect(service.canvasReview.returns.retry(topic.id).receipts[0]?.state).toBe("blocked");
  });

  it("a changed confirmed conclusion starts a new return, but a repeated value does not", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
    await until(() => store.getSession(caller.id)?.status === "idle");
    service.canvasReview.updateItem(topic.id, "#1", { conclusion: "绿色" });
    await until(() => userTexts(caller.id).filter((s) => s.includes("【画布本轮已确认】")).length === 2);
    service.canvasReview.updateItem(topic.id, "#1", { conclusion: "绿色" });
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(2);
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
  });

  it("recovers a pending durable delivery after restart without duplicating its inbox row", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    store.updateSession(caller.id, { status: "running" });
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "queued");
    const before = service.sessions.inbox.held(caller.id).map((r) => r.id);
    const persisted = JSON.parse(store.getKv("canvas.review-returns")!.value);
    for (const r of Object.values(persisted[topic.id].rounds) as Array<{ pending: boolean }>) r.pending = true;
    store.setKv("canvas.review-returns", JSON.stringify(persisted));
    service.removeAllListeners("event");
    service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "queued");
    expect(service.sessions.inbox.held(caller.id).map((r) => r.id)).toEqual(before);
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(1);
    // Wait for the asynchronous recovery to persist before the fixture closes its database.
    await until(() => !(Object.values(JSON.parse(store.getKv("canvas.review-returns")!.value)[topic.id].rounds) as Array<{ pending?: boolean }>).some((r) => r.pending));
  });

  it("does not resume an explicitly stopped source until the person resumes it", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    service.sessions.inbox.pause(caller.id);
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "queued");
    expect(store.getSession(caller.id)?.status).toBe("idle");
    expect(service.sessions.inbox.held(caller.id)).toHaveLength(1);
    service.sessions.inbox.resume(caller.id);
    await until(() => service.sessions.inbox.held(caller.id).length === 0);
  });

  it("does not backfill historical confirmations on first installation", async () => {
    await run("canvas_items_post", { items: [{ title: "旧问题", status: "confirmed" }] });
    store.deleteKv("canvas.review-returns");
    service.removeAllListeners("event");
    service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
    service.canvases.mutateCanvas(topic.id, (doc) => ({ ...doc, nodes: doc.nodes.map((n) => ({ ...n, pos: { x: 100, y: 100 } })) }));
    expect(service.canvasReview.returns.status(topic.id)).toEqual({ receipts: [], rounds: [] });
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(0);
  });

  it("revokes continuation before dispatch when confirmation and reopen happen in one tick", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed", conclusion: "蓝色" });
    service.canvasReview.updateItem(topic.id, "#1", { status: "discuss" });
    await Promise.resolve();
    expect(userTexts(caller.id).filter((s) => s.includes("【画布本轮已确认】"))).toHaveLength(0);
    expect(service.canvasReview.returns.status(topic.id).rounds).toHaveLength(0);
  });

  it("exposes a failed enqueue and retries the same durable notification", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }] });
    const put = vi.spyOn(service.sessions.inbox, "put").mockRejectedValueOnce(new Error("temporary inbox failure"));
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "failed");
    service.canvasReview.returns.retry(topic.id);
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "sent");
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]![3]).toBe(put.mock.calls[1]![3]);
    expect(service.collab.mail({ sessionId: caller.id })).toHaveLength(1);
  });

  it("deleting a confirmed member revokes an unsent group notification and updates its receipt UI", async () => {
    await run("canvas_items_post", { items: [{ title: "颜色" }, { title: "文字" }] });
    service.sessions.inbox.pause(caller.id);
    service.canvasReview.updateItem(topic.id, "#1", { status: "confirmed" });
    service.canvasReview.updateItem(topic.id, "#2", { status: "confirmed" });
    await until(() => service.canvasReview.returns.status(topic.id).rounds[0]?.state === "queued");
    events.length = 0;
    service.canvases.mutateCanvas(topic.id, (doc) => ({ ...doc, nodes: doc.nodes.filter((n) => n.kind !== "item" || n.num !== 2) }));
    expect(service.sessions.inbox.held(caller.id)).toHaveLength(0);
    expect(service.canvasReview.returns.status(topic.id).receipts).toHaveLength(1);
    expect(events.some((e) => e.type === "canvas.returns.updated")).toBe(true);
  });
});
