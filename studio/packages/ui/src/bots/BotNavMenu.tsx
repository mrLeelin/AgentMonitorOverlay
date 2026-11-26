import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconAgent, IconCheck, IconChevronRight, IconClock, IconPlan } from "../chat/icons.js";
import { ContextMenu } from "../lib/ContextMenu.js";
import type { BotCreationEntry } from "./BotCreation.js";

export const BOT_SORTS = { manual: "手动", activity: "智能体活动", recent: "最近", name: "名称" } as const;
export type BotSort = keyof typeof BOT_SORTS;
export type BotFilters = { hidePaused: boolean; hideIdleWorkers: boolean };
export type BotMenuAnchor = { type: "options" | "create"; trigger: HTMLButtonElement; x: number; y: number };

export function BotNavMenu({ anchor, sort, filters, onSort, onFilter, onCreate, onWorkbench, onSettings, onClose }: {
  anchor: BotMenuAnchor; sort: BotSort; filters: BotFilters; onSort(sort: BotSort): void; onFilter(filter: keyof BotFilters): void;
  onCreate(entry: BotCreationEntry): void; onWorkbench(): void; onSettings(): void; onClose(): void;
}) {
  const [secondary, setSecondary] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const options = anchor.type === "options";
  const label = options ? "Bot 选项" : "新建 Bot 或群组";
  useLayoutEffect(() => {
    const panel = box.current?.querySelector(secondary ? ".bot-menu-subpanel" : ".bot-menu-panel");
    panel?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [secondary]);

  function close(returnFocus: boolean) {
    onClose();
    if (returnFocus) anchor.trigger.focus({ preventScroll: true });
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const active = document.activeElement;
    const panel = active?.closest(".bot-menu-panel, .bot-menu-subpanel");
    const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.findIndex((button) => button === active);
    if (event.key === "ArrowRight" && active?.getAttribute("aria-haspopup") === "menu") {
      event.preventDefault();
      setSecondary(true);
    } else if (event.key === "ArrowLeft" && secondary) {
      event.preventDefault();
      setSecondary(false);
    } else if (buttons.length && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + offset + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  function action(text: string, run: () => void, icon?: ReactNode) {
    return <button type="button" role="menuitem" onClick={() => { close(true); run(); }}>{icon}<span>{text}</span></button>;
  }

  function filter(key: keyof BotFilters, text: string, icon: ReactNode) {
    return <button type="button" role="menuitemcheckbox" aria-checked={filters[key]} onClick={() => onFilter(key)}>
      {icon}<span>{text}</span><span className="bot-switch-track" data-on={filters[key] || undefined} aria-hidden="true" />
    </button>;
  }

  return createPortal(<ContextMenu key={String(secondary)} at={anchor} label={label} trigger={anchor.trigger} boxRef={box} className="bot-menu"
    onKeyDown={onKey} onClose={() => close(box.current?.contains(document.activeElement) ?? false)}>
    <div className="bot-menu-panel" role="group">
      <div className="bot-menu-title">{label}</div>
      <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={secondary} onClick={() => setSecondary(!secondary)}>
        {options ? <IconPlan /> : <IconAgent />}
        <span>{options ? "排序方式" : "新建 Bot"}</span>{options && <small>{BOT_SORTS[sort]}</small>}<IconChevronRight />
      </button>
      {options ? <>
        <hr className="menu-rule" />
        <div className="bot-menu-title">筛选条件</div>
        {filter("hidePaused", "隐藏已暂停的 Bots", <IconAgent />)}
        {filter("hideIdleWorkers", "隐藏休眠的工作者", <IconClock />)}
        <hr className="menu-rule" />
        {action("打开 Bots 工作台", onWorkbench)}
        {action("Bots 设置", onSettings)}
      </> : action("新建群组", () => onCreate("group"))}
    </div>
    {secondary && <div className="bot-menu-subpanel" role="menu" aria-label={options ? "排序方式" : "新建 Bot"}>
      {options ? (Object.keys(BOT_SORTS) as BotSort[]).map((item) => <button key={item} type="button" role="menuitemradio" aria-checked={sort === item} onClick={() => { onSort(item); close(true); }}>
        <span className="bot-menu-mark">{sort === item && <IconCheck />}</span><span>{BOT_SORTS[item]}</span>
      </button>) : <>
        {action("从空白开始", () => onCreate("blank"))}
        <hr className="menu-rule" />
        {action("浏览模板", () => onCreate("templates"))}
        {action("从链接创建…", () => onCreate("link"))}
        {action("从其他应用导入…", () => onCreate("import"))}
      </>}
    </div>}
  </ContextMenu>, document.body);
}
