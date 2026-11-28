import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useInWindow, useMenuDismiss } from "./ContextMenu.js";

// A right-click menu of actions in groups (2026-10-28, first for files): a rule between groups, each action's key on
// its right; while the menu is open that key runs it (the menu takes the keys before the page does, so they do not
// clash with the page's own). Closes as every menu does (lib/ContextMenu.tsx: Escape, a press outside, the wheel, the
// window losing focus) and also when anything outside it scrolls; stays in the window.

export interface MenuAction {
  label: string;
  /** One letter, shown on the right and pressed to run it. */
  key?: string;
  run(): void;
  disabled?: boolean;
  title?: string;
  icon?: ReactNode;
  danger?: boolean;
}

type Slot = MenuAction | false | null | undefined;

export function ActionMenu({ label, at, groups, onClose, testId, focus = false, trigger, alignEnd = false }: { label: string; at: { x: number; y: number }; groups: ReadonlyArray<readonly Slot[]>; onClose(): void; testId?: string; focus?: boolean; trigger?: HTMLElement; alignEnd?: boolean }) {
  const shown = groups.map((g) => g.filter((a): a is MenuAction => !!a)).filter((g) => g.length);
  const box = useRef<HTMLDivElement>(null);
  const pos = useInWindow(box, at, false, alignEnd);
  useMenuDismiss(box, onClose, { scroll: true, trigger });
  const latest = useRef({ shown, onClose });
  latest.current = { shown, onClose };

  useLayoutEffect(() => {
    // Opened from a page in a frame (位置批注): the keys would go to the frame, so the menu takes the focus.
    if (focus || document.activeElement?.tagName === "IFRAME") box.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [at.x, at.y, focus]);

  useEffect(() => {
    const close = () => latest.current.onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const action = latest.current.shown.flat().find((a) => a.key && a.key.toLowerCase() === e.key.toLowerCase());
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.disabled) return;
      close();
      action.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="ctx-menu action-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} ref={box} data-testid={testId} onKeyDown={(event) => {
      if (trigger && event.key === "Tab") return onClose();
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + delta + buttons.length) % buttons.length]?.focus();
    }}>
      {shown.map((group, i) => (
        <div key={i} role="group" className="action-group">
          {i > 0 && <hr className="menu-rule" />}
          {group.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              disabled={a.disabled}
              className={a.danger ? "menu-danger" : undefined}
              title={a.title}
              aria-keyshortcuts={a.key}
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              {a.icon && <span className="menu-action-icon" aria-hidden="true">{a.icon}</span>}
              <span>{a.label}</span>
              {a.key && (
                <kbd className="menu-key" aria-hidden="true">
                  {a.key}
                </kbd>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
