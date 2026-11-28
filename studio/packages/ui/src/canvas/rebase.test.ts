import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode } from "@amo-studio/protocol";
import { rebaseCanvas } from "./rebase.js";

const node = (id: string, x: number): CanvasNode => ({ id, kind: "task", taskId: id, pos: { x, y: 0 }, groupId: null });
const doc = (nodes: CanvasNode[], version = 1): CanvasDoc => ({ id: "topic", version, nodes, edges: [], groups: [], updatedAt: "" });

describe("canvas concurrent edits", () => {
  it("reapplies a drag and keeps the positions and newly added cards from another window", () => {
    const base = doc([node("a", 0), node("b", 10)]);
    const local = doc([node("a", 40), node("b", 10)]);
    const host = doc([node("a", 0), node("b", 50), node("new", 100)], 2);
    expect(rebaseCanvas(base, local, host)).toEqual({ doc: { ...host, links: [], nodes: [node("a", 40), node("b", 50), node("new", 100)] }, skipped: false });
  });

  it("keeps the Host value for overlapping edits and never recreates a moved card that was removed", () => {
    const base = doc([node("a", 0), node("b", 10)]);
    const local = doc([node("a", 40), node("b", 70)]);
    const host = doc([node("a", 60)], 4);
    expect(rebaseCanvas(base, local, host)).toEqual({ doc: host, skipped: true });
  });
});
