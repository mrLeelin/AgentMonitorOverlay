import { afterEach, expect, test, vi } from "vitest";
import { badgeImage } from "./useTaskbarBadge.js";

afterEach(() => vi.unstubAllGlobals());
test("badge clears at zero and draws readable counts capped at 99+", () => {
  const fillText = vi.fn();
  const ctx = { fillText, beginPath() {}, arc() {}, fill() {} };
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "data:image/png;base64,test" };
  vi.stubGlobal("document", { createElement: () => canvas });
  expect(badgeImage(0)).toBeNull();
  for (const count of [1, 12, 99, 100, 1000]) expect(badgeImage(count)).toBe("data:image/png;base64,test");
  expect(fillText.mock.calls.map((args) => args[0])).toEqual(["1", "12", "99", "99+", "99+"]);
  expect(canvas.width).toBe(32);
  expect(canvas.height).toBe(32);
});
