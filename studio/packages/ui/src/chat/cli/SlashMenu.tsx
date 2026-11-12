import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SLASH_GROUP_LABEL, type Session, type SlashCommand, type SlashCommandList } from "@amo-studio/protocol";
import { call, type HostLink } from "../../host/client.js";
import { commandAt, matchSlash, slashGroups } from "./slash.js";
import { viewFile, viewRemoteFile } from "../../files/FileLinks.js";
import { showToast } from "../../lib/toast.js";

// `/` lists commands and skills; `$` inserts a skill mention within a request. Both use the session's actual list.

const STALE_MS = 60_000;

export function useSlashCommands(input: {
  link: HostLink;
  session: Session | null;
  /** Before a first session exists, discover commands for the selected model and project. */
  draft?: { profileId: string; workspaceId: string | null };
  text: string;
  setText(next: string): void;
  onComplete?(caret: number): void;
  /** A command was picked that runs without arguments (or the person pressed Enter on it). */
  onRun?(command: SlashCommand, args: string): void;
}) {
  const { link, session, text, setText } = input;
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [list, setList] = useState<{ key: string; at: number; commands: SlashCommand[]; note?: string } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const typing = caret === null ? null : commandAt(text, caret);
  const sessionId = session?.id ?? null;
  const profileId = input.draft?.profileId;
  const workspaceId = input.draft?.workspaceId ?? null;
  const key = sessionId ?? (profileId ? JSON.stringify([profileId, workspaceId]) : null);
  const activeKey = useRef(key);
  activeKey.current = key;
  const tokenKey = typing ? JSON.stringify([text, typing.start, typing.end, typing.trigger]) : null;
  const query = key && typing && dismissed !== tokenKey ? typing.query : null;
  const fresh = !!list && list.key === key && Date.now() - list.at < STALE_MS;
  const loading = key !== null && loadingKey === key;

  const load = useCallback(async (): Promise<SlashCommand[]> => {
    if (!key) return [];
    setLoadingKey(key);
    try {
      const r: SlashCommandList = sessionId
        ? await call(link, "GET /api/sessions/:id/commands", { id: sessionId })
        : await call(link, "POST /api/commands", {}, { profileId: profileId!, workspaceId });
      if (activeKey.current === key) setList({ key, at: Date.now(), commands: r.commands, ...(r.note ? { note: r.note } : {}) });
      return r.commands;
    } catch {
      // Not again at once: the menu says so, and the next `/` after a minute asks again.
      if (activeKey.current === key) setList({ key, at: Date.now(), commands: [], note: "读不到命令列表" });
      return [];
    } finally {
      setLoadingKey((current) => current === key ? null : current);
    }
  }, [link, sessionId, key, profileId, workspaceId]);

  useEffect(() => {
    // A restored draft already containing a skill needs its list even when the caret is after the name.
    if ((query !== null || /(^|\s)\$[\w:.-]+/.test(text) || /^\s*\/[\w:.-]+/.test(text)) && !fresh && !loading) void load();
  }, [query, text, fresh, loading, load]);
  useEffect(() => {
    setDismissed(null);
    setHighlight(0);
  }, [key]);

  const commands = list?.key === key ? list.commands : [];
  const skills = useMemo(() => commands.filter((command) => command.group === "skill"), [commands]);
  const trigger = typing?.trigger ?? "/";
  const completionOnly = !sessionId || trigger === "$";
  const groups = useMemo(() => (query === null ? [] : slashGroups(trigger === "$" ? commands.filter((c) => c.group === "skill") : commands, query)), [commands, query, trigger]);
  const flat = groups.flatMap((g) => g.commands);
  const hl = Math.min(highlight, Math.max(flat.length - 1, 0));
  useEffect(() => setHighlight(0), [query, trigger, typing?.start]);

  /** Tab, or Enter on a command that needs arguments ("<…>"): complete the name and let the person type them. */
  const complete = (c: SlashCommand) => {
    if (!typing) return;
    const prefix = `${text.slice(0, typing.start)}${trigger}${c.name} `;
    const next = `${prefix}${text.slice(typing.end).replace(/^[ \t]+/, "")}`;
    setText(next);
    setCaret(prefix.length);
    input.onComplete?.(prefix.length);
  };
  const choose = (c: SlashCommand, how: "enter" | "tab" | "click") => {
    if (completionOnly || how === "tab" || (c.argumentHint?.trim().startsWith("<") && !c.local)) return complete(c);
    setText("");
    setCaret(null);
    input.onRun?.(c, "");
  };

  return {
    skills,
    openSkill(name: string) {
      const skill = skills.find((skill) => skill.name === name);
      if (!skill?.skillPath) { showToast({ text: "这个技能未提供文件位置，暂时无法打开。" }); return; }
      const target = { file: { path: skill.skillPath } };
      if (session?.runtime === "remote" && session.taskId) viewRemoteFile(target, session.taskId, sessionId);
      else viewFile(target, session?.workspaceId ?? workspaceId, sessionId);
    },
    trigger,
    completionOnly,
    open: query !== null && (flat.length > 0 || loading || (!!list && fresh)),
    loading: loading && !commands.length,
    note: list?.key === key ? list.note : undefined,
    groups,
    highlight: hl,
    choose,
    track: (el: { selectionStart: number | null }) => setCaret(el.selectionStart),
    /** The command a message runs, from the list as loaded (loading it first if it is not yet). */
    async match(message: string): Promise<{ command: SlashCommand; args: string } | null> {
      if (!message.trimStart().startsWith("/")) return null;
      const known = fresh ? commands : await load();
      return matchSlash(message.trimStart(), known);
    },
    onKeyDown(e: KeyboardEvent): boolean {
      if (query === null) return false;
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(tokenKey);
        return true;
      }
      if (!flat.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (Math.min(h, flat.length - 1) + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
        e.preventDefault();
        choose(flat[hl]!, e.key === "Tab" ? "tab" : "enter");
        return true;
      }
      return false;
    },
  };
}

export type SlashCommands = ReturnType<typeof useSlashCommands>;

/** The menu above the composer: grouped rows of name, what it takes, and what it does. */
export function SlashMenu({ slash, inline = false }: { slash: SlashCommands; inline?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  // Keep the highlighted row in view while moving with the keys.
  useLayoutEffect(() => {
    box.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [slash.highlight]);
  if (!slash.open) return null;
  let index = 0;
  return (
    <div className={`suggest slash-menu${inline ? " inline" : ""}`} role="listbox" aria-label={slash.trigger === "$" ? "技能" : "快捷指令和技能"} data-testid="slash-menu" ref={box}>
      {slash.loading && <div className="slash-empty">正在读取{slash.trigger === "$" ? "技能" : "命令和技能"}…</div>}
      {!slash.loading && !slash.groups.length && <div className="slash-empty">没有匹配的{slash.trigger === "$" ? "技能" : "命令或技能"}{slash.note ? `（${slash.note}）` : ""}</div>}
      {slash.groups.map((g) => (
        <Fragment key={g.group}>
          <div className="suggest-h">{SLASH_GROUP_LABEL[g.group]}</div>
          {g.commands.map((c) => {
            const i = index++;
            return (
              <button
                key={`${g.group}-${c.name}`}
                type="button"
                role="option"
                data-group={g.group}
                aria-selected={i === slash.highlight}
                className={i === slash.highlight ? "hl" : undefined}
                title={c.description}
                // mousedown keeps the focus (and caret) in the text field.
                onMouseDown={(e) => {
                  e.preventDefault();
                  slash.choose(c, "click");
                }}
              >
                <span className="slash-main">
                  <span className="slash-name">{slash.trigger}{c.name}</span>
                  {c.argumentHint && <span className="slash-args">{c.argumentHint}</span>}
                </span>
                <span className="slash-desc">{c.description}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
      <div className="slash-keys" aria-hidden="true">
        ↑↓ 选择 · 回车 {slash.completionOnly ? "插入" : "运行"} · Tab 补全 · Esc 关闭
      </div>
    </div>
  );
}
