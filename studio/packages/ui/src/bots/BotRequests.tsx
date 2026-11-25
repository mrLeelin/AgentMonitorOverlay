import { useEffect, useState } from "react";
import type { BotRequest, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { BotAvatar } from "./BotAvatar.js";

const BOTS_CHANGED = "amo:bots-changed";
const NO_BOTS: readonly StudioBot[] = [];

export function botsChanged() { window.dispatchEvent(new Event(BOTS_CHANGED)); }

export function useBots(link: HostLink, active = true): readonly StudioBot[] {
  const [bots, setBots] = useState<readonly StudioBot[]>(NO_BOTS);
  useEffect(() => {
    if (!active) return;
    let current = true;
    const load = () => { void call(link, "GET /api/bots").then((value) => { if (current) setBots(value); }).catch(() => {}); };
    load();
    window.addEventListener(BOTS_CHANGED, load);
    return () => { current = false; window.removeEventListener(BOTS_CHANGED, load); };
  }, [link, active]);
  return active ? bots : NO_BOTS;
}

export function useBotRequests(link: HostLink, sessionId: string | null) {
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
  }, [link, sessionId, pending, revision]);
  return { rows, refresh: () => refresh((n) => n + 1) };
}

const BOT_REQUEST_STATUS: Record<BotRequest["status"], string> = { queued: "排队中", running: "处理中", waiting: "等待你的回复", completed: "已完成", stopped: "已停止", failed: "失败" };

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
