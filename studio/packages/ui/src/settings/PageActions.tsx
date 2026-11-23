import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The empty box on the right of a 设置 page's 页头 (2026-11-23 设置整理); SettingsDialog provides it. */
export const PageActionsSlot = createContext<HTMLElement | null>(null);

/** A page's own controls beside its title (子会话's 生效规则): rendered into the 页头 through a portal. */
export function SettingsPageActions({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionsSlot);
  return slot ? createPortal(children, slot) : null;
}
