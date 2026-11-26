import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BotGroup, BotGroupPost, BotRequest, StudioBot } from "@amo-studio/protocol";
import { mentionSpans } from "../attach/mentions.js";
import { IconOpenWindow, IconPeople, IconReply, IconStop, IconX } from "../chat/icons.js";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Markdown } from "../lib/markdown.js";
import { showError } from "../lib/toast.js";
import { BotAvatar, BotGroupAvatar } from "./BotAvatar.js";
import { BotGroupComposer, type BotGroupComposerHandle } from "./BotGroupComposer.js";
import { BotGroupDialog } from "./BotGroupDialog.js";
import { BOT_REQUEST_STATUS } from "./BotRequests.js";
import { groupMentionNames } from "./groupRouting.js";
import { groupMembers, useBotGroup, useBots } from "./roster.js";

type OpenChat = (taskId: string, sessionId: string) => void;
const stillWorking = (reply: BotRequest) => reply.status === "queued" || reply.status === "running" || reply.status === "waiting";
const hours = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

export function BotGroupPage({ link, id, onBack, onOpen }: { link: HostLink; id: string; onBack(): void; onOpen: OpenChat }) {
  const group = useBotGroup(link, id);
  const bots = useBots(link);
  return group
    ? <BotGroupChat key={id} link={link} group={group} bots={bots} onOpen={onOpen} />
    : <section className="bot-group-unavailable" aria-label="Bot 群组">{group === undefined ? <p>正在读取群组…</p> : <>
      <p>群组已删除或暂不可用。</p><button type="button" className="btn-ghost" onClick={onBack}>返回 Bots</button>
    </>}</section>;
}

function BotGroupChat({ link, group, bots, onOpen }: { link: HostLink; group: BotGroup; bots: readonly StudioBot[]; onOpen: OpenChat }) {
  const [overview, setOverview] = useState(() => !window.matchMedia("(max-width: 860px)").matches);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const composer = useRef<BotGroupComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const replySessions = useRef(new Set<string>());
  const members = groupMembers(group, bots);
  const [posts, setPosts, reload] = useLiveResource<BotGroupPost[] | null>({
    initial: null,
    load: async () => {
      const rows = await call(link, "GET /api/bot-groups/:id/posts", { id: group.id });
      setLoadError("");
      return rows;
    },
    onError: (error) => setLoadError(error instanceof Error ? error.message : String(error)),
    reloadDelay: 80,
    reloadOn: (event) => event.type === "bot-group-posts.changed" ? event.groupId === group.id
      : event.type === "session.upserted" && replySessions.current.has(event.session.id),
  }, [link, group.id]);
  const replies = posts?.flatMap((post) => post.replies) ?? [];
  replySessions.current = new Set(replies.flatMap((reply) => reply.sessionId ? [reply.sessionId] : []));
  const hasPending = !!posts?.some((post) => post.dispatchComplete === false) || replies.some(stillWorking);
  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(reload, 1400);
    return () => clearInterval(interval);
  }, [hasPending, reload]);

  useLayoutEffect(() => {
    const area = scroller.current;
    if (area && stickToBottom.current) area.scrollTop = area.scrollHeight;
  }, [posts, overview]);

  async function send(payload: { id: string; text: string; targetIds: string[] }) {
    const post = await call(link, "POST /api/bot-groups/:id/posts", { id: group.id }, payload);
    stickToBottom.current = true;
    setPosts((current) => current?.some((item) => item.id === post.id) ? current : [post, ...(current ?? [])]);
    reload();
  }

  return <section className="bot-group-page" aria-label="Bot 群组">
    <header className="bot-group-header">
      <BotGroupAvatar members={members} size={26} />
      <div className="bot-group-title"><h2>{group.name}</h2><span>{members.length} 位成员</span></div>
      <button type="button" className="btn-ghost small bot-group-overview-button" aria-pressed={overview}
        onClick={() => setOverview(!overview)}><IconPeople />群组信息</button>
    </header>
    <div className="bot-group-layout">
      <div className="bot-group-conversation">
        <div className="bot-group-scroll" ref={scroller} onScroll={(event) => {
          const area = event.currentTarget;
          stickToBottom.current = area.scrollHeight - area.clientHeight - area.scrollTop < 64;
        }}>
          {loadError && <div className="bot-group-load form-error" role="alert">{loadError} <button className="btn-ghost small" type="button" onClick={reload}>重新读取</button></div>}
          {!posts && !loadError && <p className="bot-group-load">正在读取群组消息…</p>}
          {posts?.length === 0 && <div className="bot-group-empty">
            <BotGroupAvatar members={members} size={42} />
            <h3>{group.name}</h3>
            <p>用 <kbd>@</kbd> 提及成员，或用 <kbd>@everyone</kbd> 让所有成员回复。</p>
          </div>}
          {!!posts?.length && <div className="bot-group-timeline" aria-label="群组聊天记录">
            {[...posts].reverse().map((post) => {
              const mentions = groupMentionNames(post.text, members);
              const byBot = new Map(post.replies.map((reply) => [reply.botId, reply]));
              const author = post.author;
              const target = post.targetIds[0];
              const targetName = target && (byBot.get(target)?.botName ?? bots.find((bot) => bot.id === target)?.name);
              return <article key={post.id} className="bot-group-message" data-testid="bot-group-post">
                <div className={author ? "bot-group-user bot-group-forward" : "bot-group-user"}>
                  {author && <span className="bot-group-forward-label"><BotAvatar name={author.botName} avatar={bots.find((bot) => bot.id === author.botId)?.avatar} size={18} />
                    {targetName ? `${author.botName} 向 ${targetName} 提问` : `${author.botName} 发出提问`}</span>}
                  <div className="bot-group-bubble">{mentionSpans(post.text, mentions).map((span, i) => span.mention ? <mark key={i}>{span.text}</mark> : span.text)}</div>
                  <time dateTime={post.createdAt} title={new Date(post.createdAt).toLocaleString()}>{hours.format(new Date(post.createdAt))}</time>
                </div>
                {post.targetIds.map((id) => {
                  const reply = byBot.get(id);
                  const bot = bots.find((entry) => entry.id === id);
                  if (!reply) return <div className="bot-group-reply-hold" key={id}><BotAvatar name={bot?.name ?? "Bot"} avatar={bot?.avatar} size={24} />
                    <strong>{bot?.name ?? "Bot"}</strong><span>{post.dispatchComplete === false ? "正在分派" : "未分派"}</span></div>;
                  return <GroupReply key={id} reply={reply} bot={bot} onOpen={onOpen}
                    onReply={bot?.enabled && group.memberIds.includes(id) ? () => composer.current?.replyTo(bot) : undefined}
                    onStop={async () => {
                      await call(link, "POST /api/bot-groups/:id/posts/:postId/replies/:botId/stop", { id: group.id, postId: post.id, botId: id });
                      reload();
                    }} />;
                })}
              </article>;
            })}
          </div>}
        </div>
        <BotGroupComposer ref={composer} link={link} groupId={group.id} members={members} onSend={send} />
      </div>
      {overview && <aside className="bot-group-overview" aria-label="群组信息">
        <header><h3>群组成员</h3><button className="bot-icon-button" type="button" aria-label="关闭群组信息" onClick={() => setOverview(false)}><IconX /></button></header>
        <ul>{members.map((member) => <li key={member.id}>
          <BotAvatar name={member.name} avatar={member.avatar} size={29} /><span><strong>{member.name}</strong>
            {(!member.enabled || member.purpose) && <small>{member.enabled ? member.purpose : "已暂停"}</small>}</span>
        </li>)}</ul>
        {!members.length && <p>群组还没有成员。</p>}
        <button type="button" className="btn-ghost small" onClick={() => setEditing(true)}>管理成员</button>
      </aside>}
    </div>
    {editing && <BotGroupDialog link={link} bots={bots} group={group} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />}
  </section>;
}

function GroupReply({ reply, bot, onOpen, onReply, onStop }: { reply: BotRequest; bot?: StudioBot; onOpen: OpenChat; onReply?: () => void; onStop(): Promise<void> }) {
  const [stopping, setStopping] = useState(false);
  const name = reply.botName;
  const pending = stillWorking(reply);
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try { await onStop(); }
    catch (error) { showError(error instanceof Error ? error.message : String(error)); }
    finally { setStopping(false); }
  }
  return <section className="bot-group-reply" data-testid="bot-request" data-status={reply.status} aria-label={`${name}的回复`}>
    <header>
      <BotAvatar name={name} avatar={bot?.avatar} size={24} /><strong>{name}</strong>
      <span className="bot-group-reply-status"><i aria-hidden="true" />{stopping ? "正在停止" : BOT_REQUEST_STATUS[reply.status]}</span>
      <div className="bot-group-reply-actions">
        {pending && <button type="button" className="bot-icon-button" aria-label={`停止 ${name} 的回复`} title="停止此回复" disabled={stopping} onClick={() => void stop()}><IconStop /></button>}
        {onReply && <button type="button" className="bot-icon-button" aria-label={`回复 ${name}`} title={`回复 ${name}`} onClick={onReply}><IconReply /></button>}
        {reply.taskId && reply.sessionId && <button type="button" className="bot-icon-button" aria-label={`打开 ${name} 的会话`} title="打开 Bot 会话" onClick={() => onOpen(reply.taskId!, reply.sessionId!)}><IconOpenWindow /></button>}
      </div>
    </header>
    {reply.result && <div className="bot-group-reply-body"><Markdown source={reply.result} /></div>}
  </section>;
}
