import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasItem, type CanvasLink } from "@amo-studio/protocol";
import { discussionContext } from "./context.js";

const item = (id: string, num: number): CanvasItem => ({ id, num, kind: "item", title: `条目${num}`, status: "todo", sessionId: null, groupId: null, pos: { x: 0, y: 0 } });
const link = (from: string, to: string): CanvasLink => ({ id: `${from}-${to}`, from, to, fromSide: "right", toSide: "left" });

describe("discussion context", () => {
  it("includes direct neighbours with direction, status and evidence, excluding indirect and unlinked cards", () => {
    const current = item("a", 1);
    const doc = { ...emptyCanvas(), nodes: [current, { ...item("b", 2), status: "confirmed" as const, conclusion: "已定结论", refs: ["source.ts"] }, { ...item("c", 3), body: "待讨论的内容" }, item("d", 4)], links: [{ ...link("b", "a"), label: "参考" }, link("a", "c"), link("c", "d")] };
    const text = discussionContext(doc, current, () => undefined).join("\n");
    expect(text).toContain("关联卡 → 本卡；标签：参考");
    expect(text).toContain("本卡 → 关联卡");
    expect(text).toContain("【已确认】");
    expect(text).toContain("结论：已定结论");
    expect(text).toContain("source.ts");
    expect(text).toContain("尚无结论；正文摘要：待讨论的内容");
    expect(text).not.toContain("条目4");
    expect(discussionContext({ ...doc, links: [] }, current, () => undefined)).toEqual([]);
  });

  it("bounds long content and neighbour counts, ignores dangling links and handles notes and missing task references", () => {
    const current = item("a", 1);
    const others = Array.from({ length: 10 }, (_, i) => ({ ...item(`b${i}`, i + 2), conclusion: "长".repeat(20000) }));
    const doc = { ...emptyCanvas(), nodes: [current, ...others], links: [...others.map((n) => link(n.id, current.id)), link("gone", current.id)] };
    const text = discussionContext(doc, current, () => undefined).join("\n");
    expect(text).toContain("另有 2 张直接关联卡未展开");
    expect(text.length).toBeLessThan(7000);
    expect(text).not.toContain("gone");
    const mixed = { ...emptyCanvas(), nodes: [current, { id: "note", kind: "note" as const, text: "注意事项", groupId: null, pos: { x: 0, y: 0 } }, { id: "ref", kind: "ref" as const, taskId: "deleted", groupId: null, pos: { x: 0, y: 0 } }], links: [link("a", "note"), link("ref", "a")] };
    const summary = discussionContext(mixed, current, () => undefined).join("\n");
    expect(summary).toContain("普通连线：本卡 → 关联卡");
    expect(summary).toContain("便签：注意事项");
    expect(summary).toContain("任务已不存在");
  });
});
