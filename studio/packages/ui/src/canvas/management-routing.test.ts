import { expect, it } from "vitest";
import type { Point, Rect } from "@amo-studio/protocol";
import { managementPath } from "./management-routing.js";

const crosses = (a: Point, b: Point, r: Rect) => a.x === b.x ? a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h : a.y > r.y && a.y < r.y + r.h && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;

it("uses one branch row for siblings, leaving the parent's bottom and arriving at their tops", () => {
  const parent = { x: 150, y: 0, w: 200, h: 100 };
  const left = { x: 0, y: 240, w: 200, h: 100 };
  const right = { x: 300, y: 240, w: 200, h: 100 };
  expect(managementPath(parent, left, [parent, left, right], 170).points).toEqual([{ x: 250, y: 100 }, { x: 250, y: 170 }, { x: 100, y: 170 }, { x: 100, y: 240 }]);
  expect(managementPath(parent, right, [parent, left, right], 170).points).toEqual([{ x: 250, y: 100 }, { x: 250, y: 170 }, { x: 400, y: 170 }, { x: 400, y: 240 }]);
});

it("routes around an intervening card instead of drawing through it", () => {
  const parent = { x: 200, y: 0, w: 200, h: 100 };
  const child = { x: 200, y: 480, w: 200, h: 100 };
  const blocker = { x: 150, y: 200, w: 300, h: 160 };
  const { points } = managementPath(parent, child, [parent, child, blocker]);
  expect(points[0]).toEqual({ x: 300, y: 100 });
  expect(points.at(-1)).toEqual({ x: 300, y: 480 });
  expect(points.some((p) => p.x <= 134 || p.x >= 466)).toBe(true);
  for (let i = 1; i < points.length; i++) {
    expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
    for (const r of [parent, child, blocker]) expect(crosses(points[i - 1]!, points[i]!, r)).toBe(false);
  }
});

it("routes a manually positioned child above its parent without cutting through either card", () => {
  const parent = { x: 150, y: 400, w: 220, h: 100 };
  const child = { x: 150, y: 0, w: 220, h: 100 };
  const { points } = managementPath(parent, child, [parent, child]);
  expect(points.length).toBeGreaterThan(2);
  for (let i = 1; i < points.length; i++) for (const r of [parent, child]) expect(crosses(points[i - 1]!, points[i]!, r)).toBe(false);
});
