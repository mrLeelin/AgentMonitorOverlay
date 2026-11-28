import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isCommon, supportsBotMemory, type BotRequest, type BotSidebarData, type Session, type StudioBot } from "@amo-studio/protocol";
import { IconAgent, IconChevronDown, IconClock, IconCopy, IconPause, IconPlan, IconPlus, IconSearch, IconSparkle, IconWorktree } from "../chat/icons.js";
import { useDuty } from "../duty/duty.js";
import { call, copyText } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { ActionMenu } from "../lib/ActionMenu.js";
import { Modal } from "../lib/Modal.js";
import { needsPerson, relativeTime } from "../lib/status.js";
import { showToast } from "../lib/toast.js";
import { scheduleText } from "../settings/DutyPage.js";
import type { View, ViewContext } from "../shell/views.js";
import { PlaneBotJobs } from "../teamtasks/PlaneBotJobs.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotRequestList } from "./BotRequests.js";
import { BotWebhooks } from "./BotWebhooks.js";
import { BotWorkspaceFiles } from "./BotWorkspaceFiles.js";
import { BotWorkspaceSettings } from "./BotsPage.js";
import type { LeadCanvasOpen } from "./LeadAppointment.js";
import { botChatName, useBots } from "./roster.js";
import "./BotWorkspace.css";

type Panel = "home" | "connectors" | "chats" | "files";
const TABS: readonly { id: Panel; label: string }[] = [
  { id: "home", label: "主页" }, { id: "connectors", label: "连接器" }, { id: "chats", label: "聊天" }, { id: "files", label: "文件" },
];
const EMPTY_REQUESTS: readonly BotRequest[] = [];

function PanelIcon({ name }: { name: Panel | "settings" | "panel" | "share" }) {
  const paths = {
    home: "M2.5 7 8 2.5 13.5 7v6.5H9.8V9H6.2v4.5H2.5z",
    connectors: "M5.5 2.5V6m5-3.5V6M4 6h8v1.5a4 4 0 0 1-8 0zm4 5.5v2",
    chats: "M2.5 3.5h9v6h-6l-3 2zm10.5 2v5.8h-2v2l-3-2",
    files: "M5.5 3.5h4l3 3V14h-7zm4 0v3h3m-5-5h-4v9",
    settings: "M6.5 2.3h3l.4 1.6 1 .6 1.6-.5 1.5 2.6-1.2 1.1v1.1l1.2 1.1-1.5 2.6-1.6-.5-1 .6-.4 1.6h-3l-.4-1.6-1-.6-1.6.5L2 9.9l1.2-1.1V7.7L2 6.6 3.5 4l1.6.5 1-.6zM8 6.4A1.85 1.85 0 1 1 8 10.1 1.85 1.85 0 0 1 8 6.4z",
    panel: "M2 3h12v10H2zm8 0v10m0-6H2",
    share: "M5.2 7.3 10 4.7M5.2 8.7l4.8 2.6M5.2 8a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0zm8-4.2a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0zm0 8.4a1.7 1.7 0 1 1-3.4 0 1.7 1.7 0 0 1 3.4 0z",
  };
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function botConversationView(bot: StudioBot, session: Session): View {
  return session.taskId ? { kind: "task", taskId: session.taskId, sessionId: session.id, botWorkspace: bot.id, back: { kind: "bots", botId: bot.id }, nav: Date.now() }
    : { kind: "bots", botId: bot.id, chat: "empty-home" };
}

export function BotWorkspace({ bot, context, selectedSession, onCanvas, children }: {
  bot: StudioBot; context: ViewContext; selectedSession?: string; onCanvas: LeadCanvasOpen; children: ReactNode;
}) {
  const { link, state, data, online, teamTasksEnabled, setView } = context;
  const [tab, setTab] = useState<Panel>("home");
  const [settings, setSettings] = useState<"overview" | "automation">();
  const [expanded, expand] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const heading = useRef<HTMLButtonElement>(null);
  const collapsed = useRef<HTMLButtonElement>(null);
  const id = useId();
  const bots = useBots(link);
  const duty = useDuty();
  const { tasks, topics, workspaces, profiles, sessions } = state;
  const chats = sessions.filter((session) => session.taskId === bot.taskId && !!bot.taskId && session.kind === "main" && !session.parentId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const home = chats.find((session) => bot.homeSessionId === session.id);
  const workspace = bot.workspaceId ? workspaces.find((item) => item.id === bot.workspaceId) : workspaces.find(isCommon);
  const schedules = duty?.items.filter((item) => item.action.kind === "bot" && item.action.botId === bot.id) ?? [];
  const inspection = schedules.find((entry) => entry.action.kind === "bot" && entry.action.job !== "memory");
  const memory = schedules.find((entry) => entry.action.kind === "bot" && entry.action.job === "memory");
  const memorySupported = supportsBotMemory(profiles.find((profile) => profile.id === bot.profileId)?.runtime);
  const pending = chats.filter((chat) => !chat.archivedAt && needsPerson(chat.status));
  const [requests, , reloadRequests] = useLiveResource({
    initial: EMPTY_REQUESTS,
    load: () => call(link, "GET /api/bot-requests").then((rows) => rows.filter((row) => row.botId === bot.id)),
    reloadOn: (event) => event.type === "bot-lead.changed" || event.type === "bots.changed" || (event.type === "session.upserted" && !!bot.taskId && event.session.taskId === bot.taskId),
    reloadDelay: 150,
  }, [link.url, link.token, bot.id]);
  const listOpen = tab === "chats" || tab === "home";
  const [sidebar] = useLiveResource<BotSidebarData>({
    initial: { previews: {}, workers: [] },
    load: listOpen ? () => call(link, "GET /api/bots/sidebar", {}, undefined, { botId: bot.id }) : null,
    reloadOn: (event) => event.type === "bots.changed" || event.type === "task.upserted" || event.type === "data.purged" ||
      (event.type === "session.upserted" && !!bot.taskId && event.session.taskId === bot.taskId),
    reloadDelay: 180,
  }, [link.url, link.token, bot.id, listOpen]);
  const workers = sidebar.workers.filter((worker) => worker.botId === bot.id).flatMap(({ taskId }) => {
    const task = tasks.find((item) => item.id === taskId && !item.archivedAt);
    return task ? [task] : [];
  });
  const openSession = (session: Session) => setView(botConversationView(bot, session));
  const openTask = (taskId: string, sessionId?: string) => {
    const chat = chats.find((session) => session.id === sessionId && session.taskId === taskId);
    if (chat) { openSession(chat); return; }
    setView({ kind: "task", taskId, sessionId, back: { kind: "bots", botId: bot.id }, nav: Date.now() });
  };
  const directory = { link, tasks, topics, workspaces, profiles, bots, decisions: data.openDecisions, onCanvas, onTask: openTask };
  function newChat(initialText?: string) {
    setView({ kind: "bots", botId: bot.id, chat: "new", initialText, nav: Date.now() });
  }
  function openHome() {
    if (home) { openSession(home); return; }
    setView({ kind: "bots", botId: bot.id, chat: "empty-home" });
  }
  function showSettings(section: "overview" | "automation" = "overview") { setTab("home"); setSettings(section); }

  return <div className="bot-workspace" data-expanded={expanded} data-testid="bot-workspace">
    <div className="bot-workspace-conversation">{children}</div>
    {!expanded && <div className="bot-workspace-rail">
      <button type="button" ref={collapsed} className="bot-workspace-icon" aria-label="展开 Bot 侧栏" aria-expanded={false} onClick={() => { expand(true); requestAnimationFrame(() => heading.current?.focus()); }}><PanelIcon name="panel" /></button>
    </div>}
    {expanded && <aside className="bot-workspace-panel" id={id} aria-label={`${bot.name} 的 Bot 侧栏`}>
      <nav className="bot-workspace-tabs" aria-label="Bot 页面">
        {TABS.map(({ id, label }) => <button type="button" key={id} aria-current={tab === id ? "page" : undefined}
          onClick={() => { setTab(id); setSettings(undefined); }}><PanelIcon name={id} /><span>{label}</span></button>)}
        <button className="bot-workspace-icon" ref={heading} type="button" aria-label="收起 Bot 侧栏" aria-controls={id} aria-expanded onClick={() => { expand(false); requestAnimationFrame(() => collapsed.current?.focus()); }}><PanelIcon name="panel" /></button>
      </nav>
      <div className="bot-workspace-page" data-page={settings ? "settings" : tab}>
        {tab === "home" && (settings
          ? <BotWorkspaceSettings bot={bot} link={link} state={state} initialSection={settings} onBack={() => setSettings(undefined)} onDeleted={() => setView({ kind: "bots" })}
            onOpenChat={openSession} onOpenConnectors={() => { setSettings(undefined); setTab("connectors"); }} onShare={() => setSharing(true)} />
          : <div className="bot-workspace-home">
            <BotWorkspaceIdentity bot={bot} online={online} onSettings={() => showSettings()} onShare={() => setSharing(true)} link={link} />
            <section className="bot-workspace-activity" aria-label="Bot 事项">
              {!(pending.length || requests.length || workers.length) && <div className="bot-workspace-empty">
                <IconPlan /><strong>还没有事项</strong><p>当 {bot.name} 为你接手任务时，可以在这里查看进度和待处理项。</p>
              </div>}
              {pending.map((chat) => <button key={chat.id} type="button" className="bot-workspace-line" onClick={() => openSession(chat)}>
                <IconPlan /><span>{botChatName(chat, bot.homeSessionId)}</span><small>待你处理</small>
              </button>)}
              {workers.map((worker) => <button key={worker.id} type="button" className="bot-workspace-line" onClick={() => openTask(worker.id)}>
                <IconWorktree /><span>{worker.title}</span><small>工作者</small>
              </button>)}
              {teamTasksEnabled && <PlaneBotJobs link={link} botId={bot.id} onOpen={openTask} />}
              {!!requests.length && <details className="bot-workspace-section" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
                <summary><IconChevronDown />请求记录 <span>{requests.length}</span></summary>
                {historyOpen && <BotRequestList rows={requests} bots={bots} onOpen={openTask} leadDirectory={directory} onChanged={reloadRequests} />}
              </details>}
            </section>
            <details className="bot-workspace-section" open>
              <summary><IconChevronDown />自动化</summary>
              <button className="bot-workspace-line" type="button" onClick={() => showSettings("automation")}>
                <IconClock /><span>巡视</span><small>{inspection?.enabled ? scheduleText(inspection.schedule) : "未启用"}</small>
              </button>
              <button className="bot-workspace-line" type="button" onClick={() => showSettings("automation")}><IconPlan /><span>整理记忆</span><small>{!memorySupported ? "当前渠道不可用" : memory?.enabled ? scheduleText(memory.schedule) : "未启用"}</small></button>
            </details>
            <details className="bot-workspace-section" open>
              <summary><IconChevronDown />建议</summary>
              <button type="button" className="bot-workspace-line" disabled={!bot.enabled} onClick={() => newChat("介绍你能帮我做哪些事，以及开始前需要我提供什么。")}><IconSparkle /><span>了解 {bot.name} 能帮你做什么</span></button>
              {workspace && !isCommon(workspace) && <button type="button" className="bot-workspace-line" disabled={!bot.enabled}
                onClick={() => newChat(`请检查「${workspace.name}」最近的改动，列出需要我关注的问题。`)}><IconSearch /><span>检查「{workspace.name}」最近的改动</span></button>}
            </details>
          </div>)}
        {tab === "connectors" && <div className="bot-workspace-connectors"><BotWebhooks link={link} id={bot.id} /></div>}
        {tab === "chats" && <BotWorkspaceChats bot={bot} chats={chats} previews={sidebar.chatPreviews} requests={requests} workers={workers} selected={selectedSession}
          newDisabled={!bot.enabled || online === false} onHome={openHome} onOpen={openSession}
          onWorker={(taskId) => openTask(taskId, sessions.find((session) => session.taskId === taskId && session.kind === "main" && !session.parentId)?.id)} onNew={() => newChat()} />}
        {tab === "files" && <BotWorkspaceFiles link={link} bot={bot} />}
      </div>
    </aside>}
    {sharing && <Modal portal label="分享 Bot" className="bot-dialog" backdropClassName="bot-backdrop" onClose={() => setSharing(false)}>
      <header className="bot-dialog-head"><h2>分享 {bot.name}</h2></header>
      <p className="settings-hint">导出职责文件，接收者可以从 Bots 的「从其他应用导入」创建。</p>
      <footer className="bot-dialog-actions">
        <button type="button" className="btn-ghost" onClick={() => setSharing(false)}>关闭</button>
        <a className="btn-primary bot-share-download" download="SOUL.md" href={`data:text/markdown;charset=utf-8,${encodeURIComponent(bot.purpose)}`}>下载职责文件</a>
      </footer>
    </Modal>}
  </div>;
}

function toastError(error: unknown) {
  showToast({ text: error instanceof Error ? error.message : String(error), error: true });
}

function BotWorkspaceIdentity({ bot, online, onSettings, onShare, link }: {
  bot: StudioBot; online?: boolean; onSettings(): void; onShare(): void; link: ViewContext["link"];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number }>();
  const [saving, setSaving] = useState(false);
  function close() {
    if (document.activeElement?.closest(".action-menu")) trigger.current?.focus({ preventScroll: true });
    setAt(undefined);
  }
  async function toggleBot() {
    setSaving(true);
    try { await call(link, "PATCH /api/bots/:id", { id: bot.id }, { enabled: !bot.enabled }); }
    catch (error) { toastError(error); }
    finally { setSaving(false); }
  }
  return <header className="bot-workspace-identity">
    <BotAvatar name={bot.name} avatar={bot.avatar} size={36} />
    <div><h2>{bot.name}{!bot.enabled && <small>已暂停</small>}</h2><p title={bot.purpose}>{bot.purpose}</p></div>
    <button type="button" className="bot-workspace-icon" title="Bot 设置" aria-label="Bot 设置" onClick={onSettings}><PanelIcon name="settings" /></button>
    <button type="button" className="bot-workspace-icon bot-workspace-more" ref={trigger} aria-label="Bot 更多操作" aria-haspopup="menu" aria-expanded={!!at} onClick={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      setAt(at ? undefined : { x: Math.max(4, bounds.right - 160), y: bounds.bottom + 4 });
    }}>⋯</button>
    {at && createPortal(<ActionMenu label="Bot 更多操作" at={at} onClose={close} focus groups={[
      [{ label: bot.enabled ? "暂停 Bot" : "继续 Bot", icon: bot.enabled ? <IconPause /> : <IconAgent />, disabled: saving || online === false, run: () => void toggleBot() },
        { label: "分享 Bot…", icon: <PanelIcon name="share" />, run: onShare }],
      [{ label: "复制路径", icon: <IconCopy />, disabled: online === false, title: "复制 Bot 的资料目录", run: () => {
        void call(link, "GET /api/bots/:id/files", { id: bot.id }).then(({ folder }) => copyText(folder))
          .then(() => showToast({ text: "已复制 Bot 资料目录路径" }), toastError);
      } }],
    ]} />, document.body)}
  </header>;
}

function BotWorkspaceChats({ bot, chats, previews, requests, workers, selected, newDisabled, onHome, onOpen, onWorker, onNew }: {
  bot: StudioBot; chats: readonly Session[]; previews?: Record<string, string>; requests: readonly BotRequest[]; workers: readonly ViewContext["state"]["tasks"][number][];
  selected?: string; newDisabled: boolean; onHome(): void; onOpen(session: Session): void; onWorker(id: string): void; onNew(): void;
}) {
  const [query, setQuery] = useState("");
  const term = query.normalize("NFKC").trim().toLowerCase();
  const matches = (...words: string[]) => words.join(" ").normalize("NFKC").toLowerCase().includes(term);
  const home = chats.find((chat) => chat.id === bot.homeSessionId);
  const requestPreviews = new Map<string, string>();
  for (const request of requests) if (request.sessionId && !requestPreviews.has(request.sessionId)) requestPreviews.set(request.sessionId, request.result || request.text);
  const preview = (id: string) => previews?.[id] || requestPreviews.get(id) || "";
  function row(title: string, secondary: string, icon: ReactNode, click: () => void, active = false, stamp?: string) {
    return <button type="button" className="bot-workspace-chat-row" aria-current={active || undefined} onClick={click}>
      {icon}<span><strong>{title}</strong>{secondary && <small title={secondary}>{secondary}</small>}</span>{stamp && <time dateTime={stamp}>{relativeTime(stamp)}</time>}
    </button>;
  }
  const showHome = matches("主聊天", bot.name, bot.purpose, home ? preview(home.id) : "");
  const chatRows = chats.filter((chat) => chat.id !== home?.id && matches(botChatName(chat, bot.homeSessionId), preview(chat.id)));
  const workerRows = workers.filter((task) => matches(task.title, task.description ?? ""));
  return <section className="bot-workspace-chats" aria-label="Bot 聊天列表">
    <div className="bot-workspace-chat-tools">
      <label className="bot-search-box"><IconSearch /><input type="search" aria-label="搜索聊天和工作者" placeholder="搜索聊天和工作者" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button className="btn-ghost small" type="button" disabled={newDisabled} onClick={onNew}><IconPlus />新建聊天</button>
    </div>
    <div className="bot-workspace-chat-rows">
      {showHome && row("主聊天", (home && preview(home.id)) || bot.purpose, <PanelIcon name="home" />, onHome, !!home && selected === home.id, home?.updatedAt)}
      {chatRows.map((chat) => <div key={chat.id}>{row(botChatName(chat, bot.homeSessionId), chat.archivedAt ? "已归档" : preview(chat.id), <PanelIcon name="chats" />, () => onOpen(chat), selected === chat.id, chat.updatedAt)}</div>)}
      {workerRows.map((task) => <div key={task.id}>{row(task.title, "工作者", <IconWorktree />, () => onWorker(task.id), false, task.updatedAt)}</div>)}
      {!showHome && !chatRows.length && !workerRows.length && <p className="settings-hint">没有匹配的聊天或工作者。</p>}
    </div>
  </section>;
}
