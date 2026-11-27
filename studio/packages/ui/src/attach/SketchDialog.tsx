import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { ComposerToolIcon } from "./ComposerToolIcon.js";
import { constrainShape, eraseSketch, fitSketchText, paintSketch, SHAPES, SKETCH_HEIGHT, SKETCH_WIDTH, sketchHit, type EraserStroke, type Point, type Shape, type SketchMark } from "./sketch.js";

const TOOLS = { select: "选择并移动", pen: "画笔", text: "文字", shapes: "图形", eraser: "橡皮擦" } as const;
const SHAPE_SHIFT_HINTS: Record<Shape, string> = {
  line: "按住 Shift 以 45° 为步长吸附", arrow: "按住 Shift 以 45° 为步长吸附",
  rect: "按住 Shift 画正方形", ellipse: "按住 Shift 画正圆", triangle: "按住 Shift 画等边三角形",
  diamond: "按住 Shift 画等宽等高的菱形", star: "按住 Shift 画等比星形", heart: "按住 Shift 画等比心形",
};
type Tool = keyof typeof TOOLS;
const COLORS = [
  ["默认墨色", "var(--text)"], ["白色", "#ffffff"], ["石墨", "#22262d"], ["灰色", "#808897"],
  ["红色", "#ef5354"], ["橙色", "#ff852e"], ["黄色", "#f3b82a"], ["绿色", "#26ad66"],
  ["青色", "#15b2bc"], ["蓝色", "#4d87ff"], ["紫色", "#9765ed"], ["粉色", "#ea5296"],
] as const;

type Frame = readonly SketchMark[];
type History = { past: readonly Frame[]; now: Frame; future: readonly Frame[] };
type Gesture = { pointer: number; start: Point; last: Point; base: Frame; next: Frame } & (
  | { kind: "pen"; mark: Extract<SketchMark, { kind: "pen" }> }
  | { kind: "shape"; mark: Extract<SketchMark, { kind: "shape" }> }
  | { kind: "move"; mark: SketchMark }
  | { kind: "erase"; stroke: EraserStroke }
);
const offset = (from: Point, to: Point): Point => ({ x: to.x - from.x, y: to.y - from.y });

export function SketchDialog({ onClose, onAttach }: { onClose(): void; onAttach(file: File): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const nextId = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const [history, setHistory] = useState<History>({ past: [], now: [], future: [] });
  const [preview, setPreview] = useState<Frame | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [shape, setShape] = useState<Shape>("arrow");
  const [showShapes, setShowShapes] = useState(false);
  const [size, setSize] = useState(5);
  const [eraserSize, setEraserSize] = useState(38);
  const [eraserPreview, setEraserPreview] = useState<EraserStroke>();
  const [pointerTip, setPointerTip] = useState<Point | null>(null);
  const [color, setColor] = useState<string>(COLORS[0][1]);
  const [custom, setCustom] = useState("#32c1b5");
  const [writing, setWriting] = useState<{ at: Point; value: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const erasing = tool === "eraser";
  const hasPointerTip = tool === "pen" || erasing;

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  function paper() {
    return canvas.current ? getComputedStyle(canvas.current).backgroundColor : "#ffffff";
  }

  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (ctx) paintSketch(ctx, paper(), preview ?? history.now, selected, eraserPreview);
  }, [history.now, preview, selected, eraserPreview]);

  function commit(now: Frame) {
    setHistory((old) => old.now === now ? old : { past: [...old.past.slice(-39), old.now], now, future: [] });
  }

  function undo(redo = false) {
    if (gesture.current || exporting) return;
    setSelected(null);
    setHistory((old) => {
      if (redo) return old.future.length ? { past: [...old.past, old.now], now: old.future[0]!, future: old.future.slice(1) } : old;
      return old.past.length ? { past: old.past.slice(0, -1), now: old.past.at(-1)!, future: [old.now, ...old.future] } : old;
    });
  }

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) * SKETCH_WIDTH / rect.width;
    const y = (event.clientY - rect.top) * SKETCH_HEIGHT / rect.height;
    if (hasPointerTip && event.isPrimary) {
      setPointerTip(x >= 0 && x < SKETCH_WIDTH && y >= 0 && y < SKETCH_HEIGHT ? { x, y } : null);
    }
    return {
      x: Math.max(0, Math.min(SKETCH_WIDTH, x)),
      y: Math.max(0, Math.min(SKETCH_HEIGHT, y)),
    };
  }

  function markAt(at: Point) {
    return {
      id: nextId.current++, at, width: size,
      color: color === COLORS[0][1] && canvas.current ? getComputedStyle(canvas.current).color : color,
    };
  }

  function begin(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || gesture.current || exporting || writing) return;
    const ctx = event.currentTarget.getContext("2d");
    if (!ctx) return;
    const start = point(event);
    setShowShapes(false);
    if (tool === "text") {
      setWriting({ at: start, value: "" });
      return;
    }
    const base = history.now;
    const common = { pointer: event.pointerId, start, last: start, base };
    if (tool === "select") {
      const hit = sketchHit(ctx, base, start);
      setSelected(hit?.id ?? null);
      if (!hit) return;
      gesture.current = { ...common, kind: "move", mark: hit, next: base };
    } else if (tool === "eraser") {
      const stroke = { diameter: eraserSize, points: [start] };
      setSelected(null);
      setEraserPreview(stroke);
      gesture.current = { ...common, kind: "erase", stroke, next: base };
    } else {
      setSelected(null);
      const mark: SketchMark = tool === "pen" ? { ...markAt(start), kind: "pen", points: [] } : { ...markAt(start), kind: "shape", shape, end: { x: 0, y: 0 } };
      gesture.current = mark.kind === "pen" ? { ...common, kind: "pen", mark, next: [...base, mark] } : { ...common, kind: "shape", mark, next: base };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setPreview(gesture.current.next);
  }

  function previewShape(active: Extract<Gesture, { kind: "shape" }>, shift: boolean) {
    const delta = offset(active.start, active.last);
    const end = shift ? constrainShape(active.mark.shape, active.start, delta) : delta;
    active.next = Math.hypot(end.x, end.y) >= 3 ? [...active.base, { ...active.mark, end }] : active.base;
    setPreview(active.next);
  }

  function drag(event: PointerEvent<HTMLCanvasElement>) {
    const active = gesture.current;
    const at = active || hasPointerTip ? point(event) : null;
    if (!at) return;
    if (!active || active.pointer !== event.pointerId) return;
    if (active.kind === "shape") {
      active.last = at;
      previewShape(active, event.shiftKey);
      return;
    }
    if (at.x === active.last.x && at.y === active.last.y) return;
    active.last = at;
    if (active.kind === "erase") {
      active.stroke = { ...active.stroke, points: [...active.stroke.points, at] };
      setEraserPreview(active.stroke);
      return;
    }
    const delta = offset(active.start, at);
    if (active.kind === "move") {
      const moved = { ...active.mark, at: { x: active.mark.at.x + delta.x, y: active.mark.at.y + delta.y } };
      active.next = delta.x || delta.y ? active.base.map((mark) => mark === active.mark ? moved : mark) : active.base;
    } else {
      active.mark = { ...active.mark, points: [...active.mark.points, delta] };
      active.next = [...active.base, active.mark];
    }
    setPreview(active.next);
  }

  function finish(event: PointerEvent<HTMLCanvasElement>, cancelled = false) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    if (!cancelled) {
      drag(event);
      commit(active.kind === "erase" ? eraseSketch(active.base, active.stroke) : active.next);
    }
    gesture.current = null;
    setPreview(null);
    setEraserPreview(undefined);
  }

  function finishText() {
    const ctx = canvas.current?.getContext("2d");
    if (ctx && writing?.value.trim()) commit([...history.now, fitSketchText(ctx, { ...markAt(writing.at), kind: "text", text: writing.value.trim() })]);
    setWriting(null);
  }

  function close() {
    dialog.current?.close();
    onClose();
  }

  function exportImage() {
    if (gesture.current || exporting || !history.now.length) return;
    const image = document.createElement("canvas");
    image.width = SKETCH_WIDTH;
    image.height = SKETCH_HEIGHT;
    const ctx = image.getContext("2d");
    if (!ctx) return setError("无法生成图片，请重试。");
    paintSketch(ctx, paper(), history.now);
    setExporting(true);
    setError("");
    image.toBlob((blob) => {
      if (!dialog.current?.open) return;
      if (!blob) {
        setError("无法生成图片，请重试。");
        setExporting(false);
        return;
      }
      dialog.current.close();
      onAttach(new File([blob], "绘图.png", { type: "image/png" }));
    }, "image/png");
  }

  function shiftShape(event: KeyboardEvent<HTMLDialogElement>) {
    const active = gesture.current;
    if (event.key === "Shift" && !event.repeat && active?.kind === "shape") previewShape(active, event.shiftKey);
  }

  function keys(event: KeyboardEvent<HTMLDialogElement>) {
    event.stopPropagation();
    shiftShape(event);
    if (event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return;
    if (event.key === "Escape" && showShapes) {
      event.preventDefault();
      setShowShapes(false);
    } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
      event.preventDefault();
      undo(event.shiftKey || event.key.toLowerCase() === "y");
    } else if (event.key === "Delete" && selected !== null && !gesture.current && !exporting) {
      commit(history.now.filter((mark) => mark.id !== selected));
      setSelected(null);
    }
  }

  const sizeLabel = erasing ? "橡皮擦大小" : tool === "text" ? "文字大小" : "笔画粗细";
  const toolSize = erasing ? eraserSize : size;

  return createPortal(
    <dialog ref={dialog} className="composer-sketch" aria-label="绘图" onKeyDown={keys} onKeyUp={shiftShape} onCancel={(event) => {
      event.preventDefault();
      if (writing) setWriting(null);
      else if (showShapes) setShowShapes(false);
      else close();
    }}>
      <header className="sketch-header">
        <button type="button" className="sketch-button" aria-label="关闭绘图" title="关闭绘图" onClick={close}><ComposerToolIcon name="close" /></button>
        <div className="sketch-tools" role="group" aria-label="绘图工具">
          {(Object.keys(TOOLS) as Tool[]).map((name) => <button type="button" key={name} className="sketch-button"
            title={TOOLS[name]} aria-label={TOOLS[name]} aria-pressed={tool === name} aria-expanded={name === "shapes" ? showShapes : undefined}
            onClick={() => { setTool(name); setSelected(null); setPointerTip(null); setShowShapes(name === "shapes" && !showShapes); }}>
            <ComposerToolIcon name={name === "shapes" && !showShapes && tool === "shapes" ? shape : name} />
          </button>)}
          {showShapes && <div className="sketch-shapes" role="group" aria-label="选择图形">
            {(Object.keys(SHAPES) as Shape[]).map((name) => <button type="button" key={name} className="sketch-button" aria-label={SHAPES[name]} title={`${SHAPES[name]}（${SHAPE_SHIFT_HINTS[name]}）`} aria-pressed={shape === name}
              onClick={() => { setShape(name); setShowShapes(false); }}><ComposerToolIcon name={name} /></button>)}
          </div>}
        </div>
        <div className="sketch-history" role="group" aria-label="绘图历史">
          <button type="button" className="sketch-button" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={!history.past.length || !!preview || !!writing || exporting} onClick={() => undo()}><ComposerToolIcon name="undo" /></button>
          <button type="button" className="sketch-button" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled={!history.future.length || !!preview || !!writing || exporting} onClick={() => undo(true)}><ComposerToolIcon name="redo" /></button>
        </div>
      </header>
      <div className="sketch-work">
        <label className="sketch-size" title={sizeLabel}>
          <input type="range" min={erasing ? 6 : 2} max={erasing ? 100 : 24} value={toolSize} aria-label={sizeLabel}
            onChange={(event) => (erasing ? setEraserSize : setSize)(Number(event.target.value))} />
        </label>
        <div className="sketch-board">
          <canvas ref={canvas} data-testid="sketch-canvas" aria-label="绘图画布" data-tool={tool} tabIndex={0} width={SKETCH_WIDTH} height={SKETCH_HEIGHT}
            onPointerDown={begin} onPointerMove={drag} onPointerUp={(event) => finish(event)}
            onPointerEnter={(event) => { if (hasPointerTip) point(event); }}
            onPointerLeave={() => setPointerTip(null)}
            onPointerCancel={(event) => { setPointerTip(null); finish(event, true); }} onLostPointerCapture={(event) => finish(event, true)} />
          {hasPointerTip && pointerTip && <div className="sketch-tip-overlay" aria-hidden="true">
            <span className={erasing ? "sketch-tip sketch-eraser-tip" : "sketch-tip sketch-pen-tip"} style={{
              left: `${pointerTip.x / SKETCH_WIDTH * 100}%`, top: `${pointerTip.y / SKETCH_HEIGHT * 100}%`,
              width: `${(eraserPreview?.diameter ?? toolSize) / SKETCH_WIDTH * 100}%`, backgroundColor: erasing ? undefined : color,
            }} />
          </div>}
          {writing && <form className="sketch-text-edit" style={{ left: `${Math.min(writing.at.x / SKETCH_WIDTH * 100, 65)}%`, top: `${Math.min(writing.at.y / SKETCH_HEIGHT * 100, 84)}%` }}
            onSubmit={(event) => { event.preventDefault(); finishText(); }}>
            <input autoFocus maxLength={150} aria-label="输入绘图文字" placeholder="输入文字" value={writing.value} onChange={(event) => setWriting({ ...writing, value: event.target.value })} />
            <button type="submit" className="sketch-button" title="放置文字" aria-label="放置文字"><ComposerToolIcon name="check" /></button>
          </form>}
        </div>
      </div>
      <footer className="sketch-footer">
        <div className="sketch-colors" role="group" aria-label="绘图颜色">
          <label className="sketch-custom" title="自定义颜色"><input type="color" aria-label="自定义颜色" value={custom}
            onChange={(event) => { setCustom(event.target.value); setColor(event.target.value); }} /></label>
          {COLORS.map(([label, value]) => <button type="button" key={value} className="sketch-swatch" aria-label={label} title={label}
            style={{ background: value }} aria-pressed={color === value} onClick={() => setColor(value)} />)}
        </div>
        <button type="button" className="sketch-button sketch-attach" aria-label="插入绘图" title="插入绘图"
          disabled={!history.now.length || !!preview || !!writing || exporting} onClick={exportImage}><ComposerToolIcon name="check" size={20} /></button>
      </footer>
      {error && <div className="sketch-error form-error" role="alert">{error}</div>}
    </dialog>, document.body,
  );
}
