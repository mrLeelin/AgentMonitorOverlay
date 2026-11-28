import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CanvasDoc } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { expect, it } from "vitest";
import type { FeatureHost } from "../../core/feature.js";
import { CanvasFeature } from "../canvas/service.js";
import { TopicsFeature } from "../topics/service.js";
import { MIGRATIONS } from "../../store/migrations.js";
import { Store } from "../../store/store.js";
import { LegacyLeadTrees } from "./legacy.js";

const at = "2026-11-27T00:00:00.000Z";

it("rehearses schema 42 on a backup copy and preserves ownership, evidence, layout and pending work", () => {
  const dir = mkdtempSync(join(tmpdir(), "amo-legacy-lead-"));
  try {
    const oldPath = join(dir, "before.db"), copy = join(dir, "rehearsal.db");
    const old = new DatabaseSync(oldPath, { enableForeignKeyConstraints: false });
    old.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.slice(0, 42).forEach((migration, index) => {
      old.exec(typeof migration === "string" ? migration : migration.sql);
      old.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, at);
    });
    old.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES ('w', 'Fixture', ?, ?)").run(dir, at);
    for (const id of ["tp-a", "tp-b", "tp-archive"]) old.prepare("INSERT INTO topics (id, title, workspace_ids, created_at, updated_at, archived_at) VALUES (?, ?, '[\"w\"]', ?, ?, ?)").run(id, id, at, at, id === "tp-archive" ? at : null);
    const cases = [
      ["root", "tp-a", null, 1, "review"], ["mid", "tp-a", "root", 1, "doing"], ["child", "tp-a", "mid", 0, "doing"],
      ["other-root", "tp-a", null, 1, "doing"], ["outside", "tp-b", "root", 1, "doing"],
      ["unbound", null, null, 1, "doing"], ["unbound-child", null, "unbound", 0, "doing"],
      ["historical", "tp-archive", null, 1, "done"], ["promotion", "tp-b", null, 0, "doing"],
      ["loop-a", "tp-b", "loop-b", 1, "doing"], ["loop-b", "tp-b", "loop-a", 1, "doing"],
    ] as const;
    for (const [id, topic, manager, lead, column] of cases) {
      old.prepare("INSERT INTO tasks (id, title, workspace_id, topic_id, manager_task_id, lead, column_name, created_at, updated_at, archived_at) VALUES (?, ?, 'w', ?, ?, ?, ?, ?, ?, ?)").run(id, id, topic, manager, lead, column, at, at, id === "historical" ? at : null);
    }
    const card = { id: "original-layout", kind: "task", taskId: "root", groupId: "ui", pos: { x: -73, y: 627 }, color: "blue" } as const;
    const canvas: CanvasDoc = { id: "tp-a", version: 7, updatedAt: at, nodes: [card], edges: [], groups: [{ id: "ui", title: "UI", workspaceId: "w", rect: { x: -80, y: 610, w: 280, h: 160 } }] };
    old.prepare("INSERT INTO canvas_docs VALUES (?, ?, ?)").run(canvas.id, JSON.stringify(canvas), at);
    for (const [session, task, status, goal] of [["running", "child", "running", null], ["paused", "mid", "idle", '{"status":"paused","objective":"原 Goal"}'], ["source", "promotion", "idle", null]]) {
      old.prepare("INSERT INTO sessions (id, task_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, goal, created_at, updated_at) VALUES (?, ?, 'main', 'codex', 'local', 'w', ?, ?, 'workbench', ?, ?, ?, ?)").run(session!, task!, session!, status!, session!, goal ?? null, at, at);
    }
    const approval = { id: "native-approval", sessionId: "running", seq: 1, type: "approval", state: "pending", createdAt: at };
    old.prepare("INSERT INTO items VALUES ('running', 1, 'native-approval', 'approval', ?, ?)").run(at, JSON.stringify(approval));
    const result = { id: "old-result", taskId: "root", sessionId: "paused", managerTaskId: null, state: "submitted", summary: "原交付", verification: "原证据", createdAt: at, updatedAt: at };
    const kv = {
      "task-results:root": [result],
      "tasks.lead-promotions": { promotion: { taskId: "promotion", sourceSessionId: "source", state: "pending", summary: "原升任目标", oldSessionIds: ["source"] } },
      "taskplans.pending-starts": { child: { taskId: "child", managerTaskId: "mid", text: "原排队分工" } },
    };
    for (const [key, data] of Object.entries(kv)) old.prepare("INSERT INTO kv VALUES (?, ?, ?)").run(key, JSON.stringify(data), at);
    old.prepare("INSERT INTO task_plans VALUES ('old-plan', 'open', ?, ?)").run(at, JSON.stringify({ id: "old-plan", topicId: "tp-a", state: "open", tasks: [{ key: "legacy", title: "旧中控提案", lead: true }] }));
    const durable = ["SELECT id, manager_task_id, column_name FROM tasks ORDER BY id", "SELECT * FROM sessions ORDER BY id", "SELECT * FROM items ORDER BY id", "SELECT * FROM kv ORDER BY key", "SELECT * FROM task_plans"];
    const before = durable.map((sql) => old.prepare(sql).all());
    old.close();
    copyFileSync(oldPath, copy);

    const store = new Store(copy);
    const host = { store, transaction: store.transaction.bind(store), publish() {}, requireTask: store.getTask.bind(store),
      requireWorkspace: store.getWorkspace.bind(store), requireTopic: store.getTopic.bind(store), requireLiveTopic: store.getTopic.bind(store) } as unknown as FeatureHost<"topics" | "canvases" | "tasks">;
    Object.assign(host, { topics: new TopicsFeature(host), canvases: new CanvasFeature(host) });
    const legacy = new LegacyLeadTrees(host);
    legacy.repair();
    legacy.repair();
    expect(store.schemaVersion()).toBeGreaterThan(42);
    expect(durable.map((sql) => store.db.prepare(sql).all())).toEqual(before);
    for (const [key, data] of Object.entries(kv)) expect(JSON.parse(store.getKv(key)!.value)).toEqual(data);
    expect(store.getCanvas("tp-a")?.nodes.find((node) => node.id === card.id)).toEqual(card);
    expect(store.getCanvas("tp-a")?.groups).toEqual(canvas.groups);
    expect(store.getCanvas("tp-a")?.nodes.map((node) => node.kind === "task" && node.taskId).sort()).toEqual(["child", "mid", "other-root", "root"]);
    expect(store.getCanvas("tp-a")?.nodes.filter((node) => node.id !== card.id).every((node) => node.pos.y >= card.pos.y + 160)).toBe(true);
    expect(store.getTask("unbound")?.topicId).toBeTruthy();
    expect(store.getTask("unbound-child")?.topicId).toBe(store.getTask("unbound")?.topicId);
    expect(store.getTask("outside")?.topicId).toBe("tp-b");
    expect(legacy.issue(store.getTask("outside")!)).toContain("管理链");
    expect(legacy.issue(store.getTask("loop-a")!)).toContain("环");
    expect(store.listTasks()).toHaveLength(11);
    expect(store.listTopics()).toHaveLength(4);
    expect(store.db.prepare("SELECT id FROM studio_bot_lead_terms").all()).toEqual([]);
    store.close();
    const original = new DatabaseSync(oldPath, { readOnly: true });
    expect(original.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version).toBe(42);
    expect(durable.map((sql) => original.prepare(sql).all())).toEqual(before);
    original.close();
    if (process.env.AMO_LEGACY_LEAD_REHEARSAL) writeFileSync(process.env.AMO_LEGACY_LEAD_REHEARSAL, JSON.stringify({
      beforeVersion: 42, afterVersion: MIGRATIONS.length, taskIds: cases.map(([id]) => id), sessionIds: ["running", "paused", "source"],
      approvalIds: [approval.id], resultIds: [result.id], pendingStarts: ["child"], pendingPromotions: ["promotion"], plans: ["old-plan"],
      beforeTopics: 3, afterTopics: 4, preservedLayout: card, oldTopicCards: 1, repairedTopicCards: 4, anomalyTaskIds: ["outside", "loop-a", "loop-b"],
    }, null, 2));
  } finally { removeTempDir(dir); }
});
