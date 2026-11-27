import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type Session, type SessionGoal, type SessionItem } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { MIGRATIONS } from "./migrations.js";
import { Store, StoreTooNewError } from "./store.js";

const open: Store[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
  while (dirs.length) removeTempDir(dirs.pop()!);
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-store-"));
  dirs.push(dir);
  return join(dir, "studio.db");
}

function makeStore(path = ":memory:"): Store {
  let tick = 0;
  // Deterministic, strictly increasing timestamps keep ordering assertions stable.
  const store = new Store(path, () => new Date(Date.UTC(2026, 9, 12, 10, 0, tick++)));
  open.push(store);
  return store;
}

/** These fixtures start before migration 36 and replay the Bot and Plane migrations when reopened. */
function removeBotSchema(store: Store): void {
  store.db.exec(`
    ALTER TABLE tasks DROP COLUMN first_message_attachments;
    DROP TABLE plane_bot_native_attempts;
    DROP TABLE plane_bot_jobs;
    DROP TABLE studio_bot_group_chats;
    DROP TABLE studio_bot_group_posts;
    DROP TABLE studio_bot_groups;
    DROP TABLE studio_bot_workers;
    DROP TABLE studio_bot_requests;
    DROP TABLE studio_bots;
    DELETE FROM schema_migrations WHERE version >= 36;
  `);
}

function removePlaneBotCheckSchema(store: Store): void {
  store.db.exec(`
    ALTER TABLE plane_bot_jobs DROP COLUMN check_result_id;
    ALTER TABLE plane_bot_jobs DROP COLUMN check_request_id;
    ALTER TABLE tasks DROP COLUMN first_message_attachments;
    DELETE FROM schema_migrations WHERE version >= 40;
  `);
}

function seed(store: Store) {
  const ws = store.addWorkspace({ path: "C:/sandbox/alpha", name: "alpha" });
  const task = store.createTask({ title: "Retry", workspaceId: ws.id });
  const base = { taskId: task.id, topicId: null, runtime: "codex", profileId: "p", workspaceId: ws.id, title: "", status: "idle", writer: "workbench", runtimeRef: null } as const;
  const main = store.createSession({ ...base, parentId: null, kind: "main" });
  const fork = store.createSession({ ...base, parentId: main.id, kind: "fork" });
  const sub = store.createSession({ ...base, parentId: fork.id, kind: "sub" });
  const other = store.createSession({ ...base, parentId: null, kind: "main" });
  return { ws, task, main, fork, sub, other };
}

const GOAL: SessionGoal = { threadId: "thread-goal", objective: "Complete the assigned task", status: "active", tokenBudget: 50000, tokensUsed: 1234, timeUsedSeconds: 42, createdAt: 1794825600, updatedAt: 1794825642 };

describe("Store", () => {
  it("applies migrations once", () => {
    const path = tempDbPath();
    expect(makeStore(path).schemaVersion()).toBe(MIGRATIONS.length);
    open.pop()!.close();
    expect(makeStore(path).schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("requires a fresh analysis for a legacy Plane intake without a base and preserves dispatched work", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { task, ws } = seed(store);
    removePlaneBotCheckSchema(store);
    store.db.exec(`
      ALTER TABLE plane_bot_jobs DROP COLUMN base_commit;
      ALTER TABLE plane_bot_jobs DROP COLUMN plan;
      ALTER TABLE plane_bot_jobs DROP COLUMN plan_hash;
      ALTER TABLE plane_bot_jobs DROP COLUMN approved_at;
      ALTER TABLE plane_bot_jobs DROP COLUMN declined_at;
      DELETE FROM schema_migrations WHERE version = 39;
    `);
    const insert = store.db.prepare(`INSERT INTO plane_bot_jobs
      (id, request_id, source, viewer_id, item_id, bot_id, workspace_id, prompt, item_data, task_id, sent_result_id, comment_id)
      VALUES (?, ?, 'plane', 'actor', ?, 'bot', ?, 'plan', '{}', ?, ?, ?)`);
    insert.run("pending", "request-pending", "item-pending", ws.id, null, null, null);
    insert.run("sent", "request-sent", "item-sent", ws.id, task.id, "result", "comment");
    open.pop()!.close();

    const migrated = makeStore(path);
    const job = migrated.db.prepare("SELECT * FROM plane_bot_jobs WHERE id = ?");
    expect(job.get("pending")).toMatchObject({ base_commit: null, plan: null, plan_hash: null, approved_at: null, declined_at: null, error: expect.stringContaining("请重试接单") });
    expect(job.get("sent")).toMatchObject({ task_id: task.id, sent_result_id: "result", comment_id: "comment", approved_at: null, error: null });
  });

  it("adds delivery check references to Plane Bot jobs in migration 40 without changing existing rows", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { task, ws } = seed(store);
    removePlaneBotCheckSchema(store);
    expect(store.schemaVersion()).toBe(39);
    store.db.prepare(`INSERT INTO plane_bot_jobs
      (id, request_id, source, viewer_id, item_id, bot_id, workspace_id, prompt, item_data, task_id, sent_result_id, comment_id, base_commit, plan, plan_hash, approved_at)
      VALUES ('job', 'request', 'plane', 'actor', 'item', 'bot', ?, 'prompt', '{}', ?, 'result', 'comment', 'base', 'plan', 'hash', 'approved')`).run(ws.id, task.id);
    const existing = store.db.prepare("SELECT * FROM plane_bot_jobs WHERE id = 'job'").get();
    open.pop()!.close();

    const migrated = makeStore(path);
    expect(migrated.schemaVersion()).toBe(MIGRATIONS.length);
    expect(migrated.db.prepare("SELECT * FROM plane_bot_jobs WHERE id = 'job'").get()).toEqual({ ...existing, check_result_id: null, check_request_id: null });
  });

  it("adds deferred first-message attachment storage without changing existing task data", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { task } = seed(store);
    store.updateTask(task.id, { firstMessage: "留待首个会话" });
    store.db.exec("ALTER TABLE tasks DROP COLUMN first_message_attachments; DELETE FROM schema_migrations WHERE version >= 41;");
    open.pop()!.close();

    const migrated = makeStore(path);
    expect(migrated.schemaVersion()).toBe(MIGRATIONS.length);
    expect(migrated.getTask(task.id)).toMatchObject({ title: task.title, firstMessage: "留待首个会话" });
    expect(migrated.getTask(task.id)?.firstMessageAttachments).toBeUndefined();
  });

  it("preserves the archived Plane reference while allowing a new draft per submission", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { ws, task } = seed(store);
    store.updateTask(task.id, { archivedAt: "2026-11-24T00:00:00Z" });
    removeBotSchema(store);
    store.db.exec("DROP TABLE local_team_board_links; DELETE FROM schema_migrations WHERE version = 35;");
    for (const migration of MIGRATIONS.slice(31, 34)) store.db.exec(typeof migration === "string" ? migration : migration.sql);
    const source = "https://plane.example/api/v1/amo-team-board/workspaces/team/projects/project";
    const context = JSON.stringify({ number: "TEAM-14", title: "团队原单", creator: "提出人" });
    store.db.prepare("INSERT INTO local_team_board_links (task_id, server, account, ticket_id, plane_context) VALUES (?, ?, ?, ?, ?)").run(task.id, source, "actor", "item", context);
    open.pop()!.close();

    const migrated = makeStore(path);
    const fresh = migrated.createTask({ title: "新的个人任务", workspaceId: ws.id });
    const second = migrated.createTask({ title: "另一次提交", workspaceId: ws.id });
    const insert = migrated.db.prepare("INSERT INTO local_team_board_links (task_id, server, account, ticket_id, request_id) VALUES (?, ?, ?, ?, ?)");
    insert.run(fresh.id, source, "actor", "item", "submit-1");
    expect(() => insert.run(second.id, source, "actor", "item", "submit-1")).toThrow(/UNIQUE/);
    insert.run(second.id, source, "actor", "item", "submit-2");
    expect(migrated.db.prepare("SELECT plane_context FROM local_team_board_links WHERE task_id = ?").get(task.id)).toEqual({ plane_context: context });
    expect(migrated.getTask(task.id)?.archivedAt).toBe("2026-11-24T00:00:00Z");
  });

  it("migrates unassigned legacy tasks without guessing managers and persists transfers across reopen", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { ws, task } = seed(store);
    removeBotSchema(store);
    store.db.exec("DROP TABLE local_team_board_links; DROP TABLE local_team_tickets; DROP INDEX tasks_manager; ALTER TABLE tasks DROP COLUMN manager_task_id; ALTER TABLE tasks DROP COLUMN review_entered_at; ALTER TABLE sessions DROP COLUMN goal; ALTER TABLE sessions DROP COLUMN cwd;");
    store.db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(26);
    open.pop()!.close();
    const migrated = makeStore(path);
    expect(migrated.getTask(task.id)).toMatchObject({ title: "Retry", managerTaskId: null });
    const first = migrated.createTask({ title: "first", workspaceId: ws.id, lead: true });
    const second = migrated.createTask({ title: "second", workspaceId: ws.id, lead: true });
    const child = migrated.createTask({ title: "child", workspaceId: ws.id, managerTaskId: first.id, description: "  first-turn scope  " });
    expect(child.description).toBe("first-turn scope");
    expect(migrated.getTask(child.id)?.description).toBe("first-turn scope");
    expect(migrated.getTask(child.id)?.managerTaskId).toBe(first.id);
    migrated.updateTask(child.id, { managerTaskId: second.id });
    migrated.updateTask(task.id, { managerTaskId: first.id });
    migrated.updateTask(task.id, { managerTaskId: null });
    open.pop()!.close();
    const reopened = makeStore(path);
    expect(reopened.getTask(child.id)?.managerTaskId).toBe(second.id);
    expect(reopened.getTask(child.id)?.description).toBe("first-turn scope");
    expect(reopened.getTask(task.id)?.managerTaskId).toBeNull();
  });

  it("removes only legacy canvas collaboration once, preserving management, dependencies, labels and layout", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { ws, task } = seed(store);
    store.updateTask(task.id, { lead: true });
    const worker = store.createTask({ title: "执行", workspaceId: ws.id, managerTaskId: task.id });
    const doc: CanvasDoc = {
      ...emptyCanvas("legacy"), version: 8,
      groups: [{ id: "group", title: "保留分工", workspaceId: null, rect: { x: 10, y: 20, w: 400, h: 600 } }],
      nodes: [
        { id: "lead", kind: "task", taskId: task.id, groupId: "group", pos: { x: 30, y: 60 } },
        { id: "worker", kind: "task", taskId: worker.id, groupId: "group", pos: { x: 30, y: 300 } },
      ],
      edges: [{ id: "dependency", kind: "depends", from: task.id, to: worker.id }],
      links: [{ id: "ordinary", from: "lead", to: "worker", fromSide: "right", toSide: "left", label: "保留普通说明" }],
    };
    const collaboration = { id: "old-collaboration", kind: "collaboration", from: "worker", to: "lead", fromSide: "left", toSide: "right", label: "已移除协作" };
    store.putCanvas({ ...doc, links: [...doc.links!, collaboration] } as CanvasDoc);
    store.putCanvas({ ...emptyCanvas("only-collaboration"), links: [collaboration] } as CanvasDoc);
    store.putCanvas({ ...doc, id: "unchanged" });
    removeBotSchema(store);
    store.db.exec("DROP TABLE local_team_board_links; DROP TABLE local_team_tickets; ALTER TABLE tasks DROP COLUMN review_entered_at; ALTER TABLE sessions DROP COLUMN goal; ALTER TABLE sessions DROP COLUMN cwd;");
    store.db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(27);
    open.pop()!.close();
    const upgraded = makeStore(path);
    expect(upgraded.getCanvas("legacy")).toMatchObject({ ...doc, version: 9, updatedAt: expect.any(String) });
    expect(upgraded.getCanvas("legacy")?.updatedAt).not.toBe(doc.updatedAt);
    expect(upgraded.getCanvas("only-collaboration")?.links).toEqual([]);
    expect(upgraded.getCanvas("unchanged")).toEqual({ ...doc, id: "unchanged" });
    expect(upgraded.getTask(worker.id)?.managerTaskId).toBe(task.id);
    expect(upgraded.getTask(task.id)?.lead).toBe(true);
    open.pop()!.close();
    const reopened = makeStore(path);
    expect(reopened.getCanvas("legacy")?.version).toBe(9);
    expect(reopened.getCanvas("legacy")?.links).toEqual(doc.links);
  });

  it("refuses data a newer Studio migrated, says so for the person, and leaves the file alone (2026-10-28)", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    store.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(MIGRATIONS.length + 3, "2026-10-28T00:00:00.000Z");
    open.pop()!.close();
    let caught: unknown;
    try {
      makeStore(path);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StoreTooNewError);
    expect((caught as StoreTooNewError).message).toBe(
      `这份数据（${dirname(path)}）被更新版本的 AMO Studio 用过（数据库版本 ${MIGRATIONS.length + 3}，这个版本只认识到 ${MIGRATIONS.length}）。请先把 Studio 更新到新版本再打开。`,
    );
    // Closed again (the temp dir can be removed) and unchanged: nothing was migrated or written.
    const db = new DatabaseSync(path);
    expect((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v).toBe(MIGRATIONS.length + 3);
    db.close();
  });

  it("persists native Goal snapshots across reopen and preserves them through unrelated updates", () => {
    const path = tempDbPath();
    const store = makeStore(path);
    const { main, fork } = seed(store);
    expect(store.getSession(main.id)?.goal).toBeUndefined();
    const loop = { at: "2026-11-16T03:00:00.000Z", reason: "continue", prompt: "/loop go on" };
    store.updateSession(main.id, { options: { model: "gpt", effort: "high" }, wake: { loop }, goal: GOAL });
    store.updateSession(main.id, { title: "Renamed", status: "running" });
    expect(store.getSession(fork.id)?.goal).toBeUndefined();
    open.pop()!.close();
    const reopened = makeStore(path);
    expect(reopened.getSession(main.id)).toMatchObject({ title: "Renamed", status: "running", options: { model: "gpt", effort: "high" }, wake: { loop }, goal: GOAL, endedAt: null });
    const cleared = reopened.updateSession(main.id, { goal: null });
    expect(cleared.goal).toBeNull();
    expect(reopened.getSession(main.id)).toMatchObject({ goal: null, wake: { loop }, options: { model: "gpt", effort: "high" }, endedAt: null });
    expect(reopened.updateSession(main.id, { title: "Still cleared" }).goal).toBeNull();
  });

  it("keeps explicit Goal snapshots in remote copies and accepts older copies without a snapshot", () => {
    const store = makeStore();
    const { main } = seed(store);
    const remote = { ...main, id: "remote-goal", runtime: "remote" as const, goal: GOAL };
    expect(store.putRemoteSession(remote).goal).toEqual(GOAL);
    expect(store.putRemoteSession({ ...remote, goal: null }).goal).toBeNull();
    store.putRemoteSession(remote);
    const { goal: _goal, ...legacy } = remote;
    expect(store.putRemoteSession(legacy).goal).toBeUndefined();
  });

  it("ignores damaged Goal snapshots rather than keeping a task permanently active", () => {
    const store = makeStore();
    const { main } = seed(store);
    for (const value of ["broken-json", JSON.stringify({ status: "active" }), JSON.stringify({ ...GOAL, status: "unknown" })]) {
      store.db.prepare("UPDATE sessions SET goal = ? WHERE id = ?").run(value, main.id);
      expect(store.getSession(main.id)?.goal).toBeUndefined();
    }
  });

  it("keeps a session's wake until it is cleared (stage 15)", () => {
    const store = makeStore();
    const { main } = seed(store);
    expect("wake" in store.getSession(main.id)!).toBe(false);
    const loop = { at: "2026-10-16T03:00:00.000Z", reason: "兜底", prompt: "/loop go on" };
    store.updateSession(main.id, { wake: { loop } });
    expect(store.getSession(main.id)!.wake).toEqual({ loop });
    // Other changes leave it alone.
    expect(store.updateSession(main.id, { status: "running" }).wake).toEqual({ loop });
    expect(store.getSession(main.id)!.wake).toEqual({ loop });
    // Cleared by null, or by one with nothing in it.
    store.updateSession(main.id, { wake: {} });
    expect("wake" in store.getSession(main.id)!).toBe(false);
    store.updateSession(main.id, { wake: { loop } });
    expect("wake" in store.updateSession(main.id, { wake: null })).toBe(false);
    expect("wake" in store.getSession(main.id)!).toBe(false);
  });

  it("creates, reads and updates workspaces, tasks and sessions", () => {
    const store = makeStore();
    const { ws, task, main } = seed(store);
    expect(store.findWorkspaceByPath("C:/sandbox/alpha")?.id).toBe(ws.id);
    expect(store.updateTask(task.id, { column: "doing" }).column).toBe("doing");
    expect(store.getTask(task.id)?.column).toBe("doing");
    const topic = store.createTopic({ title: "掉落表重构", workspaceIds: [ws.id] });
    expect(store.updateTask(task.id, { topicId: topic.id }).topicId).toBe(topic.id);
    expect(store.updateTopic(topic.id, { title: "掉落表" })).toMatchObject({ title: "掉落表", workspaceIds: [ws.id], archivedAt: null });
    expect(store.listTopics().map((t) => t.id)).toEqual([topic.id]);
    store.updateSession(main.id, { status: "running", runtimeRef: "thread-1" });
    expect(store.findSessionByRuntimeRef("codex", "thread-1")?.id).toBe(main.id);
    expect(store.listSessions({ taskId: task.id })).toHaveLength(4);
  });

  it("rejects a duplicate workspace path and removing a workspace in use", () => {
    const store = makeStore();
    const { ws } = seed(store);
    expect(() => store.addWorkspace({ path: "C:/sandbox/alpha", name: "again" })).toThrow();
    expect(() => store.removeWorkspace(ws.id)).toThrow(/still used/);
    const spare = store.addWorkspace({ path: "C:/sandbox/spare", name: "spare" });
    store.removeWorkspace(spare.id);
    expect(store.getWorkspace(spare.id)).toBeUndefined();
  });

  it("archives and restores a session together with its forks and subagents", () => {
    const store = makeStore();
    const { main, fork, sub, other } = seed(store);
    const archived = store.archiveSubtree(main.id);
    expect(archived.map((s) => s.id)).toEqual([main.id, fork.id, sub.id]);
    expect(archived.every((s) => s.writer === "archived" && s.archivedAt)).toBe(true);
    expect(store.getSession(other.id)?.archivedAt).toBeNull();

    // Archiving again changes nothing; restoring a subtree restores only that subtree.
    expect(store.archiveSubtree(main.id)).toEqual([]);
    expect(store.unarchiveSubtree(fork.id).map((s) => s.id)).toEqual([fork.id, sub.id]);
    expect(store.getSession(main.id)?.archivedAt).not.toBeNull();
    expect(store.getSession(sub.id)?.writer).toBe("workbench");
  });

  it("keeps when a session's turn ended: only a status that ends a turn writes it (2026-11-04)", () => {
    const store = makeStore();
    const { main } = seed(store);
    expect(store.getSession(main.id)?.endedAt).toBeNull();
    store.updateSession(main.id, { status: "running" });
    expect(store.getSession(main.id)?.endedAt).toBeNull();
    const done = store.updateSession(main.id, { status: "idle" });
    const ended = done.endedAt!;
    expect(ended).toBe(done.updatedAt);
    // Renaming, settings, the same status again, archiving and restoring leave it.
    store.updateSession(main.id, { title: "改个名", options: { model: "x" }, status: "idle" });
    store.archiveSubtree(main.id);
    store.unarchiveSubtree(main.id);
    const s = store.getSession(main.id)!;
    expect(s.endedAt).toBe(ended);
    expect(s.updatedAt > ended).toBe(true);
  });

  it("assigns monotonic item seq per session and replaces bodies in place", () => {
    const store = makeStore();
    const { main, fork } = seed(store);
    const at = "2026-10-12T10:00:00.000Z";
    const a = store.appendItem({ id: "i-a", sessionId: main.id, createdAt: at, type: "user", text: "hi" });
    const b = store.appendItem({ id: "i-b", sessionId: main.id, createdAt: at, type: "agent", markdown: "he", streaming: true });
    const c = store.appendItem({ id: "i-c", sessionId: fork.id, createdAt: at, type: "user", text: "fork" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);

    const done = store.replaceItem({ ...(b as Extract<SessionItem, { type: "agent" }>), markdown: "hello", streaming: false });
    expect(done.seq).toBe(2);
    expect(store.listItems(main.id)).toEqual([a, done]);
    expect(store.listItems(main.id, 1)).toEqual([done]);
    expect(() => store.replaceItem({ ...a, sessionId: fork.id })).toThrow(/cannot change/);
    expect(() => store.appendItem({ id: "i-a", sessionId: main.id, createdAt: at, type: "user", text: "dup" })).toThrow();
  });

  it("keeps a global monotonic event log", () => {
    const store = makeStore();
    const { task } = seed(store);
    const e1 = store.appendEvent({ type: "task.upserted", task });
    const e2 = store.appendEvent({ type: "item.delta", sessionId: "s", itemId: "i", append: "x" });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect(store.listEvents(e1.seq)).toEqual([e2]);
    expect(store.lastEventSeq()).toBe(e2.seq);
  });

  it("keeps only the newest events when pruned, and goes on counting (2026-10-20)", () => {
    const store = makeStore();
    const { task } = seed(store);
    const seqs = Array.from({ length: 10 }, () => store.appendEvent({ type: "task.upserted", task }).seq);
    expect(store.pruneEvents(3)).toBe(7);
    expect(store.listEvents(0).map((e) => e.seq)).toEqual(seqs.slice(-3));
    expect(store.appendEvent({ type: "task.upserted", task }).seq).toBe(seqs.at(-1)! + 1);
    expect(store.pruneEvents(100)).toBe(0);
  });

  it("finds items by type and body fields, and the ones still under way, without reading the session (2026-10-20)", () => {
    const store = makeStore();
    const { main, other } = seed(store);
    const at = "2026-10-12T10:00:00.000Z";
    const add = (id: string, body: Record<string, unknown>, sessionId = main.id) => store.appendItem({ id, sessionId, createdAt: at, ...body } as never);
    add("t1", { type: "turn", turnId: "a", state: "completed", raw: { turnId: "a" } });
    add("t2", { type: "turn", turnId: "b", state: "running", raw: { turnId: "b" } });
    add("g1", { type: "agent", markdown: "one", streaming: false });
    add("g2", { type: "agent", markdown: "two", streaming: true });
    add("q1", { type: "question", state: "pending", source: "codex-async", questions: [] });
    add("b1", { type: "background", taskId: "bg-1", state: "running", command: "x" });
    add("x1", { type: "turn", turnId: "a", state: "running" }, other.id);
    expect(store.findItems(main.id, "turn", { turnId: "a" }).map((i) => i.id)).toEqual(["t1"]);
    expect(store.findItems(main.id, "turn", { "raw.turnId": "b" }).map((i) => i.id)).toEqual(["t2"]);
    expect(store.findItems(main.id, "agent", {}, { newest: true, limit: 1 }).map((i) => i.id)).toEqual(["g2"]);
    expect(store.findItems(main.id, "agent", { streaming: false }).map((i) => i.id)).toEqual(["g1"]);
    expect(store.findItems(main.id, "question", { source: "codex-async", state: "pending" }).map((i) => i.id)).toEqual(["q1"]);
    expect(store.findItems(main.id, "background", { taskId: "bg-1" }).map((i) => i.id)).toEqual(["b1"]);
    expect(() => store.findItems(main.id, "turn", { "a') OR 1=1 --": "x" })).toThrow(/bad item field/);
    expect(store.listUnfinishedItems(main.id).map((i) => i.id)).toEqual(["t2", "g2", "q1", "b1"]);
  });

  it("stores annotations, canvas and todos", () => {
    const store = makeStore();
    const { main } = seed(store);
    const at = "2026-10-12T10:00:00.000Z";
    store.putAnnotation({ id: "a1", sessionId: main.id, itemId: "i", quote: "q", start: 0, end: 1, prefix: "", suffix: "", note: "n", createdAt: at, sentAt: null });
    store.putAnnotation({ id: "a1", sessionId: main.id, itemId: "i", quote: "q", start: 0, end: 1, prefix: "", suffix: "", note: "edited", createdAt: at, sentAt: null });
    expect(store.listAnnotations(main.id).map((a) => a.note)).toEqual(["edited"]);
    const canvas = { id: "main", version: 1, groups: [], nodes: [{ id: "n1", kind: "note" as const, text: "x", groupId: null, pos: { x: 1, y: 2 } }], edges: [], updatedAt: at };
    store.putCanvas(canvas);
    expect(store.getCanvas("main")).toEqual(canvas);
    store.putTodo({ id: "t1", text: "later", done: false, workspaceId: null, taskId: null, createdAt: at });
    expect(store.listTodos()).toHaveLength(1);
  });

  it("stores key/value settings", () => {
    const store = makeStore();
    expect(store.getKv("scratchpad")).toBeUndefined();
    store.setKv("scratchpad", "first");
    const second = store.setKv("scratchpad", "second");
    expect(store.getKv("scratchpad")).toEqual(second);
    expect(second.value).toBe("second");
  });

  it("keeps data across a restart", () => {
    const path = tempDbPath();
    const first = makeStore(path);
    const { main } = seed(first);
    first.appendItem({ id: "i-1", sessionId: main.id, createdAt: "2026-10-12T10:00:00.000Z", type: "user", text: "persist me" });
    first.archiveSubtree(main.id);
    const seq = first.appendEvent({ type: "workspace.removed", workspaceId: "x" }).seq;
    open.pop()!.close();

    const second = makeStore(path);
    expect(second.listWorkspaces()).toHaveLength(1);
    expect(second.listSessions().filter((s: Session) => s.archivedAt)).toHaveLength(3);
    expect(second.listItems(main.id).map((i) => i.type === "user" && i.text)).toEqual(["persist me"]);
    expect(second.lastEventSeq()).toBe(seq);
  });
});
