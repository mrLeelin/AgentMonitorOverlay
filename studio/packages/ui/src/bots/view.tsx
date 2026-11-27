import { useEffect, useState } from "react";
import { inTurn, type BotRequest, type Session } from "@amo-studio/protocol";
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

export const botsView: ViewDef<"bots"> = {
  kind: "bots",
  render: (view, { link, state, setView }) => {
    const openChat = (taskId: string, sessionId?: string, botId?: string) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { ...view, ...(botId ? { botId } : {}) }, nav: Date.now() });
    return view.groupId ? <BotGroupPage link={link} id={view.groupId} onOpen={openChat} onBack={() => setView({ kind: "bots" })} />
      : <BotsWorkbench link={link} sessions={state.sessions} botId={view.botId}
        onPick={(botId) => setView({ kind: "bots", botId })} onGroup={(groupId) => setView({ kind: "bots", groupId })} onOpen={openChat} />;
  },
};

function openSettings(page: "bots" | "duty") {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: page }));
}

function BotsWorkbench({ link, sessions, botId, onPick, onGroup, onOpen }: { link: HostLink; sessions: readonly Session[]; botId?: string; onPick(botId: string): void; onGroup(groupId: string): void; onOpen(taskId: string, sessionId?: string, botId?: string): void }) {
  const bots = useBots(link);
  const groups = useBotGroups(link);
  const duty = useDuty();
  const teamTasksEnabled = useSettings(link)?.teamTasksEnabled === true;
  const [requests, setRequests] = useState<BotRequest[]>([]);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const bot = bots.find((item) => item.id === botId) ?? bots[0];
  const chats = bot?.taskId ? sessions.filter((s) => s.taskId === bot.taskId && !s.parentId && s.kind === "main") : [];
  const scheduled = duty?.items.filter((item) => item.action.kind === "bot" && item.action.botId === bot?.id) ?? [];
  const rows = requests.filter((row) => row.botId === bot?.id);
  const pending = chats.filter((chat) => chat.status === "awaiting-answer" || chat.status === "awaiting-approval" || chat.status === "awaiting-review");
  useEffect(() => {
    let active = true;
    const load = () => { void call(link, "GET /api/bot-requests").then((rows) => { if (active) setRequests(rows); }).catch(() => {}); };
    load();
    const interval = setInterval(load, 2500);
    return () => { active = false; clearInterval(interval); };
  }, [link]);

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

  async function startWorker(id: string) {
    if (opening || !window.confirm("从项目当前提交创建独立工作树，并启动执行会话？")) return;
    setOpening(true);
    setError("");
    try {
      const { task, session } = await call(link, "POST /api/bot-requests/:id/worker", { id });
      onOpen(task.id, session?.id);
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
        {!!rows.length && <section className="settings-section"><strong>请求记录</strong><BotRequestList rows={rows} bots={bots} onOpen={onOpen} onWorker={(id) => void startWorker(id)} /></section>}
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
