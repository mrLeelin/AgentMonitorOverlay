import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc, type CanvasLink } from "@amo-studio/protocol";
import { addLink, reverseEdge, reverseLink } from "./geometry.js";

const line = (id: string, from: string, to: string): CanvasLink => ({ id, from, to, fromSide: "right", toSide: "left" });
const doc = (links: CanvasLink[] = []): CanvasDoc => ({ ...emptyCanvas(), nodes: ["a", "b", "c"].map((id) => ({ id, kind: "note", text: id, groupId: null, pos: { x: 0, y: 0 } })), links });

describe("shared relation edits", () => {
  it("refuses cross-side duplicates, self links and new directed cycles", () => {
    const d = doc([line("ab", "a", "b"), line("bc", "b", "c")]);
    expect(() => addLink(d, { ...line("copy", "a", "b"), fromSide: "top" })).toThrow(/已存在/);
    expect(() => addLink(d, line("aa", "a", "a"))).toThrow(/自身/);
    expect(() => addLink(d, line("ba", "b", "a"))).toThrow(/循环.*a/);
    expect(() => addLink(d, line("ca", "c", "a"))).toThrow(/循环.*a/);
    expect(d.links).toHaveLength(2);
  });
  it("validates reversing ordinary lines and dependencies without partially editing", () => {
    const d = doc([line("ab", "a", "b"), line("bc", "b", "c"), line("ac", "a", "c")]);
    expect(() => reverseLink(d, "ac")).toThrow(/循环/);
    const dirty = doc([line("ab", "a", "b"), line("ba", "b", "a")]);
    expect(() => reverseLink(dirty, "ba")).toThrow(/已存在/);
    const dep = { ...doc(), edges: d.links!.map((l) => ({ id: l.id, from: l.from, to: l.to, kind: "depends" as const })) };
    expect(() => reverseEdge(dep, "ac")).toThrow(/循环/);
    expect(reverseLink(doc([line("ab", "a", "b")]), "ab").links![0]).toMatchObject({ from: "b", to: "a", fromSide: "left", toSide: "right" });
  });
});
