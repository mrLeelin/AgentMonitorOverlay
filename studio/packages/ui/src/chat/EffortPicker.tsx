import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { SessionOptions } from "@amo-studio/protocol";
import { effortLabel } from "../lib/choices.js";
import { IconChevronDown, IconChevronRight } from "./icons.js";
import "./effort-picker.css";

export function withEffort(options: SessionOptions, effort: string | null): SessionOptions {
  const next = { ...options };
  if (effort === null) delete next.effort;
  else next.effort = effort;
  return next;
}

const labelOf = (effort: string | null) => effort === null ? "默认" : effort === "ultra" ? "Ultra" : effortLabel(effort);
const Bolt = () => <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11.5 2 4 11h5l-.8 7L16 8.5h-5.2z" /></svg>;

// Offset the starting phases so the highest detent is already populated when dragged into view.
const particles = Array.from({ length: 20 }, (_, i) => ({
  left: `${2 + (i * 37) % 94}%`, top: `${12 + (i * 23) % 72}%`,
  animationDuration: `${1.8 + (i % 4) * .35}s`, animationDelay: `-${i * .43}s`,
}));

/** The slider previews each detent while dragging. Only the released value is sent to the session. */
export function EffortPicker({ efforts, value, fallback, modelLabel, fastControl, onChange, onOpen, onModel, disabled = false, saving = false }: {
  efforts: readonly string[]; value: string | null; fallback?: string | undefined; modelLabel: string;
  fastControl: ReactNode;
  onChange(effort: string | null): void | Promise<void>; onOpen(): void; onModel(): void; disabled?: boolean; saving?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const current = value ?? fallback ?? null;
  const currentIndex = current === null ? -1 : efforts.indexOf(current);
  const min = currentIndex < 0 || !efforts.includes(fallback ?? "") ? -1 : 0;
  const max = efforts.length - 1;
  const index = preview ?? currentIndex;
  const level = preview === null ? current : efforts[index] ?? null;
  const highest = index === max && (max > 0 || level === "ultra" || level === "max");
  const percent = max === min ? 1 : (index - min) / (max - min);
  const tint = { "--effort-mix": `${percent * 100}%` } as CSSProperties;

  useEffect(() => {
    const button = trigger.current;
    if (!button) return;
    function wheel(e: WheelEvent) {
      if (disabled || saving || !e.deltaY) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(max, currentIndex + (e.deltaY < 0 ? 1 : -1)));
      if (next !== currentIndex) void onChange(efforts[next]!);
    }
    button.addEventListener("wheel", wheel, { passive: false });
    return () => button.removeEventListener("wheel", wheel);
  }, [efforts, currentIndex, max, disabled, saving, onChange]);

  function cancelDrag() {
    dragging.current = false;
    setPreview(null);
  }
  async function commit(next: number) {
    dragging.current = false;
    if (disabled || saving || next === currentIndex) return setPreview(null);
    setPreview(next);
    try { await onChange(efforts[next] ?? null); }
    finally { setPreview(null); }
  }
  return <>
    <button ref={trigger} type="button" className="effort-trigger" popoverTarget={id} disabled={disabled || saving} style={tint} data-highest={highest}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-label={`选择推理强度，当前${labelOf(current)}`} title="选择推理强度（滚轮微调）" data-testid="effort">
      <Bolt /><span data-testid="effort-label">{labelOf(level)}</span><IconChevronDown />
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="选择推理强度" className="effort-picker" data-highest={highest} style={tint}
      onToggle={e => {
        setOpen(e.newState === "open");
        if (e.newState === "open") { onOpen(); slider.current?.focus({ preventScroll: true }); }
        else cancelDrag();
      }}>
      <div className="effort-picker-head">
        {fastControl}
        <div className="effort-heading"><strong>{labelOf(level)}</strong>
          <button type="button" disabled={disabled || saving} title="选择模型" onClick={() => { panel.current?.hidePopover(); onModel(); }}>{modelLabel}<IconChevronRight /></button>
        </div>
        <button type="button" className="effort-reset" disabled={disabled || saving || value === null} aria-label="恢复模型默认推理强度"
          title={fallback ? `恢复模型默认（${labelOf(fallback)}）` : "恢复模型默认推理强度"} onClick={() => { cancelDrag(); void onChange(null); }}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 8a7 7 0 1 1 .5 5M3 3.5V8h4.5" /></svg>
        </button>
      </div>
      <div className="effort-slider" style={{ "--ratio": percent } as CSSProperties}>
        <div className="effort-track" aria-hidden="true"><div className="effort-fill">
          {open && highest && particles.map((style, i) => <i className="effort-particle" key={i} style={style} />)}
        </div><div className="effort-ticks">
          {Array.from({ length: max - min + 1 }, (_, i) => <i key={i} />)}
        </div></div>
        <input ref={slider} type="range" min={min} max={max} step={1} value={index} disabled={disabled || min === max}
          aria-label="推理强度" aria-valuetext={labelOf(level)} aria-busy={saving}
          onPointerDown={e => { if (saving) e.preventDefault(); else if (e.button === 0) { dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId); } }}
          onChange={e => { if (saving) return; const next = e.currentTarget.valueAsNumber; if (dragging.current) setPreview(next); else void commit(next); }}
          onPointerUp={e => { if (dragging.current) void commit(e.currentTarget.valueAsNumber); }}
          onLostPointerCapture={() => { if (dragging.current) cancelDrag(); }} onPointerCancel={cancelDrag} />
      </div>
    </div>
  </>;
}
