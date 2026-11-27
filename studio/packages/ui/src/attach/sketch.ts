export const SKETCH_WIDTH = 960;
export const SKETCH_HEIGHT = 600;

export const SHAPES = {
  line: "直线", arrow: "箭头", rect: "矩形", ellipse: "椭圆",
  triangle: "三角形", diamond: "菱形", star: "星形", heart: "心形",
} as const;

export type Shape = keyof typeof SHAPES;
export type Point = { x: number; y: number };

const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;

export function constrainShape(shape: Shape, start: Point, end: Point): Point {
  if (shape === "line" || shape === "arrow") {
    const octant = Math.round(Math.atan2(end.y, end.x) / (Math.PI / 4));
    const [x, y] = DIRECTIONS[(octant + 8) % 8]!;
    const projected = (end.x * x + end.y * y) / (x * x + y * y);
    const availableX = x === 0 ? Infinity : x < 0 ? start.x : SKETCH_WIDTH - start.x;
    const availableY = y === 0 ? Infinity : y < 0 ? start.y : SKETCH_HEIGHT - start.y;
    const step = Math.min(projected, availableX, availableY);
    return { x: x * step, y: y * step };
  }

  const left = end.x < 0, up = end.y < 0;
  const availableX = left ? start.x : SKETCH_WIDTH - start.x;
  const availableY = up ? start.y : SKETCH_HEIGHT - start.y;
  // The triangle's path touches its top and base. The other shapes use a square construction box.
  const heightRatio = shape === "triangle" ? Math.sqrt(3) / 2 : 1;
  const width = Math.min(Math.max(Math.abs(end.x), Math.abs(end.y) / heightRatio), availableX, availableY / heightRatio);
  return { x: left ? -width : width, y: (up ? -width : width) * heightRatio };
}

export type EraserStroke = { diameter: number; points: readonly Point[] };
type Erasure = { stroke: EraserStroke; origin: Point };
type Mark = { id: number; at: Point; color: string; width: number; erasures?: readonly Erasure[] };
export type SketchMark =
  | Mark & { kind: "pen"; points: readonly Point[] }
  | Mark & { kind: "shape"; shape: Shape; end: Point }
  | Mark & { kind: "text"; text: string };

type Bounds = { x: number; y: number; w: number; h: number };
const textSize = (mark: Mark) => 16 + mark.width * 2;
const textFont = (mark: Mark) => `${textSize(mark)}px "Microsoft YaHei UI", "Segoe UI", sans-serif`;

function shapePath(shape: Shape, end: Point, width: number): Path2D {
  const path = new Path2D();
  if (shape === "line" || shape === "arrow") {
    path.moveTo(0, 0);
    path.lineTo(end.x, end.y);
    if (shape === "arrow") {
      const angle = Math.atan2(end.y, end.x);
      const length = Math.min(width * 2 + 12, Math.hypot(end.x, end.y) * 0.65);
      for (const side of [-1, 1]) {
        const arm = angle + side * Math.PI / 6;
        path.moveTo(end.x, end.y);
        path.lineTo(end.x - length * Math.cos(arm), end.y - length * Math.sin(arm));
      }
    }
    return path;
  }

  const x = Math.min(0, end.x), y = Math.min(0, end.y);
  const w = Math.max(1, Math.abs(end.x)), h = Math.max(1, Math.abs(end.y));
  const middle = x + w / 2, center = y + h / 2;
  if (shape === "rect") path.rect(x, y, w, h);
  if (shape === "ellipse") path.ellipse(middle, center, w / 2, h / 2, 0, 0, 2 * Math.PI);
  if (shape === "heart") {
    path.moveTo(middle, y + h);
    path.bezierCurveTo(x + w * 0.37, y + h * 0.85, x, y + h * 0.55, x, y + h * 0.28);
    path.bezierCurveTo(x, y - h * 0.02, x + w * 0.36, y - h * 0.13, middle, y + h * 0.19);
    path.bezierCurveTo(x + w * 0.64, y - h * 0.13, x + w, y - h * 0.02, x + w, y + h * 0.28);
    path.bezierCurveTo(x + w, y + h * 0.55, x + w * 0.63, y + h * 0.85, middle, y + h);
    path.closePath();
  }
  if (shape === "triangle" || shape === "diamond" || shape === "star") {
    path.moveTo(middle, y);
    if (shape === "triangle") {
      path.lineTo(x + w, y + h);
      path.lineTo(x, y + h);
    } else if (shape === "diamond") {
      path.lineTo(x + w, center);
      path.lineTo(middle, y + h);
      path.lineTo(x, center);
    } else {
      for (let index = 1; index < 10; index++) {
        const angle = index * Math.PI / 5;
        const radius = index % 2 ? 0.44 : 1;
        path.lineTo(middle + Math.sin(angle) * w / 2 * radius, center - Math.cos(angle) * h / 2 * radius);
      }
    }
    path.closePath();
  }
  return path;
}

function markPath(mark: Exclude<SketchMark, { kind: "text" }>) {
  if (mark.kind === "shape") return shapePath(mark.shape, mark.end, mark.width);
  const path = new Path2D();
  path.moveTo(0, 0);
  if (!mark.points.length) path.lineTo(0.01, 0);
  for (const point of mark.points) path.lineTo(point.x, point.y);
  return path;
}

function bounds(ctx: CanvasRenderingContext2D, mark: SketchMark): Bounds {
  if (mark.kind === "text") {
    ctx.font = textFont(mark);
    return { x: 0, y: 0, w: Math.min(SKETCH_WIDTH - 16, ctx.measureText(mark.text).width), h: textSize(mark) * 1.3 };
  }
  const points = mark.kind === "pen" ? mark.points : [mark.end];
  let left = 0, top = 0, right = 0, bottom = 0;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  const pad = mark.kind === "shape" && mark.shape === "arrow" ? mark.width * 2 + 12 : mark.width / 2;
  return { x: left - pad, y: top - pad, w: right - left + pad * 2, h: bottom - top + pad * 2 };
}

export function fitSketchText(ctx: CanvasRenderingContext2D, mark: SketchMark): SketchMark {
  const { w, h } = bounds(ctx, mark);
  return { ...mark, at: { x: Math.max(6, Math.min(mark.at.x, SKETCH_WIDTH - 8 - w)), y: Math.max(4, Math.min(mark.at.y, SKETCH_HEIGHT - 8 - h)) } };
}

const eraserPaths = new WeakMap<EraserStroke, Path2D>();
function eraserPath(stroke: EraserStroke) {
  const cached = eraserPaths.get(stroke);
  if (cached) return cached;
  const path = new Path2D();
  const first = stroke.points[0]!;
  path.moveTo(first.x, first.y);
  if (stroke.points.length === 1) path.lineTo(first.x + 0.01, first.y);
  for (const point of stroke.points.slice(1)) path.lineTo(point.x, point.y);
  eraserPaths.set(stroke, path);
  return path;
}

function eraseInk(ctx: CanvasRenderingContext2D, stroke: EraserStroke, shiftX = 0, shiftY = 0) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#000";
  ctx.lineWidth = stroke.diameter;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.translate(shiftX, shiftY);
  ctx.stroke(eraserPath(stroke));
  ctx.restore();
}

export function sketchHit(ctx: CanvasRenderingContext2D, marks: readonly SketchMark[], point: Point) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const hit = marks.findLast((mark) => {
    const x = point.x - mark.at.x, y = point.y - mark.at.y;
    if (mark.erasures?.some(({ stroke, origin }) => {
      ctx.lineWidth = stroke.diameter;
      return ctx.isPointInStroke(eraserPath(stroke), x + origin.x, y + origin.y);
    })) return false;
    if (mark.kind === "text") {
      const box = bounds(ctx, mark);
      return x >= -5 && x <= box.w + 5 && y >= -5 && y <= box.h + 5;
    }
    const path = markPath(mark);
    ctx.lineWidth = mark.width + 14;
    return ctx.isPointInStroke(path, x, y) || (mark.kind === "shape" && ctx.isPointInPath(path, x, y));
  });
  ctx.restore();
  return hit;
}

function paintMark(ctx: CanvasRenderingContext2D, mark: SketchMark) {
  ctx.save();
  ctx.translate(mark.at.x, mark.at.y);
  if (mark.kind === "text") {
    ctx.fillStyle = mark.color;
    ctx.font = textFont(mark);
    ctx.textBaseline = "top";
    ctx.fillText(mark.text, 0, 0, SKETCH_WIDTH - 16);
  } else {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = mark.color;
    ctx.lineWidth = mark.width;
    ctx.stroke(markPath(mark));
  }
  ctx.restore();
}

let inkLayer: CanvasRenderingContext2D | undefined;
function layer() {
  if (!inkLayer) {
    const canvas = document.createElement("canvas");
    canvas.width = SKETCH_WIDTH;
    canvas.height = SKETCH_HEIGHT;
    inkLayer = canvas.getContext("2d", { willReadFrequently: true })!;
  }
  return inkLayer;
}

function paintIsolatedMark(ctx: CanvasRenderingContext2D, mark: SketchMark) {
  ctx.clearRect(0, 0, SKETCH_WIDTH, SKETCH_HEIGHT);
  paintMark(ctx, mark);
  // Keep the erased areas attached to the object when it moves. New marks can cover them.
  for (const { stroke, origin } of mark.erasures ?? []) eraseInk(ctx, stroke, mark.at.x - origin.x, mark.at.y - origin.y);
}

function eraserBounds(stroke: EraserStroke): Bounds {
  let { x: left, y: top } = stroke.points[0]!;
  let right = left, bottom = top;
  for (const point of stroke.points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  const pad = stroke.diameter / 2 + 1;
  return { x: left - pad, y: top - pad, w: right - left + 2 * pad, h: bottom - top + 2 * pad };
}

export function eraseSketch(marks: readonly SketchMark[], stroke: EraserStroke): readonly SketchMark[] {
  if (!marks.length) return marks;
  const ctx = layer();
  const area = eraserBounds(stroke);
  let changed = false;
  const next = marks.flatMap((mark) => {
    const box = bounds(ctx, mark);
    const pad = mark.kind === "text" ? 8 : 2;
    const left = Math.max(0, Math.floor(box.x + mark.at.x - pad));
    const top = Math.max(0, Math.floor(box.y + mark.at.y - pad));
    const right = Math.min(SKETCH_WIDTH, Math.ceil(box.x + mark.at.x + box.w + pad));
    const bottom = Math.min(SKETCH_HEIGHT, Math.ceil(box.y + mark.at.y + box.h + pad));
    const x = Math.max(left, Math.floor(area.x)), y = Math.max(top, Math.floor(area.y));
    const w = Math.min(right, Math.ceil(area.x + area.w)) - x;
    const h = Math.min(bottom, Math.ceil(area.y + area.h)) - y;
    if (w <= 0 || h <= 0) return [mark];

    paintIsolatedMark(ctx, mark);
    const before = ctx.getImageData(x, y, w, h).data;
    eraseInk(ctx, stroke);
    const after = ctx.getImageData(x, y, w, h).data;
    // An eraser pass over empty canvas should not add a history entry.
    if (!after.some((alpha, i) => i % 4 === 3 && alpha !== before[i])) return [mark];
    changed = true;
    const remains = ctx.getImageData(left, top, right - left, bottom - top).data.some((alpha, i) => i % 4 === 3 && alpha > 0);
    return remains ? [{ ...mark, erasures: [...(mark.erasures ?? []), { stroke, origin: mark.at }] }] : [];
  });
  return changed ? next : marks;
}

export function paintSketch(ctx: CanvasRenderingContext2D, paper: string, marks: readonly SketchMark[], selected?: number | null, eraser?: EraserStroke) {
  ctx.clearRect(0, 0, SKETCH_WIDTH, SKETCH_HEIGHT);
  for (const mark of marks) {
    if (mark.erasures?.length) {
      const isolated = layer();
      paintIsolatedMark(isolated, mark);
      ctx.drawImage(isolated.canvas, 0, 0);
    } else paintMark(ctx, mark);
  }
  if (eraser) eraseInk(ctx, eraser);
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, SKETCH_WIDTH, SKETCH_HEIGHT);
  ctx.restore();
  const current = marks.find((mark) => mark.id === selected);
  if (!current) return;
  const { x, y, w, h } = bounds(ctx, current);
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = "#719efd";
  ctx.strokeRect(current.at.x + x - 5, current.at.y + y - 5, w + 10, h + 10);
  ctx.restore();
}
