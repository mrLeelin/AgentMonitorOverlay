import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { removeTempDir } from "@amo-studio/testkit";
import { MIGRATIONS } from "./migrations.js";
import { Store } from "./store.js";

describe("task review rounds", () => {
  it("changes only on entry to review, even when transitions share the same clock tick", () => {
    const store = new Store(":memory:", () => new Date("2026-11-09T00:00:00.000Z"));
    try {
      const ws = store.addWorkspace({ name: "review", path: "C:/sandbox/review" });
      const task = store.createTask({ title: "Review me", workspaceId: ws.id });
      expect(task.reviewEnteredAt).toBeNull();
      const first = store.updateTask(task.id, { column: "review" });
      expect(first.reviewEnteredAt).toBeTruthy();
      expect(store.updateTask(task.id, { title: "Renamed", description: "Updated" }).reviewEnteredAt).toBe(first.reviewEnteredAt);
      expect(store.updateTask(task.id, { column: "review" }).reviewEnteredAt).toBe(first.reviewEnteredAt);
      store.updateTask(task.id, { column: "doing" });
      const next = store.updateTask(task.id, { column: "review" });
      expect(next.reviewEnteredAt).not.toBe(first.reviewEnteredAt);
      expect(store.getTask(task.id)?.reviewEnteredAt).toBe(next.reviewEnteredAt);
      const direct = store.createTask({ title: "Direct review", workspaceId: ws.id, column: "review" });
      expect(direct.reviewEnteredAt).toBeTruthy();
      expect(store.getTask(direct.id)?.reviewEnteredAt).toBe(direct.reviewEnteredAt);
    } finally {
      store.close();
    }
  });

  it("backfills existing review cards and keeps their round after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "amo-studio-test-review-"));
    const path = join(dir, "studio.db");
    const updatedAt = "2026-11-09T00:00:00.000Z";
    try {
      // Build the last pre-reminder schema directly so later task/session columns cannot leak into the fixture.
      const legacy = new DatabaseSync(path);
      try {
        legacy.exec("PRAGMA foreign_keys = OFF; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
        const record = legacy.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
        for (const [index, migration] of MIGRATIONS.slice(0, 27).entries()) {
          legacy.exec(typeof migration === "string" ? migration : migration.sql);
          record.run(index + 1, updatedAt);
        }
        legacy.prepare("INSERT INTO workspaces (id, name, path, created_at) VALUES ('w', 'migration', 'C:/sandbox/migration', ?)").run(updatedAt);
        legacy.prepare("INSERT INTO tasks (id, title, workspace_id, column_name, created_at, updated_at) VALUES ('t', 'Old review', 'w', 'review', ?, ?)").run(updatedAt, updatedAt);
      } finally {
        legacy.close();
      }
      for (let run = 0; run < 2; run++) {
        const store = new Store(path);
        try { expect(store.getTask("t")?.reviewEnteredAt).toBe(updatedAt); }
        finally { store.close(); }
      }
    } finally {
      removeTempDir(dir);
    }
  });
});
