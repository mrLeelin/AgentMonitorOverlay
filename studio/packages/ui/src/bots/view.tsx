import { useEffect, useRef, useState } from "react";
import { inTurn, type BotRequest, type DecisionRequest, type Session, type StateSnapshot, type StudioBot } from "@amo-studio/protocol";
import type { ViewDef } from "../shell/views.js";
import { call, type HostLink } from "../host/client.js";
import { BotRequestList } from "./BotRequests.js";
import { botChatName, groupMembers, useBotGroups, useBots } from "./roster.js";
import { OPEN_SETTINGS_EVENT } from "../mcp/shared.js";
import { scheduleText } from "../settings/DutyPage.js";
import { useDuty } from "../duty/duty.js";
import { BotAvatar, BotGroupAvatar } from "./BotAvatar.js";
import { BotGroupPage } from "./BotGroupChat.js";
import { BotGroupDialog } from "./BotGroupDialog.js";
import { useSettings } from "../settings/useSettings.js";
import { PlaneBotJobs } from "../teamtasks/PlaneBotJobs.js";
import type { LeadCanvasOpen } from "./LeadAppointment.js";
import { leadCanvasView } from "./lead-navigation.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { BotChatEmpty, BotWorkspaceChat } from "./BotWorkspaceChat.js";
import { botConversationView } from "./BotWorkspace.js";

export const botsView: ViewDef<"bots"> = {
  kind: "bots",
  render: (view, { link, state, data, online, setView }) => {
    const openChat = (taskId: string, sessionId?: string, botId?: string) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { ...view, ...(botId ? { botId } : {}) }, ...(botId ? { botWorkspace: botId } : {}), nav: Date.now() });
    if (view.chat && view.botId) return <BotConversationStart key={`${view.botId}:${view.chat}:${view.nav ?? 0}`} link={link} botId={view.botId}
      mode={view.chat} initialText={view.initialText} online={online} onOpen={(bot, session) => setView(botConversationView(bot, session))} />;
    return view.groupId ? <BotGroupPage link={link} id={view.groupId} onOpen={openChat} onBack={() => setView({ kind: "bots" })} />
      : <BotsWorkbench link={link} state={state} decisions={data.openDecisions} botId={view.botId} onCanvas={(topicId, taskId, attention) => setView(leadCanvasView(topicId, taskId, attention, view))}
        onPick={(botId) => setView({ kind: "bots", botId })} onGroup={(groupId) => setView({ kind: "bots", groupId })} onOpen={openChat} />;
  },
};

function BotConversationStart({ link, botId, mode, initialText, online, onOpen }: {
  link: HostLink; botId: string; mode: "empty-home" | "new"; initialText?: string; online?: boolean;
  onOpen(bot: StudioBot, session: Session): void;
}) {
  const bot = useBots(link).find((item) => item.id === botId);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const open = useRef({ bot, onOpen });
  open.current = { bot, onOpen };
  const shouldOpenHome = mode === "empty-home" && bot?.enabled === true && online !== false;
  useEffect(() => {
    if (!shouldOpenHome) return;
    let current = true;
    setError("");
    void call(link, "POST /api/bots/:id/home", { id: botId }, {}).then((session) => {
      if (current && open.current.bot) open.current.onOpen(open.current.bot, session);
    }, (error: unknown) => {
      if (current) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { current = false; };
  }, [botId, link.url, link.token, shouldOpenHome, retry]);
  if (!bot) return <div className="placeholder">正在读取 Bot…</div>;
  if (mode === "empty-home") return <div className="bot-chat-start">
    <div className="bot-chat-start-content"><BotChatEmpty bot={bot} />
      <div className="bot-workspace-home-status">
        {error && shouldOpenHome ? <><p className="form-error" role="alert">{error}</p><button type="button" className="btn-ghost small" onClick={() => setRetry((n) => n + 1)}>重试</button></>
          : <p className="side-note" role="status">{!bot.enabled ? "这个 Bot 已暂停" : online === false ? "Host 已断开连接" : "正在打开主聊天…"}</p>}
      </div>
    </div>
  </div>;
  return <BotWorkspaceChat link={link} bot={bot} online={online} initialText={initialText} onOpen={(session) => onOpen(bot, session)} />;
}

function openSettings(page: "bots" | "duty") {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: page }));
}

function BotsWorkbench({ link, state, decisions, botId, onPick, onGroup, onOpen, onCanvas }: { link: HostLink; state: StateSnapshot; decisions: readonly DecisionRequest[]; botId?: string; onPick(botId: string): void; onGroup(groupId: string): void; onOpen(taskId: string, sessionId?: string, botId?: string): void; onCanvas: LeadCanvasOpen }) {
  const { sessions, tasks, topics, workspaces, profiles } = state;
  const bots = useBots(link);
  const groups = useBotGroups(link);
  const duty = useDuty();
  const teamTasksEnabled = useSettings(link)?.teamTasksEnabled === true;
  const [requests, setRequests] = useState<BotRequest[]>([]);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [revision, setRevision] = useState(0);
  const bot = bots.find((item) => item.id === botId) ?? bots[0];
  const chats = bot?.taskId ? sessions.filter((s) => s.taskId === bot.taskId && !s.parentId && s.kind === "main") : [];
  const scheduled = duty?.items.filter((item) => item.action.kind === "bot" && item.action.botId === bot?.id) ?? [];
  const rows = requests.filter((row) => row.botId === bot?.id);
  const pending = chats.filter((chat) => chat.status === "awaiting-answer" || chat.status === "awaiting-approval" || chat.status === "awaiting-review");
  const directory = { link, tasks, topics, workspaces, profiles, bots, decisions, onCanvas, onTask: onOpen };
  useEffect(() => {
    let active = true;
    const load = () => { void call(link, "GET /api/bot-requests").then((rows) => { if (active) setRequests(rows); }).catch(() => {}); };
    load();
    const interval = setInterval(load, 2500);
    const offEvents = onHostEvent((event) => { if (event.type === "bot-lead.changed" || event.type === "bots.changed") load(); });
    const offReconnect = onHostReconnect(load);
    return () => { active = false; clearInterval(interval); offEvents(); offReconnect(); };
  }, [link.url, link.token, revision]);

  async function openHome() {
    if (!bot || opening) return;
    setOpening(true);
    setError("");
    try {
      const home = await call(link, "POST /api/bots/:id/home", { id: bot.id }, {});
      if (home.taskId) onOpen(home.taskId, home.id, bot.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setOpening(false); }
  }

  return <section className="bots-workbench" aria-label="Bots 工作台">
    <div className="bots-workbench-header"><div><h2>Bots</h2><span className="settings-hint">查看 Bot 的聊天、待处理请求和值守。</span></div><button className="btn-ghost" type="button" onClick={() => openSettings("bots")}>管理 Bots</button></div>
    <div className="bots-workbench-grid">
      <aside aria-label="Bot 列表"><div className="bots-roster">
        {bots.map((item) => <button key={item.id} className="wb-nav-link" aria-pressed={item.id === bot?.id} type="button" onClick={() => { onPick(item.id); setError(""); }}><BotAvatar name={item.name} avatar={item.avatar} /><span>{item.name}</span>{!item.enabled && <span className="settings-tag">已停用</span>}</button>)}
        {!bots.length && <p className="settings-hint">还没有 Bot。可通过侧栏的加号创建。</p>}
      </div></aside>
      <div className="bots-workbench-detail">{bot && <>
        <header className="bots-workbench-header"><div className="bot-identity"><BotAvatar name={bot.name} avatar={bot.avatar} size={42} /><div><h3>{bot.name}</h3><p className="settings-hint">{bot.purpose}</p></div></div><button type="button" className="btn-primary" disabled={!bot.enabled || opening} onClick={() => void openHome()}>打开主聊天</button></header>
        {error && <p className="form-error" role="alert">{error}</p>}
        {!!pending.length && <section className="settings-section"><strong>待你处理</strong>{pending.map((chat) => <button key={chat.id} className="btn-ghost small bot-history-row" type="button" onClick={() => onOpen(chat.taskId!, chat.id)}>{chat.title || "未命名聊天"} ↗</button>)}</section>}
        {teamTasksEnabled && <PlaneBotJobs key={bot.id} link={link} botId={bot.id} onOpen={onOpen} />}
        <section className="settings-section"><strong>聊天记录</strong>{chats.length === 0 && <span className="settings-hint">还没有聊天。</span>}
          {[...chats].reverse().map((chat) => <button key={chat.id} className="btn-ghost small bot-history-row" type="button" onClick={() => onOpen(chat.taskId!, chat.id)}>{botChatName(chat, bot.homeSessionId)}{chat.archivedAt ? "（已归档）" : inTurn(chat.status) ? "（运行中）" : ""} ↗</button>)}
        </section>
        <section className="settings-section"><div className="settings-row"><strong>值守</strong><button className="btn-ghost small" type="button" onClick={() => openSettings("duty")}>管理值守</button></div>
          {scheduled.length ? scheduled.map((item) => <span key={item.id} className="settings-hint">{item.title} · {scheduleText(item.schedule)}{item.enabled ? "" : " · 已停用"}</span>) : <span className="settings-hint">暂无值守。可以在值守里选择「运行 Bot」。</span>}
        </section>
        {!!rows.length && <section className="settings-section"><strong>请求记录</strong><BotRequestList rows={rows} bots={bots} onOpen={onOpen} leadDirectory={directory} onChanged={() => setRevision((n) => n + 1)} /></section>}
      </>}
      <section className="settings-section" aria-label="Bot 群组">
        <div className="settings-row"><strong>群组</strong><button type="button" className="btn-ghost small" onClick={() => setCreatingGroup(true)}>新建群组</button></div>
        {groups.map((group) => <button type="button" className="wb-nav-link" key={group.id} onClick={() => onGroup(group.id)}><BotGroupAvatar members={groupMembers(group, bots)} />{group.name}</button>)}
      </section>
      </div>
    </div>
    {creatingGroup && <BotGroupDialog link={link} bots={bots} onClose={() => setCreatingGroup(false)} onSaved={(group) => { setCreatingGroup(false); onGroup(group.id); }} />}
  </section>;
}
