import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { inTurn, isCommon, type BotSidebarData, type ModelProfile, type Session, type StudioBot, type Task, type Workspace } from "@amo-studio/protocol";
import { call, copyText, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { IconAgent, IconChevronDown, IconChevronRight, IconCopy, IconEdit, IconPause, IconPeople, IconPlan, IconPlus, IconSearch, IconTrash, IconWorktree, IconX } from "../chat/icons.js";
import { moveNav, navOrder, useNavOrder } from "../board/navOrder.js";
import { BellGlyph } from "../shell/WorkbenchShortcuts.js";
import { ActionMenu, type MenuAction } from "../lib/ActionMenu.js";
import { readStored, readStoredJson, writeStored, writeStoredJson } from "../lib/stored.js";
import { useStoredIds } from "../lib/storedIds.js";
import { needsPerson, relativeTime } from "../lib/status.js";
import { showToast } from "../lib/toast.js";
import { BotAvatar, BotGroupAvatar } from "./BotAvatar.js";
import { BotCreation, type BotCreationEntry } from "./BotCreation.js";
import { BotEntityDialog, type BotEntity, type BotEntityEdit } from "./BotEntityDialog.js";
import { BOT_SORTS, BotNavMenu, type BotFilters, type BotMenuAnchor, type BotSort } from "./BotNavMenu.js";
import { groupMembers, useBotGroups, useBots } from "./roster.js";

const FOLD_KEY = "amo.bots.folded";
const FILTER_KEY = "amo.bots.filters";
const SORT_KEY = "amo.bots.sort";
const UNREAD_KEY = "amo.bots.unread";
const EMPTY_SIDEBAR: BotSidebarData = { previews: {}, workers: [] };
const byName = new Intl.Collator("zh-CN", { numeric: true });
const isActive = (session: Session) => inTurn(session.status) || needsPerson(session.status);
const compareRecent = (a: string, b: string) => b.localeCompare(a);
const normalizeSearch = (value: string) => value.normalize("NFKC").trim().toLowerCase();

export interface BotsNavActions {
  current: boolean;
  botId?: string;
  groupId?: string;
  taskId?: string;
  sessionId?: string;
  open(pick?: { botId: string } | { groupId: string }): void;
  openChat(taskId: string, sessionId?: string, botId?: string): void;
  openSettings(botId?: string): void;
}

export function BotsNav({ link, live, profiles, workspaces, tasks, sessions, nav }: {
  link: HostLink; live: boolean; profiles: readonly ModelProfile[]; workspaces: readonly Workspace[];
  tasks: readonly Task[]; sessions: readonly Session[]; nav: BotsNavActions;
}) {
  const bots = useBots(link);
  const groups = useBotGroups(link);
  const [folded, setFolded] = useState(() => readStored(FOLD_KEY) === "1");
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BotSort>(() => {
    const saved = readStored(SORT_KEY);
    return saved && Object.hasOwn(BOT_SORTS, saved) ? saved as BotSort : "manual";
  });
  const [filters, setFilters] = useState<BotFilters>(() => {
    const saved = readStoredJson(FILTER_KEY) as Partial<BotFilters> | undefined;
    return { hidePaused: saved?.hidePaused === true, hideIdleWorkers: saved?.hideIdleWorkers === true };
  });
  const order = useNavOrder("bots");
  const unread = useStoredIds(UNREAD_KEY);
  const [menu, setMenu] = useState<BotMenuAnchor>();
  const [context, setContext] = useState<{ entity: BotEntity; x: number; y: number; trigger: HTMLButtonElement }>();
  const [edit, setEdit] = useState<BotEntityEdit>();
  const [creation, setCreation] = useState<BotCreationEntry>();
  const [opening, setOpening] = useState<string>();
  const dragging = useRef<string>(null);
  const [dragTarget, setDragTarget] = useState<{ id: string; after: boolean }>();
  const searchBox = useRef<HTMLInputElement>(null);
  const [detail] = useLiveResource({
    initial: EMPTY_SIDEBAR,
    load: live && !folded ? () => call(link, "GET /api/bots/sidebar") : null,
    reloadOn: (event) => event.type === "bots.changed" || event.type === "data.purged" ||
      (event.type === "task.upserted" && !event.task.botId) ||
      (event.type === "session.upserted" && bots.some((bot) => bot.taskId && bot.taskId === event.session.taskId)) ||
      (event.type === "item.appended" && event.item.type === "agent" && event.item.streaming === false && sessions.some((session) =>
        session.id === event.item.sessionId && !!session.taskId && bots.some((bot) => bot.taskId === session.taskId))),
    reloadDelay: 250,
  }, [link, live, folded]);
  useEffect(() => { if (search && !folded) searchBox.current?.focus(); }, [search, folded]);

  const byTask = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const session of sessions) {
      if (!session.taskId || session.archivedAt) continue;
      const rows = map.get(session.taskId) ?? [];
      rows.push(session);
      map.set(session.taskId, rows);
    }
    for (const rows of map.values()) rows.sort((a, b) => compareRecent(a.updatedAt, b.updatedAt));
    return map;
  }, [sessions]);
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const term = normalizeSearch(query);
  const rows = bots.map((bot) => {
    const chats = bot.taskId ? byTask.get(bot.taskId) ?? [] : [];
    const home = chats.find((session) => session.id === bot.homeSessionId);
    return { bot, home, stamp: chats[0]?.updatedAt ?? "", active: chats.some(isActive), preview: detail.previews[bot.id] || bot.purpose };
  });
  const sorted = sort === "manual" ? navOrder(rows, order.ids, [], ({ bot }) => bot.id) : rows.sort((a, b) => {
    const names = byName.compare(a.bot.name, b.bot.name);
    if (sort === "name") return names;
    const recent = compareRecent(a.stamp, b.stamp) || names;
    return sort === "activity" ? Number(b.active) - Number(a.active) || recent : recent;
  });
  const shown = sorted.filter(({ bot, preview }) => (!filters.hidePaused || bot.enabled) && normalizeSearch(`${bot.name} ${bot.purpose} ${preview}`).includes(term));
  const shownGroups = groups.map((group) => ({ group, members: groupMembers(group, bots) }))
    .filter(({ group, members }) => normalizeSearch(`${group.name} ${members.map((bot) => bot.name).join(" ")}`).includes(term));
  const avatars = sorted.filter(({ bot }) => !filters.hidePaused || bot.enabled);
  const manual = sort === "manual";

  function fold() {
    setMenu(undefined);
    setContext(undefined);
    setFolded(!folded);
    writeStored(FOLD_KEY, folded ? "0" : "1");
  }

  function toggleMenu(type: BotMenuAnchor["type"], event: MouseEvent<HTMLButtonElement>) {
    const trigger = event.currentTarget;
    const rect = trigger.getBoundingClientRect();
    setContext(undefined);
    setMenu(menu?.type === type ? undefined : { type, trigger, x: rect.left, y: rect.bottom + 5 });
  }

  async function openHome(bot: StudioBot, home?: Session) {
    if (opening) return;
    if (!bot.enabled && home?.taskId) return nav.openChat(home.taskId, home.id, bot.id);
    setOpening(bot.id);
    try {
      const session = await call(link, "POST /api/bots/:id/home", { id: bot.id }, {});
      if (session.taskId) nav.openChat(session.taskId, session.id, bot.id);
    } catch (err) { showToast({ text: err instanceof Error ? err.message : String(err), error: true }); }
    finally { setOpening(undefined); }
  }

  function rightClick(event: MouseEvent<HTMLButtonElement>, entity: BotEntity) {
    event.preventDefault();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    setMenu(undefined);
    setContext({ entity, trigger, x: event.clientX || bounds.right, y: event.clientY || bounds.top });
  }

  function markRead(key: string) {
    if (unread.has(key)) unread.toggle(key);
  }

  function closeContext() {
    if (document.activeElement?.closest(".action-menu")) context?.trigger.focus({ preventScroll: true });
    setContext(undefined);
  }

  function entityActions(entity: BotEntity): MenuAction[][] {
    const key = `${entity.kind}:${entity.item.id}`;
    const rename = { label: "重命名", icon: <IconEdit />, disabled: !live, run: () => setEdit({ action: "rename", entity }) };
    const mark = { label: unread.has(key) ? "标记为已读" : "标记为未读", icon: <BellGlyph />, run: () => unread.toggle(key) };
    const remove = { label: entity.kind === "group" ? "删除群组…" : "删除 Bot…", icon: <IconTrash />, disabled: !live, danger: true, run: () => setEdit({ action: "delete", entity }) };
    if (entity.kind === "group") {
      return [[rename, { label: "管理成员…", icon: <IconPeople />, disabled: !live, run: () => setEdit({ action: "members", entity }) }, mark], [remove]];
    }
    const bot = entity.item;
    const path = (bot.workspaceId ? workspaces.find((workspace) => workspace.id === bot.workspaceId) : workspaces.find(isCommon))?.path;
    return [[rename,
      { label: "Bot 设置…", icon: <IconPlan />, run: () => nav.openSettings(bot.id) },
      { label: bot.enabled ? "暂停 Bot" : "继续 Bot", icon: bot.enabled ? <IconPause /> : <IconAgent />, disabled: !live, run: () => {
        void call(link, "PATCH /api/bots/:id", { id: bot.id }, { enabled: !bot.enabled }).catch((err) => showToast({ text: String(err.message ?? err), error: true }));
      } }],
    [{ label: "复制路径", title: "复制 Bot 的默认工作目录", icon: <IconCopy />, disabled: !path, run: () => {
      if (path) void copyText(path).then(() => showToast({ text: "已复制工作目录路径" })).catch((err) => showToast({ text: String(err.message ?? err), error: true }));
    } }, mark], [remove]];
  }

  function move(from: string, to: string, after: boolean) {
    order.save(moveNav(sorted.map(({ bot }) => bot.id), from, to, after));
  }

  return <section className="nav-section-box bot-nav" aria-label="Bots 区域" data-testid="bots-nav" data-folded={folded || undefined}>
    <header className="nav-head">
      <button type="button" className="nav-fold" aria-label="Bots" aria-expanded={!folded} aria-controls="bots-nav-content" onClick={fold}>
        {folded ? <IconChevronRight /> : <IconChevronDown />}<span>Bots</span>
        {folded && unread.ids.length > 0 && <span className="bot-unread-dot" title="有未读 Bot 或群组" />}
      </button>
      <span className="nav-rule" aria-hidden="true" />
      {folded ? <div className="bot-nav-avatars" aria-hidden="true" title={avatars.map(({ bot }) => bot.name).join("、")}>
        {avatars.slice(0, 3).map(({ bot }) => <BotAvatar key={bot.id} name={bot.name} avatar={bot.avatar} size={17} />)}
        {avatars.length > 3 && <small>+{avatars.length - 3}</small>}
      </div> : <div className="bot-nav-tools">
        <button type="button" className="nav-action" aria-label="搜索 Bots" title="搜索 Bots" aria-pressed={search} onClick={() => { setSearch(!search); if (search) setQuery(""); }}><IconSearch /></button>
        <button type="button" className="nav-action" aria-label="Bot 选项" title="Bot 选项" aria-haspopup="menu" aria-expanded={menu?.type === "options"} onClick={(event) => toggleMenu("options", event)}><IconPlan /></button>
        <button type="button" className="nav-action" aria-label="新建 Bot 或群组" title="新建 Bot 或群组" aria-haspopup="menu" aria-expanded={menu?.type === "create"} disabled={!live} onClick={(event) => toggleMenu("create", event)}><IconPlus /></button>
      </div>}
    </header>
    {!folded && <div className="bot-nav-content" id="bots-nav-content">
      {search && <div className="bot-search-box">
        <IconSearch /><input ref={searchBox} aria-label="搜索 Bots" placeholder="搜索名称或消息" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); setSearch(false); setQuery(""); }
        }} />
        {query && <button type="button" className="bot-icon-button" aria-label="清空 Bot 搜索" onClick={() => { setQuery(""); searchBox.current?.focus(); }}><IconX /></button>}
      </div>}
      <div className="bot-nav-list" role="group" aria-label="Bot 主聊天">
        {shownGroups.map(({ group, members }) => <button key={group.id} type="button" className="nav-row bot-nav-group" aria-label={group.name}
          aria-current={nav.groupId === group.id || undefined} onContextMenu={(event) => rightClick(event, { kind: "group", item: group })}
          onClick={() => { markRead(`group:${group.id}`); nav.open({ groupId: group.id }); }}>
          <BotGroupAvatar members={members} size={19} />
          <span className="bot-nav-copy"><span className="bot-nav-title"><strong>{group.name}</strong></span>
            <span className="bot-nav-preview" title={members.map((bot) => bot.name).join("、")}>{members.map((bot) => bot.name).join("、") || "群组暂无成员"}</span></span>
          {unread.has(`group:${group.id}`) && <span className="bot-unread-dot" role="img" aria-label="未读" />}
        </button>)}
        {shown.map(({ bot, home, preview, stamp, active }) => {
          const workers = detail.workers.filter((item) => item.botId === bot.id).flatMap(({ taskId }) => {
            const task = tasksById.get(taskId);
            const workerChats = byTask.get(taskId) ?? [];
            if (!task || task.archivedAt || (filters.hideIdleWorkers && !workerChats.some(isActive))) return [];
            return [{ task, session: workerChats.find((session) => session.kind === "main" && !session.parentId) }];
          });
          const selected = nav.botId === bot.id || (!!bot.taskId && nav.taskId === bot.taskId);
          return <div className="bot-nav-item" key={bot.id} data-bot-id={bot.id} data-paused={!bot.enabled || undefined}
            data-drop={dragTarget?.id === bot.id ? dragTarget.after ? "after" : "before" : undefined}>
            <button type="button" className="nav-row bot-nav-profile" aria-label={bot.name} aria-current={selected || undefined} draggable={manual}
              title={manual ? `${bot.name} · 拖动或 Alt + ↑ / ↓ 调整顺序` : bot.name}
              onContextMenu={(event) => rightClick(event, { kind: "bot", item: bot })}
              onClick={() => { markRead(`bot:${bot.id}`); nav.open({ botId: bot.id }); }}
              onDragStart={(event) => {
                dragging.current = bot.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("application/x-amo-bot", bot.id);
              }}
              onDragEnd={() => { dragging.current = null; setDragTarget(undefined); }}
              onDragOver={(event) => {
                if (!dragging.current || dragging.current === bot.id) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                setDragTarget({ id: bot.id, after: event.clientY > rect.top + rect.height / 2 });
              }}
              onDragLeave={() => setDragTarget(undefined)}
              onDrop={(event) => {
                if (!dragging.current || dragTarget?.id !== bot.id) return;
                event.preventDefault();
                move(dragging.current, bot.id, dragTarget.after);
                dragging.current = null;
                setDragTarget(undefined);
              }}
              onKeyDown={(event) => {
                if (!manual || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                event.preventDefault();
                const after = event.key === "ArrowDown";
                const next = shown[shown.findIndex((entry) => entry.bot.id === bot.id) + (after ? 1 : -1)]?.bot.id;
                if (next) move(bot.id, next, after);
              }}>
              <BotAvatar name={bot.name} avatar={bot.avatar} size={28} />
              <span className="bot-nav-copy">
                <span className="bot-nav-title"><strong>{bot.name}</strong>{!bot.enabled ? <small>已暂停</small> : active ? <i className="bot-activity-dot" aria-label="有活动" /> : null}
                  {unread.has(`bot:${bot.id}`) ? <span className="bot-unread-dot" role="img" aria-label="未读" /> : stamp && <time dateTime={stamp}>{relativeTime(stamp)}</time>}
                </span>
                <span className="bot-nav-preview" title={preview}>{preview}</span>
              </span>
            </button>
            <div className="bot-nav-chats">
              <button type="button" className="nav-row bot-nav-chat" aria-label={`${bot.name} 主聊天`} aria-current={nav.sessionId && nav.sessionId === home?.id || undefined}
                disabled={!live || !!opening || (!bot.enabled && !home)} onClick={() => { markRead(`bot:${bot.id}`); void openHome(bot, home); }}><IconAgent /><span>主聊天</span>{opening === bot.id && <small>打开中…</small>}</button>
              {workers.map(({ task, session }) => <button key={task.id} type="button" className="nav-row bot-nav-chat" title={task.title}
                aria-current={nav.taskId === task.id || undefined} onClick={() => nav.openChat(task.id, session?.id, bot.id)}><IconWorktree /><span>{task.title}</span></button>)}
            </div>
          </div>;
        })}
        {!shown.length && !shownGroups.length && <p className="bot-nav-empty">{term ? "没有匹配的 Bot 或群组" : bots.length ? "当前没有显示的 Bot" : "还没有 Bot"}</p>}
      </div>
    </div>}
    {menu && <BotNavMenu anchor={menu} key={menu.type} sort={sort} filters={filters} onClose={() => setMenu(undefined)}
      onSort={(value) => { setSort(value); writeStored(SORT_KEY, value); }}
      onFilter={(key) => { const next = { ...filters, [key]: !filters[key] }; setFilters(next); writeStoredJson(FILTER_KEY, next); }}
      onCreate={setCreation} onWorkbench={() => nav.open()} onSettings={nav.openSettings} />}
    {context && createPortal(<ActionMenu label={context.entity.kind === "group" ? "群组操作" : "Bot 操作"} at={context} groups={entityActions(context.entity)} focus onClose={closeContext} />, document.body)}
    {edit && <BotEntityDialog link={link} bots={bots} edit={edit} onClose={() => setEdit(undefined)} onDeleted={(entity) => {
      markRead(`${entity.kind}:${entity.item.id}`);
      const current = entity.kind === "group" ? nav.groupId === entity.item.id : nav.botId === entity.item.id || (!!entity.item.taskId && nav.taskId === entity.item.taskId);
      if (current) nav.open();
    }} />}
    {creation && <BotCreation entry={creation} link={link} bots={bots} profiles={profiles} workspaces={workspaces}
      onClose={() => setCreation(undefined)}
      onBot={(bot) => { setCreation(undefined); setQuery(""); nav.open({ botId: bot.id }); }}
      onGroup={(group) => { setQuery(""); nav.open({ groupId: group.id }); }} />}
  </section>;
}
