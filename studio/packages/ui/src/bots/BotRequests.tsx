import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { BotRequest, SessionItem, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { BotAvatar, TranscriptBots } from "./BotAvatar.js";
import { Markdown } from "../lib/markdown.js";

export function useBotRequests(link: HostLink, sessionId: string | null, lastReplyId?: string) {
  const [stored, setStored] = useState<{ source: string; rows: BotRequest[] }>();
  const [revision, refresh] = useState(0);
  const rows = stored?.source === sessionId ? stored?.rows ?? [] : [];
  const pending = rows.some((row) => ["queued", "running", "waiting"].includes(row.status));
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    const load = () => { void call(link, "GET /api/bot-requests", {}, undefined, { sourceSessionId: sessionId }).then((rows) => { if (current) setStored({ source: sessionId, rows }); }).catch(() => {}); };
    load();
    const interval = pending ? setInterval(load, 1500) : undefined;
    return () => { current = false; clearInterval(interval); };
  }, [link, sessionId, pending, revision, lastReplyId]);
  return { rows, refresh: () => refresh((n) => n + 1) };
}

export const BOT_REQUEST_STATUS: Record<BotRequest["status"], string> = { queued: "排队中", running: "处理中", waiting: "等待你的回复", completed: "已完成", stopped: "已停止", failed: "失败" };

type FollowUp = (row: BotRequest, text: string, id: string) => Promise<void>;

export const BotConversation = createContext<{ rows: readonly BotRequest[]; onFollowUp?: FollowUp }>({ rows: [] });

/** Agent-dispatched replies already have an inbox item. Direct sends only have a request record. */
export function withBotReplies(items: readonly SessionItem[], rows: readonly BotRequest[]): readonly SessionItem[] {
  const ids = new Set(items.map((item) => item.id));
  const notices: SessionItem[] = [];
  for (const row of rows) {
    const id = `bot-reply:${row.id}`;
    if (!row.sourceSessionId || ids.has(id) || row.reported) continue;
    notices.push({ type: "notice", id, sessionId: row.sourceSessionId, seq: 0, createdAt: row.settledAt ?? row.createdAt, level: "info", message: row.text });
  }
  if (!notices.length) return items;
  notices.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const merged: SessionItem[] = [];
  let i = 0;
  for (const item of items) {
    while (i < notices.length && notices[i]!.createdAt < item.createdAt) merged.push(notices[i++]!);
    merged.push(item);
  }
  return merged.concat(notices.slice(i));
}

export function BotReply({ item }: { item: SessionItem }) {
  const { rows, onFollowUp } = useContext(BotConversation);
  const bots = useContext(TranscriptBots);
  const row = rows.find((r) => item.id === `bot-reply:${r.id}`);
  const letter = item.type === "user" && item.botLetter?.kind === "reply" ? item.botLetter : undefined;
  // Older letters outlive the request list's 100-row window. Their first line includes the original subject.
  let subject = row?.text;
  if (!subject && letter && item.type === "user" && item.text.startsWith("【Bot 回信】")) {
    try {
      const payload = JSON.parse(item.text.split("\n", 1)[0]!.slice("【Bot 回信】".length));
      if (typeof payload.question === "string") subject = payload.question;
    } catch { /* The saved letter alone still supplies its sender and answer. */ }
  }
  const name = row?.botName ?? letter?.heading.replace(/ · [^·]+$/, "") ?? "Bot";
  const bot = bots.find((b) => row ? b.id === row.botId : b.name === name);
  const result = row?.result ?? letter?.text;
  const status = row ? BOT_REQUEST_STATUS[row.status] : "回信";
  return <details className="bot-inline-reply" data-testid="bot-request">
    <summary><BotAvatar name={name} avatar={bot?.avatar} size={18} /><strong>{name}</strong>
      <span className="bot-reply-subject">{row?.status === "completed" ? "回复" : status}{subject ? ` · ${subject}` : ""}</span>
      <span className="bot-reply-chevron" aria-hidden="true">›</span></summary>
    <div className="bot-reply-body">
      {row && <div className="settings-hint">{status} · {row.text}</div>}
      {result && <Markdown source={result} />}
      {row?.sessionId && row.status === "completed" && bot?.enabled && onFollowUp && <BotFollowUp row={row} send={onFollowUp} />}
      {row?.taskId && row.sessionId && <button type="button" className="btn-ghost small" onClick={() => void window.amo?.openInWorkbench?.({ taskId: row.taskId!, sessionId: row.sessionId! })}>打开 Bot 会话 ↗</button>}
    </div>
  </details>;
}

function BotFollowUp({ row, send }: { row: BotRequest; send: FollowUp }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ text: string; id: string } | null>(null);
  async function submit() {
    const message = text.trim();
    if (!message || pending) return;
    if (attempt.current?.text !== message) attempt.current = { text: message, id: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      await send(row, message, attempt.current.id);
      setText(""); setOpen(false); attempt.current = null;
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(false); }
  }
  if (!open) return <button type="button" className="btn-ghost small" onClick={() => setOpen(true)}>追问 {row.botName}</button>;
  return <form className="bot-followup" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <textarea autoFocus className="field" aria-label={`追问 ${row.botName}`} placeholder="继续这段对话…" maxLength={20000} rows={2} value={text} disabled={pending} onChange={(e) => setText(e.target.value)} />
    <div className="settings-row"><button type="submit" className="btn-primary small" disabled={pending || !text.trim()}>发送追问</button>
      <button type="button" className="btn-ghost small" disabled={pending} onClick={() => setOpen(false)}>收起</button></div>
    {error && <div className="form-error" role="alert">{error}</div>}
  </form>;
}

export function BotRequestList({ rows, bots, onOpen, onWorker }: { rows: readonly BotRequest[]; bots: readonly StudioBot[]; onOpen?: (taskId: string, sessionId: string) => void; onWorker?: (id: string) => void }) {
  if (!rows.length) return null;
  const avatars = new Map(bots.map((bot) => [bot.id, bot.avatar]));
  return <section className="bot-requests" aria-label="Bot 请求">
    {[...rows].reverse().map((row) => <article key={row.id} className="bot-request" data-testid="bot-request">
      <div className="bot-request-heading"><strong className="bot-identity"><BotAvatar name={row.botName} avatar={avatars.get(row.botId)} />@{row.botName}</strong><span className="settings-hint" role="status">{BOT_REQUEST_STATUS[row.status]}</span></div>
      <div>{row.text}</div>
      {row.result && <details><summary>{row.status === "failed" ? "失败原因" : "查看结论"}</summary><div className="bot-request-result">{row.result}</div></details>}
      {row.taskId && row.sessionId && <button type="button" className="btn-ghost small" onClick={() => {
        if (onOpen) onOpen(row.taskId!, row.sessionId!);
        else void window.amo?.openInWorkbench?.({ taskId: row.taskId!, sessionId: row.sessionId! });
      }}>打开 Bot 会话 ↗</button>}
      {row.status === "completed" && row.result && onWorker && <button type="button" className="btn-ghost small" onClick={() => onWorker(row.id)}>在独立工作树开始执行</button>}
    </article>)}
  </section>;
}
