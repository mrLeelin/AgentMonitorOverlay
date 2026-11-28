import { useEffect, useRef, useState } from "react";
import type { Session, StudioBot } from "@amo-studio/protocol";
import { IconArrowUp } from "../chat/icons.js";
import { chatEnterAction, useEnterMode, useNewlineShortcut } from "../chat/inputPrefs.js";
import { call, type HostLink } from "../host/client.js";
import { readStored, readStoredJson, writeStored, writeStoredJson } from "../lib/stored.js";
import { BotAvatar } from "./BotAvatar.js";
import "./BotWorkspaceChat.css";

interface SendAttempt { id: string; text: string }
const draftSent = "amo:bot-draft-sent";

export function BotChatEmpty({ bot }: { bot: StudioBot }) {
  return <div className="bot-chat-empty" data-testid="bot-chat-empty">
    <BotAvatar name={bot.name} avatar={bot.avatar} size={48} />
    <h3>开始与 {bot.name} 聊天</h3>
    {bot.purpose && <p>{bot.purpose}</p>}
  </div>;
}

export function BotWorkspaceChat({ link, bot, onOpen, online = true, initialText = "" }: {
  link: HostLink; bot: StudioBot; onOpen(session: Session): void; online?: boolean; initialText?: string;
}) {
  const scope = JSON.stringify([bot.id, initialText]);
  const draftKey = `amo.botChat.draft.${scope}`;
  const attemptKey = `amo.botChat.send.${scope}`;
  const [text, setText] = useState(() => readStored(draftKey) ?? initialText);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const active = useRef(false);
  const inFlight = useRef(false);
  const currentAttempt = useRef<SendAttempt>(null);
  const [enterMode] = useEnterMode();
  const [newline] = useNewlineShortcut();
  const blocked = !bot.enabled ? "这个 Bot 已暂停" : !online ? "Host 已断开连接" : "";

  useEffect(() => {
    active.current = true;
    const clearDraft = (event: Event) => {
      const sent = (event as CustomEvent<{ key: string; text: string }>).detail;
      if (sent.key === draftKey) setText((current) => current === sent.text ? "" : current);
    };
    window.addEventListener(draftSent, clearDraft);
    field.current?.focus();
    return () => {
      active.current = false;
      window.removeEventListener(draftSent, clearDraft);
    };
  }, [draftKey]);

  async function send() {
    const content = text.trim();
    if (!content || blocked || inFlight.current) return;
    const saved = currentAttempt.current ?? (readStoredJson(attemptKey) as Partial<SendAttempt> | undefined);
    const attempt = saved?.text === content && typeof saved.id === "string"
      ? { id: saved.id, text: content } : { id: crypto.randomUUID(), text: content };
    currentAttempt.current = attempt;
    writeStoredJson(attemptKey, attempt);
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      const session = await call(link, "POST /api/bots/:id/chat", { id: bot.id }, attempt);
      if ((readStored(draftKey) ?? initialText) === text) {
        writeStored(draftKey, null);
        window.dispatchEvent(new CustomEvent(draftSent, { detail: { key: draftKey, text } }));
      }
      currentAttempt.current = null;
      if ((readStoredJson(attemptKey) as Partial<SendAttempt> | undefined)?.id === attempt.id) writeStored(attemptKey, null);
      if (active.current) onOpen(session);
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      if (active.current) {
        setSending(false);
        requestAnimationFrame(() => field.current?.focus());
      }
    }
  }

  return <section className="bot-chat-start" aria-label={`${bot.name}的新聊天`}>
    <div className="bot-chat-start-content"><BotChatEmpty bot={bot} /></div>
    <form className="bot-chat-start-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="composer-card bot-chat-start-composer">
        <textarea ref={field} aria-label="聊天消息" placeholder={blocked || `给 ${bot.name} 发消息`} rows={2} maxLength={20_000}
          disabled={sending || !!blocked} value={text} onChange={(event) => {
            setText(event.target.value);
            writeStored(draftKey, event.target.value === initialText ? null : event.target.value);
          }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !chatEnterAction(event, enterMode, newline, text.includes("\n"))) return;
            event.preventDefault();
            void send();
          }} />
        <div className="bot-chat-start-tools">
          <button type="submit" className="btn-primary bot-chat-start-send" aria-label="发送消息" title="发送消息"
            disabled={sending || !!blocked || !text.trim()}><IconArrowUp /></button>
        </div>
      </div>
    </form>
  </section>;
}
