import type { Point, Rect } from "@amo-studio/protocol";

/** Test the actual line segments, so an empty corner of a curve's bounding box does not select the curve. */
export function polylineIntersectsRect(points: readonly Point[], rect: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    let lo = 0;
    let hi = 1;
    for (const [start, delta, min, max] of [[a.x, b.x - a.x, rect.x, rect.x + rect.w], [a.y, b.y - a.y, rect.y, rect.y + rect.h]] as const) {
      if (delta === 0) {
        if (start < min || start > max) { hi = -1; break; }
      } else {
        const t1 = (min - start) / delta;
        const t2 = (max - start) / delta;
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
      }
    }
    if (lo <= hi) return true;
  }
  return false;
}

/** Snapshot rendered curves at gesture start: each sample is in the canvas world's coordinates. */
export function canvasLinePolylines(world: HTMLElement | null): Array<{ key: string; points: Point[] }> {
  return [...(world?.querySelectorAll<SVGGeometryElement>("[data-line-selection]") ?? [])].map((line) => {
    const length = line.getTotalLength();
    const count = Math.max(1, Math.min(512, Math.ceil(length / 8)));
    return { key: line.getAttribute("data-line-selection")!, points: Array.from({ length: count + 1 }, (_, i) => {
      const p = line.getPointAtLength(length * i / count);
      return { x: p.x, y: p.y };
    }) };
  });
}
