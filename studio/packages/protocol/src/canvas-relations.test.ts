import { describe, expect, it } from "vitest";
import { emptyCanvas, validateCanvas } from "./canvas.js";
import type { CanvasDoc, CanvasLink } from "./entities.js";

const line = (id: string, from: string, to: string): CanvasLink => ({ id, from, to, fromSide: "right", toSide: "left" });
const doc = (links: CanvasLink[] = []): CanvasDoc => ({ ...emptyCanvas(), nodes: ["a", "b", "c", "d"].map((id) => ({ id, kind: "note", text: id, groupId: null, pos: { x: 0, y: 0 } })), links });

describe("canvas relation validation", () => {
  it("rejects ordinary duplicates across sides and labels", () => {
    const d = doc([line("ab", "a", "b"), { ...line("ab2", "a", "b"), fromSide: "top", label: "独有说明" }]);
    expect(validateCanvas(d, new Set()).join()).toMatch(/duplicate.*ab.*ab2/);
  });
  it("rejects two-node and long ordinary cycles", () => {
    expect(validateCanvas(doc([line("ab", "a", "b"), line("ba", "b", "a")]), new Set()).join()).toMatch(/cycle.*a → b → a/);
    expect(validateCanvas(doc([line("ab", "a", "b"), line("bc", "b", "c"), line("ca", "c", "a")]), new Set()).join()).toMatch(/cycle/);
  });
});
