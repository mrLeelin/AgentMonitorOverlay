import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import type { StudioBot } from "@amo-studio/protocol";
import { ResourceInput, type ResourceInputHandle } from "../attach/ResourceInput.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import { IconArrowUp, IconCheck, IconChevronDown, IconPeople } from "../chat/icons.js";
import { chatEnterAction, useEnterMode, useNewlineShortcut } from "../chat/inputPrefs.js";
import type { HostLink } from "../host/client.js";
import { ContextMenu } from "../lib/ContextMenu.js";
import { readStored, readStoredJson, writeStored, writeStoredJson } from "../lib/stored.js";
import { BotAvatar } from "./BotAvatar.js";
import { EVERYONE, groupReplyTargets, type GroupReplyChoice } from "./groupRouting.js";

type Attempt = { key: string; id: string };
const NO_OPTIONS: readonly never[] = [];

function ReplyMenu({ trigger, members, choice, onPick, onClose }: { trigger: HTMLButtonElement; members: readonly StudioBot[]; choice: GroupReplyChoice; onPick(choice: GroupReplyChoice): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const bounds = trigger.getBoundingClientRect();
  useLayoutEffect(() => {
    const menu = box.current;
    if (menu) setHeight(menu.offsetHeight);
  }, [members.length]);
  useLayoutEffect(() => box.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus(), []);
  function item(value: GroupReplyChoice, label: string, member?: StudioBot) {
    return <button key={value} type="button" role="menuitemradio" aria-checked={choice === value} onClick={() => { onPick(value); onClose(); }}>
      {member ? <BotAvatar name={member.name} avatar={member.avatar} size={21} /> : <IconPeople />}
      <span>{label}</span>{choice === value && <IconCheck />}
    </button>;
  }
  return createPortal(<ContextMenu label="谁来回复" trigger={trigger} at={{ x: bounds.left, y: bounds.top - height - 6 }} className="bot-group-reply-menu" boxRef={box} onClose={onClose} onKeyDown={(event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }}>
    <div className="bot-menu-title">谁来回复你的消息</div>
    {members.map((bot) => item(`bot:${bot.id}`, bot.name, bot))}
    {!!members.length && <hr className="menu-rule" />}
    {item("all", "所有 Bots")}
    {item("mentions", "仅在被提及时")}
  </ContextMenu>, document.body);
}

export interface BotGroupComposerHandle {
  replyTo(bot: StudioBot): void;
}

export function BotGroupComposer({ ref, link, groupId, members, onSend }: {
  ref: Ref<BotGroupComposerHandle>; link: HostLink; groupId: string; members: readonly StudioBot[];
  onSend(payload: { id: string; text: string; targetIds: string[] }): Promise<void>;
}) {
  const draftKey = `amo.botGroup.draft.${groupId}`;
  const modeKey = `amo.botGroup.reply.${groupId}`;
  const attemptKey = `amo.botGroup.send.${groupId}`;
  const [text, setText] = useState(() => readStored(draftKey) ?? "");
  const [mode, setMode] = useState(() => readStored(modeKey));
  const [menu, setMenu] = useState<HTMLButtonElement>();
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const input = useRef<ResourceInputHandle>(null);
  const enabled = members.filter((bot) => bot.enabled);
  const selected = enabled.find((bot) => mode ? mode === `bot:${bot.id}` : bot.id === enabled[0]?.id);
  const choice: GroupReplyChoice = selected ? `bot:${selected.id}` : mode === "all" ? "all" : "mentions";
  const choiceLabel = selected?.name ?? (choice === "all" ? "所有 Bots" : "仅在被提及时");
  const [enterMode] = useEnterMode();
  const [newline] = useNewlineShortcut();

  function draft(next: string) {
    const value = next.slice(0, 20_000);
    setText(value);
    writeStored(draftKey, value || null);
  }

  function choose(value: GroupReplyChoice) {
    setMode(value);
    writeStored(modeKey, value);
  }

  const mentions = useComposerMentions({
    link, text, setText: draft, bots: [...enabled.filter((bot) => bot.name.normalize("NFKC").toLowerCase() !== EVERYONE), { id: EVERYONE, name: EVERYONE, purpose: "提及所有已启用成员" }],
    tasks: NO_OPTIONS, sessions: NO_OPTIONS, current: null, workspaceId: null, templates: false, onFile: () => {}, onFind: () => {},
  });

  function insertMention(name: string) {
    const field = input.current;
    if (!field || sending) return;
    const at = field.selectionStart;
    const space = at > 0 && !/\s/u.test(field.value[at - 1]!) ? " " : "";
    field.focus();
    field.insert(`${space}@${name}${name ? " " : ""}`);
    mentions.track(field);
  }

  useImperativeHandle(ref, () => ({ replyTo(bot) {
    if (bot.enabled) {
      choose(`bot:${bot.id}`);
      if (bot.name.normalize("NFKC").toLowerCase() === EVERYONE) input.current?.focus();
      else insertMention(bot.name);
    }
  } }));
  useEffect(() => { input.current?.focus(); }, []);

  async function submit() {
    const content = text.trim();
    if (!content || inFlight.current) return;
    const targetIds = groupReplyTargets(content, members, choice);
    const key = JSON.stringify([content, [...targetIds].sort()]);
    const saved = readStoredJson(attemptKey) as Partial<Attempt> | null;
    const attempt = saved?.key === key && typeof saved.id === "string" ? { key, id: saved.id } : { key, id: crypto.randomUUID() };
    writeStoredJson(attemptKey, attempt);
    inFlight.current = true;
    setSending(true);
    setError("");
    mentions.track({ selectionStart: null });
    try {
      await onSend({ id: attempt.id, text: content, targetIds });
      const savedDraft = readStored(draftKey);
      if (savedDraft === null || savedDraft === text) draft("");
      const currentAttempt = readStoredJson(attemptKey) as Partial<Attempt> | null;
      if (currentAttempt?.id === attempt.id) writeStored(attemptKey, null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setSending(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  return <form className="bot-group-compose-wrap" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="composer-card bot-group-composer">
      <ResourceInput ref={input} value={text} resources={NO_OPTIONS} mentions={mentions.names} disabled={sending}
        aria-label="群组消息" placeholder="给群组发消息，输入 @ 可选成员" rows={2} onChange={draft} onSelect={mentions.track}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || mentions.onKeyDown(event)) return;
          if (!chatEnterAction(event, enterMode, newline, text.includes("\n"))) return;
          event.preventDefault();
          void submit();
        }} />
      <MentionList mentions={mentions} />
      <div className="bot-group-composer-tools">
        <button className="bot-icon-button bot-group-at" type="button" aria-label="提及" title="提及成员" disabled={sending} onClick={() => insertMention("")}>@</button>
        <button type="button" className="bot-group-reply-trigger" aria-label={`回复对象：${choiceLabel}`} aria-haspopup="menu" aria-expanded={!!menu} disabled={sending}
          onClick={(event) => { mentions.track({ selectionStart: null }); setMenu(menu ? undefined : event.currentTarget); }}>
          <span>回复</span>{selected && <BotAvatar name={selected.name} avatar={selected.avatar} size={17} />}<span className="bot-group-recipient">{choiceLabel}</span><IconChevronDown />
        </button>
        <button type="submit" className="btn-primary bot-group-send" aria-label="发送群组消息" title="发送群组消息" disabled={sending || !text.trim()}><IconArrowUp /></button>
      </div>
    </div>
    {menu && <ReplyMenu trigger={menu} members={enabled} choice={choice} onPick={(value) => { choose(value); requestAnimationFrame(() => input.current?.focus()); }} onClose={() => { setMenu(undefined); menu.focus({ preventScroll: true }); }} />}
  </form>;
}
