import { describe, expect, it } from "vitest";
import { recordedDiffRows, turnDiff } from "./turnDiff.js";
import { parseReviewHash, reviewHash } from "./logic.js";

describe("recorded turn review", () => {
  it("keeps hunk line numbers and repeated edits without reading the current file", () => {
    const diff = turnDiff({ path: "a.ts", change: "update", added: 2, removed: 2, diff: "@@ -10,2 +12,2 @@\n same\n-before\n+after\n@@ -13 +13 @@\n-after\n+last\n" });
    expect(diff.lines).toEqual([
      { kind: "context", text: "same", oldLine: 10, newLine: 12 },
      { kind: "del", text: "before", oldLine: 11, newLine: null },
      { kind: "add", text: "after", oldLine: null, newLine: 13 },
      { kind: "del", text: "after", oldLine: 13, newLine: null },
      { kind: "add", text: "last", oldLine: null, newLine: 13 },
    ]);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]).toEqual({ start: 0, end: 3, oldStart: 10, newStart: 12, oldCount: 2, newCount: 2 });
  });

  it("supports raw new-file text, deleted files, and records without patch content", () => {
    expect(turnDiff({ path: "new.txt", change: "add", added: 2, removed: 0, diff: "one\ntwo\n" }).lines).toEqual([
      { kind: "add", text: "one", oldLine: null, newLine: 1 },
      { kind: "add", text: "two", oldLine: null, newLine: 2 },
    ]);
    expect(turnDiff({ path: "old.txt", change: "delete", added: 0, removed: 1, diff: "@@ -4 +0,0 @@\n-gone" }).lines).toEqual([{ kind: "del", text: "gone", oldLine: 4, newLine: null }]);
    expect(turnDiff({ path: "a.bin", change: "update", added: 0, removed: 0 }).lines).toEqual([]);
  });

  it("preserves the turn, session and selected file in its address", () => {
    const target = { workspaceId: "ws", sessionId: "s", turnItemId: "item/1", file: "src/a.ts", nonce: "2" };
    expect(parseReviewHash(reviewHash(target))).toEqual(target);
    expect(parseReviewHash("#review?workspace=ws&turnItem=i")).toBeNull();
    expect(parseReviewHash("#review?workspace=ws&session=s&turnItem=i&commit=abc1234")).toBeNull();
  });

  it("keeps separate records for a new file, a later patch, and an edit without diff content", () => {
    const rows = recordedDiffRows([
      { path: "a.txt", change: "add", added: 1, removed: 0, diff: "first version" },
      { path: "a.txt", change: "update", added: 1, removed: 1, diff: "-first version\n+second version" },
      { path: "a.txt", change: "delete", added: 0, removed: 1 },
    ]);
    expect(rows.filter((row) => row.kind === "hunk").map((row) => row.header)).toEqual([
      "第 1 次改动 · @@ -1,0 +1,1 @@", "第 2 次改动 · @@ -1,1 +1,1 @@", "第 3 次改动 · 没有保存差异内容",
    ]);
    const lines = rows.filter((row) => row.kind === "line");
    expect(lines.map(({ line }) => [line.kind, line.text])).toEqual([["add", "first version"], ["del", "first version"], ["add", "second version"]]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("addresses a session's recorded changes separately from single-turn and Git reviews", () => {
    const target = { workspaceId: "ws", sessionId: "s", sessionChanges: true as const };
    expect(parseReviewHash(reviewHash(target))).toEqual(target);
    expect(parseReviewHash("#review?workspace=ws&sessionChanges=1")).toBeNull();
    for (const scope of ["turnItem=i", "worktree=s", "remote=t", "commit=abc1234"]) {
      expect(parseReviewHash(`${reviewHash(target)}&${scope}`)).toBeNull();
    }
  });
});
