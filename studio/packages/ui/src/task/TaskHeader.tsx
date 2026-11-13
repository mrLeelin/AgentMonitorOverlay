import { useRef, useState, type ReactNode } from "react";
import { readStored, writeStored } from "../lib/stored.js";

const KEY = "amo.taskHeaderHeight";
const MIN = 56;

/** The divider stays outside the scrolling content so it remains reachable in a small header. */
export function TaskHeader({ children }: { children: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const [height, setHeight] = useState<number | undefined>(() => {
    const saved = Number(readStored(KEY));
    return Number.isFinite(saved) && saved >= MIN ? saved : undefined;
  });
  const resize = (value: number) => {
    const max = Math.max(MIN, (shell.current?.parentElement?.clientHeight ?? window.innerHeight) * 0.5);
    const next = Math.round(Math.max(MIN, Math.min(max, value)));
    setHeight(next);
    writeStored(KEY, String(next));
  };
  const reset = () => { setHeight(undefined); writeStored(KEY, null); };
  return <div ref={shell} className="task-head-shell" style={{ height }} data-testid="task-header">
    {children}
    <div className="task-head-resize" role="separator" aria-label="任务信息栏高度" aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={MIN} aria-valuenow={height} title="上下拖动调整高度，双击恢复默认；方向键微调"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        drag.current = { y: e.clientY, height: shell.current!.getBoundingClientRect().height };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => { if (drag.current) resize(drag.current.height + e.clientY - drag.current.y); }}
      onPointerUp={(e) => { drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onDoubleClick={reset}
      onKeyDown={(e) => {
        if (e.key === "Home") { e.preventDefault(); reset(); }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          resize((shell.current?.getBoundingClientRect().height ?? MIN) + (e.key === "ArrowUp" ? -10 : 10));
        }
      }} />
  </div>;
}
