import { describe, expect, it } from "vitest";
import { turnDiff } from "./turnDiff.js";
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
});
