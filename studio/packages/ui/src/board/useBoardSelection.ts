import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };

/** Start on the board's gaps so cards keep their normal click and native drag behaviour. */
export function useBoardSelection(scope: string, movableIds: readonly string[]) {
  const board = useRef<HTMLElement>(null);
  const [ids, setIds] = useState<ReadonlySet<string>>(new Set());
  const [box, setBox] = useState<Box | null>(null);
  const gesture = useRef<{ pointer: number; start: Point; client: Point; base: ReadonlySet<string> } | null>(null);
  const selected = new Set(movableIds.filter((id) => ids.has(id)));

  const updateBox = useCallback((client: Point) => {
    const active = gesture.current;
    const element = board.current;
    if (!active || !element) return;
    active.client = client;
    const bounds = element.getBoundingClientRect();
    const end = { x: client.x - bounds.left, y: client.y - bounds.top };
    const next = { x: Math.min(active.start.x, end.x), y: Math.min(active.start.y, end.y), width: Math.abs(end.x - active.start.x), height: Math.abs(end.y - active.start.y) };
    if (next.width < 4 && next.height < 4) {
      setBox(null);
      setIds(active.base);
      return;
    }
    setBox(next);
    const hit = new Set(active.base);
    for (const card of element.querySelectorAll<HTMLElement>('.card[draggable="true"]')) {
      const rect = card.getBoundingClientRect();
      if (rect.left < bounds.left + next.x + next.width && rect.right > bounds.left + next.x && rect.top < bounds.top + next.y + next.height && rect.bottom > bounds.top + next.y) hit.add(card.dataset.taskId!);
    }
    setIds(hit);
  }, []);

  useEffect(() => {
    setIds(new Set());
    setBox(null);
    gesture.current = null;
  }, [scope]);

  useEffect(() => {
    const clear = () => {
      gesture.current = null;
      setBox(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      clear();
      setIds(new Set());
    };
    const scroll = () => {
      if (gesture.current) updateBox(gesture.current.client);
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", clear);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", clear);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [updateBox]);

  const point = (event: ReactPointerEvent<HTMLElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  return {
    board, selected, box, setSelected: setIds,
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== 0 || !event.isPrimary || (event.target as Element).closest("button, input, label, a, .board-tools, .column-head, .topic-group-head, .archived-tasks")) return;
      event.preventDefault();
      const base = event.ctrlKey || event.metaKey || event.shiftKey ? selected : new Set<string>();
      gesture.current = { pointer: event.pointerId, start: point(event), client: { x: event.clientX, y: event.clientY }, base };
      setIds(base);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const active = gesture.current;
      if (!active || active.pointer !== event.pointerId) return;
      updateBox({ x: event.clientX, y: event.clientY });
    },
    onPointerUp(event: ReactPointerEvent<HTMLElement>) {
      if (gesture.current?.pointer !== event.pointerId) return;
      gesture.current = null;
      setBox(null);
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onLostPointerCapture() {
      gesture.current = null;
      setBox(null);
    },
  };
}
