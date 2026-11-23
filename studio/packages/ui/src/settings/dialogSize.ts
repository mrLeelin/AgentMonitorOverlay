import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { writeStored, readStoredJson } from "../lib/stored.js";

// 设置 can be resized from its bottom-right corner (2026-10-27): the size is kept for the next time (this install), and a
// double click on the corner goes back to the default.

const KEY = "amo.settings.size";
const MIN_W = 640;
const MIN_H = 420;

interface Size {
  w: number;
  h: number;
}

function read(): Size | null {
  const v = readStoredJson(KEY) as Partial<Size> | null | undefined;
  return v && typeof v.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
}

const write = (size: Size | null): void => writeStored(KEY, size ? JSON.stringify(size) : null);

export function useDialogSize(): { style: CSSProperties | undefined; grip: { onPointerDown(e: ReactPointerEvent<HTMLElement>): void; onDoubleClick(): void } } {
  const [size, setSize] = useState<Size | null>(read);
  const grip = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      const dialog = e.currentTarget.parentElement;
      const backdrop = dialog?.parentElement;
      if (!dialog || !backdrop || e.button !== 0 || !e.isPrimary) return;
      e.preventDefault();
      const r = dialog.getBoundingClientRect();
      const { clientX, clientY } = e;
      const inset = getComputedStyle(backdrop);
      const maxW = backdrop.clientWidth - parseFloat(inset.paddingLeft) - parseFloat(inset.paddingRight);
      const maxH = backdrop.clientHeight - parseFloat(inset.paddingTop) - parseFloat(inset.paddingBottom);
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      let next: Size = { w: r.width, h: r.height };
      const move = (ev: PointerEvent) => {
        // Centred across, so the corner follows the pointer when the width grows by twice its move.
        next = {
          w: Math.round(Math.min(maxW, Math.max(MIN_W, r.width + 2 * (ev.clientX - clientX)))),
          h: Math.round(Math.min(maxH, Math.max(MIN_H, r.height + ev.clientY - clientY))),
        };
        setSize(next);
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("lostpointercapture", up);
        write(next);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("lostpointercapture", up);
    },
    onDoubleClick() {
      setSize(null);
      write(null);
    },
  };
  return { style: size ? { width: Math.max(MIN_W, size.w), height: Math.max(MIN_H, size.h) } : undefined, grip };
}
