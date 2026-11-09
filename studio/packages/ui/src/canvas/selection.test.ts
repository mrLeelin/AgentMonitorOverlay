import { expect, it } from "vitest";
import { polylineIntersectsRect } from "./selection.js";

it("selects lines crossing the box even when both endpoints lie outside", () => {
  expect(polylineIntersectsRect([{ x: -20, y: 5 }, { x: 20, y: 5 }], { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
  expect(polylineIntersectsRect([{ x: 5, y: -20 }, { x: 5, y: 20 }], { x: 0, y: 0, w: 10, h: 10 })).toBe(true);
});

it("does not select a diagonal or bent line just because its bounding box overlaps", () => {
  expect(polylineIntersectsRect([{ x: 0, y: 0 }, { x: 100, y: 100 }], { x: 0, y: 80, w: 10, h: 10 })).toBe(false);
  expect(polylineIntersectsRect([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], { x: 40, y: 40, w: 10, h: 10 })).toBe(false);
});

it("handles a segment inside the box, touching its edge and a zero-length line", () => {
  const box = { x: -10, y: -10, w: 20, h: 20 };
  expect(polylineIntersectsRect([{ x: 0, y: 0 }, { x: 5, y: 5 }], box)).toBe(true);
  expect(polylineIntersectsRect([{ x: -30, y: -10 }, { x: 30, y: -10 }], box)).toBe(true);
  expect(polylineIntersectsRect([{ x: 30, y: 30 }, { x: 30, y: 30 }], box)).toBe(false);
  expect(polylineIntersectsRect([{ x: 0, y: 0 }, { x: 0, y: 0 }], box)).toBe(true);
});
