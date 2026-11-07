import type { Point, Rect } from "@amo-studio/protocol";

const CLEARANCE = 16;
const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const inside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
const crosses = (a: Point, b: Point, r: Rect) => a.x === b.x ? a.x > r.x && a.x < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h : a.y > r.y && a.y < r.y + r.h && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w;
const clear = (points: readonly Point[], obstacles: readonly Rect[]) => points.every((p, i) => !i || obstacles.every((r) => !crosses(points[i - 1]!, p, r)));

/** A shared branch row keeps siblings on one trunk; obstacle routing also supports hand-arranged cards. */
export function managementPath(from: Rect, to: Rect, cards: readonly Rect[], branchY?: number): { d: string; points: Point[] } {
  const a = { x: from.x + from.w / 2, y: from.y + from.h };
  const b = { x: to.x + to.w / 2, y: to.y };
  const obstacles = [from, to, ...cards.filter((r) => !sameRect(r, from) && !sameRect(r, to)).map((r) => ({ x: r.x - CLEARANCE, y: r.y - CLEARANCE, w: r.w + CLEARANCE * 2, h: r.h + CLEARANCE * 2 }))];
  const row = branchY ?? (a.y + b.y) / 2;
  let points = [a, { x: a.x, y: row }, { x: b.x, y: row }, b];
  if (!clear(points, obstacles)) {
    // Most manual arrangements only need a side corridor; avoid constructing a grid for those cases.
    const lanes = [...new Set(obstacles.flatMap((r) => [r.x, r.x + r.w]))].sort((x, y) => Math.abs(x - a.x) + Math.abs(x - b.x) - Math.abs(y - a.x) - Math.abs(y - b.x));
    const detour = lanes.map((x) => [a, { x: a.x, y: a.y + CLEARANCE }, { x, y: a.y + CLEARANCE }, { x, y: b.y - CLEARANCE }, { x: b.x, y: b.y - CLEARANCE }, b]).find((path) => clear(path, obstacles));
    points = detour ?? route(a, b, obstacles) ?? points;
  }
  points = points.filter((p, i) => !i || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y);
  points = points.filter((p, i) => !i || i === points.length - 1 || !((points[i - 1]!.x === p.x && p.x === points[i + 1]!.x) || (points[i - 1]!.y === p.y && p.y === points[i + 1]!.y)));
  return { points, d: points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ") };
}

// A rectilinear visibility grid is only needed when the cheap shared trunk meets a card. A* visits the
// nearby corridors first; coordinates on obstacle boundaries let a route turn around any finite rectangle.
function route(a: Point, b: Point, obstacles: readonly Rect[]): Point[] | null {
  if (obstacles.some((r) => inside(a, r) || inside(b, r))) return null;
  const xs = [...new Set([a.x, b.x, ...obstacles.flatMap((r) => [r.x, r.x + r.w])])].sort((x, y) => x - y);
  const ys = [...new Set([a.y, b.y, ...obstacles.flatMap((r) => [r.y, r.y + r.h])])].sort((x, y) => x - y);
  const id = (x: number, y: number) => y * xs.length + x;
  const start = id(xs.indexOf(a.x), ys.indexOf(a.y));
  const end = id(xs.indexOf(b.x), ys.indexOf(b.y));
  const point = (n: number): Point => ({ x: xs[n % xs.length]!, y: ys[Math.floor(n / xs.length)]! });
  const distance = new Map<number, number>([[start, 0]]);
  const previous = new Map<number, number>();
  const queue: { id: number; score: number }[] = [];
  const push = (entry: typeof queue[number]) => {
    queue.push(entry);
    let i = queue.length - 1;
    while (i > 0) { const parent = (i - 1) >> 1; if (queue[parent]!.score <= entry.score) break; queue[i] = queue[parent]!; i = parent; }
    queue[i] = entry;
  };
  const pop = () => {
    const first = queue[0]!;
    const last = queue.pop()!;
    if (queue.length) {
      let i = 0;
      while (i * 2 + 1 < queue.length) { let child = i * 2 + 1; if (child + 1 < queue.length && queue[child + 1]!.score < queue[child]!.score) child += 1; if (last.score <= queue[child]!.score) break; queue[i] = queue[child]!; i = child; }
      queue[i] = last;
    }
    return first.id;
  };
  push({ id: start, score: 0 });
  const visited = new Set<number>();
  while (queue.length) {
    const current = pop();
    if (visited.has(current)) continue;
    if (current === end) {
      const path = [b];
      let step = end;
      while (step !== start) { step = previous.get(step)!; path.push(point(step)); }
      return path.reverse();
    }
    visited.add(current);
    const p = point(current);
    const x = current % xs.length;
    const y = Math.floor(current / xs.length);
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx! < 0 || nx! >= xs.length || ny! < 0 || ny! >= ys.length) continue;
      const next = id(nx!, ny!);
      const q = point(next);
      if (visited.has(next) || obstacles.some((r) => inside(q, r) || crosses(p, q, r))) continue;
      const cost = distance.get(current)! + Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (cost >= (distance.get(next) ?? Infinity)) continue;
      distance.set(next, cost);
      previous.set(next, current);
      push({ id: next, score: cost + Math.abs(q.x - b.x) + Math.abs(q.y - b.y) });
    }
  }
  return null;
}
