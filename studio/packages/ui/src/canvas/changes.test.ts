import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasItem } from "@amo-studio/protocol";
import { parseSeenItems, reviewChanges, reviewSnapshot } from "./changes.js";

const item: CanvasItem = { id: "item", kind: "item", num: 1, title: "兼容性", body: "旧协议", status: "todo", sessionId: null, pos: { x: 0, y: 0 }, groupId: null };
const snapshot = (patch: Partial<CanvasItem> = {}) => reviewSnapshot({ ...emptyCanvas(), nodes: [{ ...item, ...patch }] });

describe("review change markers", () => {
  it("tracks content fields without interpreting layout or discussion activity as changes", () => {
    const seen = snapshot();
    expect(reviewChanges(snapshot({ pos: { x: 50, y: 60 }, color: "red", size: { w: 300, h: 200 }, threads: ["discussion"], groupId: "group" }), seen).size).toBe(0);
    const changed = reviewChanges(snapshot({ body: "新协议", conclusion: "兼容一个版本", status: "confirmed" }), seen);
    expect(changed.get(item.id)).toEqual({ label: "已更新", detail: "自上次标为已看后，正文、结论、状态有变化" });
    expect(reviewChanges(snapshot({ title: "新标题", refs: ["source.ts"] }), seen).get(item.id)?.detail).toContain("标题、引用");
    expect(reviewChanges(snapshot(), seen).size).toBe(0);
  });

  it("marks additions, ignores removals and distinguishes clearing content", () => {
    expect(reviewChanges(snapshot(), {}).get(item.id)?.label).toBe("新增");
    expect(reviewChanges({}, snapshot()).size).toBe(0);
    expect(reviewChanges(snapshot({ body: "" }), snapshot()).get(item.id)?.detail).toContain("正文");
    expect(reviewChanges(snapshot({ conclusion: "" }), snapshot({ conclusion: "已决定" })).get(item.id)?.detail).toContain("结论");
  });

  it("persists validated fingerprints instead of review text and rejects corrupt storage", () => {
    const seen = snapshot();
    expect(JSON.stringify(seen)).not.toContain("旧协议");
    expect(parseSeenItems(JSON.parse(JSON.stringify(seen)))).toEqual(seen);
    for (const bad of [null, [], "bad", { item: [] }, { item: [1, 2, 3, 4, 5] }, { item: ["oops", "oops", "oops", "oops", "oops"] }]) expect(parseSeenItems(bad)).toBeNull();
    expect(parseSeenItems({})).toEqual({});
  });
});
