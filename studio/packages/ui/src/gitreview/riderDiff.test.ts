import { describe, expect, it } from "vitest";
import { recordedDiffRows } from "./turnDiff.js";
import { riderHunks, type RiderLine } from "./riderDiff.js";

const patch = (diff: string) => ({ path: "Example.cs", change: "update" as const, added: 0, removed: 0, diff });
const marked = (line: RiderLine) => line.marks.map(({ start, end }) => line.row.line.text.slice(start, end));

describe("Rider diff", () => {
  it("links the reindented calls inside a new if/else and tapers the surrounding insertions", () => {
    const rows = recordedDiffRows([patch([
      "@@ -10,4 +10,10 @@", " {", "-    ShowHammer();", "-    Spawn(1001);",
      "+    if (value > 0)", "+    {", "+        ShowHammer();", "+        Spawn(1001);",
      "+    }", "+    else", "+        Spawn(1002);", "+    Finish();", " }",
    ].join("\n"))]);
    const [hunk] = riderHunks(rows);
    expect(hunk!.bands).toEqual([
      { kind: "add", leftStart: 1, leftEnd: 1, rightStart: 1, rightEnd: 3 },
      { kind: "change", leftStart: 1, leftEnd: 3, rightStart: 3, rightEnd: 5 },
      { kind: "add", leftStart: 3, leftEnd: 3, rightStart: 5, rightEnd: 9 },
    ]);
    for (const line of [...hunk!.left, ...hunk!.right]) expect(line.row).toBe(rows[line.index]);
    expect(hunk!.right.map((l) => l.row.line.newLine)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(marked(hunk!.left[1]!)).toEqual([]);
    expect(hunk!.right[3]!.marks).toEqual([{ start: 4, end: 8 }]);
  });

  it("marks just the removed constructor parameter and separate edited words", () => {
    const rows = recordedDiffRows([patch([
      "@@ -24,2 +24,2 @@", "-Create(bool fromLogin = false, int comboRate = 0)", "-Set(red, stable, low);",
      "+Create(bool fromLogin = false)", "+Set(blue, stable, high);",
    ].join("\n"))]);
    const [hunk] = riderHunks(rows);
    expect(marked(hunk!.left[0]!)).toEqual([", int comboRate = 0"]);
    expect(marked(hunk!.right[0]!)).toEqual([]);
    expect(marked(hunk!.left[1]!)).toEqual(["red", "low"]);
    expect(marked(hunk!.right[1]!)).toEqual(["blue", "high"]);
  });

  it("separates each recorded hunk, including empty edits and reused line numbers", () => {
    const rows = recordedDiffRows([patch("@@ -13 +13,0 @@\n-ComboRate = 3;"), patch("@@ -13,0 +13 @@\n+ComboRate = 3;"), patch("")]);
    const hunks = riderHunks(rows);
    expect(hunks.map((h) => h.header?.header)).toEqual(["第 1 次改动 · @@ -13,1 +13,0 @@", "第 2 次改动 · @@ -13,0 +13,1 @@", "第 3 次改动 · 没有保存差异内容"]);
    expect(hunks.map((h) => h.bands)).toEqual([
      [{ kind: "del", leftStart: 0, leftEnd: 1, rightStart: 0, rightEnd: 0 }],
      [{ kind: "add", leftStart: 0, leftEnd: 0, rightStart: 0, rightEnd: 1 }],
      [],
    ]);
  });

  it("keeps anchors across large insertions without quadratic alignment", () => {
    const lines = Array.from({ length: 1200 }, (_, i) => `call${i}();`);
    const rows = recordedDiffRows([patch([...lines.map((s) => "-" + s), "+open();", ...lines.map((s) => "+    " + s), "+close();"].join("\n"))]);
    const [hunk] = riderHunks(rows);
    expect(hunk!.bands).toHaveLength(3);
    expect(hunk!.bands[1]).toEqual({ kind: "change", leftStart: 0, leftEnd: 1200, rightStart: 1, rightEnd: 1201 });
  });

  it("highlights each edited argument in a bulk rename", () => {
    const before = Array.from({ length: 150 }, (_, i) => `SetReward(${i}, before);`);
    const diff = [...before.map((s) => "-" + s), ...before.map((s) => "+" + s.replace("before", "after"))].join("\n");
    const [hunk] = riderHunks(recordedDiffRows([patch(diff)]));
    expect(hunk!.left.map(marked)).toEqual(before.map(() => ["before"]));
    expect(hunk!.right.map(marked)).toEqual(before.map(() => ["after"]));
  });
});
