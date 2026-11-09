import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempDir } from "@amo-studio/testkit";
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
    let store = new Store(path);
    try {
      const ws = store.addWorkspace({ name: "migration", path: "C:/sandbox/migration" });
      const task = store.createTask({ title: "Old review", workspaceId: ws.id, column: "review" });
      // Exercise the migration against an actual pre-reminder schema, keeping existing card times.
      store.db.exec("ALTER TABLE tasks DROP COLUMN review_entered_at; DELETE FROM schema_migrations WHERE version = 28;");
      store.close();
      store = new Store(path);
      expect(store.getTask(task.id)?.reviewEnteredAt).toBe(task.updatedAt);
      store.close();
      store = new Store(path);
      expect(store.getTask(task.id)?.reviewEnteredAt).toBe(task.updatedAt);
    } finally {
      store.close();
      removeTempDir(dir);
    }
  });
});
