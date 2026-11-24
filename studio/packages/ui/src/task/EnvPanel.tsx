import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ContextUsageCategory, Session, SessionContextUsage, SessionItem, Workspace } from "@amo-studio/protocol";
import { inTurn } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { formatTokens, sessionStats } from "../chat/turns.js";
import { McpStatus } from "../mcp/shared.js";
import { useSessionMcp } from "../mcp/SessionMcp.js";
import { readStored, writeStored } from "../lib/stored.js";
import { shortFolder } from "../files/paths.js";
import { IconChevronRight } from "../chat/icons.js";
import "./env.css";

// 任务页侧栏顶上的「环境与上下文」(2026-11-18 用户定：放侧栏最上面、默认展开)：这台电脑、项目和分支，会话上下文按
// 分项占多少（Claude 才有分项，其他模型只有每轮记下的总量），读进来的说明文件，和会话的 MCP。

const FOLD_KEY = "amo.envPanelFolded";

/** 分项的颜色：按运行时给的稳定 id，没有 id 的按顺序取。 */
const CATEGORY_COLOR: Record<string, string> = {
  system_prompt: "var(--text-dim)",
  system_tools: "#e0864a",
  mcp_tools: "var(--primary)",
  mcp_instructions: "#8f9cf0",
  custom_agents: "#b98ae0",
  memory_files: "#d6b85a",
  skills: "#5fc0c0",
  messages: "var(--running)",
};
const FALLBACK_COLORS = ["#c97fa8", "#7fa8c9", "#a8c97f"];
const categoryColor = (c: ContextUsageCategory, i: number) => (c.id && CATEGORY_COLOR[c.id]) || FALLBACK_COLORS[i % FALLBACK_COLORS.length]!;

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");

/** 读会话的上下文分项：打开时、每一轮结束时、点刷新时。远程副本在另一台电脑上跑，不读。 */
function useContextUsage(link: HostLink, session: Session | null) {
  const [usage, setUsage] = useState<SessionContextUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const id = session?.id ?? null;
  const readable = !!session && session.runtime !== "remote";
  const refresh = useCallback(() => {
    const current = ++request.current;
    if (!id || !readable) return;
    setLoading(true);
    call(link, "GET /api/sessions/:id/context-usage", { id })
      .then((u) => { if (current === request.current && u.sessionId === id) setUsage(u); })
      .catch(() => undefined)
      .finally(() => { if (current === request.current) setLoading(false); });
  }, [link, id, readable]);
  useEffect(() => {
    setUsage(null);
    refresh();
  }, [refresh]);
  // 一轮结束（从回合中变回空闲）时再读一次。
  const running = !!session && inTurn(session.status);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  }, [running, refresh]);
  return { usage: usage?.sessionId === id ? usage : null, loading, refresh };
}

export interface EnvPanelProps {
  link: HostLink;
  session: Session | null;
  items: readonly SessionItem[];
  workspace: Workspace | undefined;
  branch: string | null;
  /** 这台电脑的名字（远程用的设备名）；还没有时不显示。 */
  machine: string | null;
}

export function EnvPanel({ link, session, items, workspace, branch, machine }: EnvPanelProps) {
  const headingId = useId();
  const sectionsId = useId();
  const [folded, setFoldedState] = useState(() => readStored(FOLD_KEY) === "1");
  const setFolded = (on: boolean) => {
    setFoldedState(on);
    writeStored(FOLD_KEY, on ? "1" : "0");
  };
  const { usage, loading, refresh } = useContextUsage(link, session);

  return (
    <section className="env-panel" aria-labelledby={headingId} data-testid="env-panel">
      <div className="env-head">
        <h2 className="env-heading" id={headingId}>
          <button type="button" className="env-fold" aria-controls={sectionsId} aria-expanded={!folded} onClick={() => setFolded(!folded)} data-testid="env-fold">
            <IconChevronRight />
            <span>环境与上下文</span>
          </button>
        </h2>
        {!folded && session && session.runtime !== "remote" && (
          <button type="button" className="btn-ghost small env-refresh" disabled={loading} title="刷新上下文和 MCP 状态" onClick={refresh} data-testid="env-refresh">
            {loading ? "读取中…" : "刷新"}
          </button>
        )}
      </div>
      <div id={sectionsId} className="env-sections" hidden={folded}>
        {!folded && <>
          <EnvFacts session={session} workspace={workspace} branch={branch} machine={machine} />
          {session && <ContextBlock session={session} items={items[0]?.sessionId === session.id ? items : []} usage={usage} />}
          {session && session.runtime !== "remote" && <McpBlock key={session.id} link={link} session={session} refreshKey={usage} />}
        </>}
      </div>
    </section>
  );
}

function EnvFacts({ session, workspace, branch, machine }: { session: Session | null; workspace: Workspace | undefined; branch: string | null; machine: string | null }) {
  const cwd = session?.cwd && session.cwd !== workspace?.path ? session.cwd : null;
  return (
    <div className="env-block" data-testid="env-facts">
      <h3 className="env-sub">运行位置</h3>
      <dl className="env-facts">
        {machine && <EnvRow label="电脑" value={machine} />}
        {workspace && <EnvRow label="项目" value={workspace.name} path={workspace.path} />}
        {branch && <EnvRow label={cwd ? "项目分支" : "分支"} value={branch} />}
        {cwd && <EnvRow label="会话目录" value={baseName(cwd)} path={cwd} />}
      </dl>
      {session?.runtime === "remote" && <div className="env-note">这个会话在另一台电脑上运行。</div>}
    </div>
  );
}

function EnvRow({ label, value, path }: { label: string; value: string; path?: string }) {
  return (
    <div className="env-row" title={path ?? value}>
      <dt className="env-label">{label}</dt>
      <dd className="env-value">
        <span>{value}</span>
        {path && <span className="env-value-sub">{shortFolder(path, 29)}</span>}
      </dd>
    </div>
  );
}

function ContextBlock({ session, items, usage }: { session: Session; items: readonly SessionItem[]; usage: SessionContextUsage | null }) {
  const b = usage?.breakdown ?? null;
  // 没有分项时用每轮记下的总量（输入框下面那个）。
  const total = b ? { used: b.used, window: b.window, percent: Math.round(b.percent) } : sessionStats(items).context;
  const shown = b ? b.categories.filter((c) => c.kind !== "deferred" && c.tokens > 0) : [];
  const used = shown.filter((c) => c.kind === "used");
  const colorOf = new Map(used.map((c, i) => [c, categoryColor(c, i)]));
  const high = total?.percent != null && total.percent >= 80;
  return (
    <div className="env-block" data-testid="env-context">
      <h3 className="env-sub">上下文</h3>
      {total ? (
        <div className={`env-total${high ? " high" : ""}`} data-testid="env-context-total">
          <span>{total.percent != null ? `已用 ${total.percent}%` : `已用 ${formatTokens(total.used)}`}</span>
          {total.window ? (
            <span className="env-total-num">
              {formatTokens(total.used)} / {formatTokens(total.window)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="env-note">{session.runtime === "remote" ? "远程会话不显示上下文。" : "还没有回复过，发一条消息后再看。"}</div>
      )}
      {total?.percent != null && (
        <div className="env-bar" aria-hidden="true" data-testid="env-context-bar">
          {b && b.window > 0 ? used.map((c) => (
            <span key={c.id ?? c.name} style={{ width: `${(c.tokens / b.window) * 100}%`, background: colorOf.get(c) }} />
          )) : <span className={high ? "high" : ""} style={{ width: `${Math.min(100, (total.window ? total.used / total.window * 100 : total.percent))}%` }} />}
        </div>
      )}
      {shown.length > 0 && (
        <div className="env-cats" data-testid="env-categories">
          {shown.map((c) => (
            <div key={c.id ?? c.name} className={`env-cat env-cat-${c.kind}`} data-testid={`env-cat-${c.id ?? c.name}`}>
              <span className="env-dot" style={{ background: colorOf.get(c) }} />
              <span className="env-cat-name">{c.name}</span>
              <span className="env-cat-num">{formatTokens(c.tokens)}</span>
              <span className="env-cat-pct">{b && b.window ? `${((c.tokens / b.window) * 100).toFixed(1)}%` : ""}</span>
            </div>
          ))}
        </div>
      )}
      {b && b.memoryFiles.length > 0 && (
        <details className="env-files" data-testid="env-memory-files">
          <summary>说明文件 {b.memoryFiles.length} 个</summary>
          {b.memoryFiles.map((f) => (
            <div key={f.path} className="env-file" title={`${f.path}（${f.type}）`}>
              <span className="env-file-name">{baseName(f.path)}</span>
              <span className="env-cat-num">{formatTokens(f.tokens)}</span>
            </div>
          ))}
        </details>
      )}
      {usage?.unavailable && <div className="env-note" data-testid="env-context-note">{usage.unavailable}</div>}
      {b && !usage?.live && !usage?.unavailable && <div className="env-note">会话进程已退出，显示的是 {new Date(b.at).toLocaleTimeString()} 读到的。</div>}
    </div>
  );
}

function McpBlock({ link, session, refreshKey }: { link: HostLink; session: Session; refreshKey: SessionContextUsage | null }) {
  const { state, setState, refresh } = useSessionMcp(link, session);
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [note, setNote] = useState<{ name: string; text: string } | null>(null);
  // 上下文刷新了（一轮结束、点了刷新）就顺带再读一次连接状态。
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    refresh();
  }, [refreshKey, refresh]);
  // 重连（2026-11-18，Claude）：只让正在运行的进程重新连这一个，不改任何设置文件。
  const canReconnect = session.runtime === "claude" && !session.archivedAt;
  async function reconnect(name: string) {
    setReconnecting(name);
    setNote(null);
    try {
      const next = await call(link, "POST /api/sessions/:id/mcp/:name/reconnect", { id: session.id, name });
      setState(next);
      if (next.error) setNote({ name, text: `没连上：${next.error}` });
    } catch (err) {
      setNote({ name, text: err instanceof HostApiError ? err.message : String(err) });
    } finally {
      setReconnecting(null);
    }
  }
  const on = (state?.entries ?? []).filter((e) => e.on);
  return (
    <div className="env-block" data-testid="env-mcp">
      <h3 className="env-sub">MCP</h3>
      {!state && <div className="env-note">正在读取…</div>}
      {state && !on.length && <div className="env-note">仅启用 Studio 内置的 amo。</div>}
      {on.map((e) => (
        <div key={e.name} className="env-mcp-item">
          <div className="env-mcp" data-testid={`env-mcp-${e.name}`}>
            <span className="env-mcp-name" title={e.summary || e.name}>
              {e.name}
            </span>
            <McpStatus status={e.status} />
            {canReconnect && (e.status?.status === "failed" || e.status?.status === "needs-auth") && (
              <button type="button" className="link-btn env-reconnect" disabled={reconnecting !== null} title="让这个会话的进程重新连接它（不改设置）" onClick={() => void reconnect(e.name)} data-testid={`env-mcp-reconnect-${e.name}`}>
                {reconnecting === e.name ? "重连中…" : "重连"}
              </button>
            )}
          </div>
          {note?.name === e.name && <div className="env-note env-error">{note.text}</div>}
        </div>
      ))}
      {state && !state.live && session.runtime === "claude" && on.length > 0 && <div className="env-note">会话进程没开着，状态是上一次看到的。</div>}
    </div>
  );
}
