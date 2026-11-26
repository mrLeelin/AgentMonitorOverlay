import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BotInput, Session, StateSnapshot, StudioBot, StudioSettings } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { IconChevronDown, IconChevronRight, IconEnvironment } from "../chat/icons.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { SettingActions, SettingField } from "../settings/SettingField.js";
import { BotCreation, type BotCreationEntry } from "./BotCreation.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotAvatarPicker, BotLocalFields, BotModelField, readBotMarkdown, type BotMarkdownField } from "./BotProfileFields.js";
import { BotWebhooks } from "./BotWebhooks.js";
import { botChatName, useBots } from "./roster.js";

type BotPreferences = Partial<Pick<StudioSettings, "botsEnabled" | "confirmBotHomeReset">>;

function BotPreference({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled: boolean; onChange(on: boolean): void }) {
  return <label className="bot-preference">
    <span><strong>{label}</strong><small className="settings-hint">{hint}</small></span>
    <input className="bot-setting-switch" type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

export function BotsPage({ link, state, settings, startBotId, onOpenChat }: { link: HostLink; state: StateSnapshot; settings: StudioSettings | null; startBotId?: string; onOpenChat?(session: Session): void }) {
  const bots = useBots(link);
  const [deviceOpen, setDeviceOpen] = useState(true);
  const [editingId, edit] = useState(startBotId);
  const editing = bots.find((bot) => bot.id === editingId);
  const editor = useRef<HTMLDivElement>(null);
  const [creation, setCreation] = useState<BotCreationEntry>();
  const [saving, setSaving] = useState<BotPreferences>();
  const [settingError, setSettingError] = useState("");
  const enabled = (saving?.botsEnabled ?? settings?.botsEnabled) !== false;
  const confirmReset = (saving?.confirmBotHomeReset ?? settings?.confirmBotHomeReset) !== false;

  useEffect(() => {
    if (startBotId && editing?.id === startBotId) editor.current?.scrollIntoView({ block: "start" });
  }, [startBotId, editing?.id]);

  async function savePreference(change: BotPreferences) {
    setSaving(change);
    setSettingError("");
    try { await call(link, "PUT /api/settings", {}, change); }
    catch (err) { setSettingError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(undefined); }
  }

  return <div className="bots-settings" data-testid="studio-bots-settings">
    <div className="bot-preferences">
      <BotPreference label="启用 Bots" hint="在本机显示 Bots，接收新消息并运行值守和 Webhook。" checked={enabled} disabled={!!saving || !settings} onChange={(value) => void savePreference({ botsEnabled: value })} />
      <BotPreference label="开始新的主聊天前询问" hint="新建主聊天会切换默认对话，旧聊天仍可在历史中打开。" checked={confirmReset} disabled={!!saving || !settings} onChange={(value) => void savePreference({ confirmBotHomeReset: value })} />
      {settingError && <p className="form-error" role="alert">{settingError}</p>}
    </div>
    <section className="bot-settings-device" aria-label="本地 Windows">
      <button className="bot-device-toggle" type="button" aria-expanded={deviceOpen} aria-controls="bot-settings-list" onClick={() => setDeviceOpen(!deviceOpen)}>
        <IconEnvironment /><strong>本地 Windows</strong><small>{bots.length} 个 Bot</small>{deviceOpen ? <IconChevronDown /> : <IconChevronRight />}
      </button>
      {deviceOpen && <div id="bot-settings-list" className="bot-settings-list">
        <div className="bot-settings-roster">
          {bots.map((bot) => <button key={bot.id} type="button" className="bot-settings-bot" aria-pressed={bot.id === editingId} aria-label={bot.name} onClick={() => edit(bot.id === editingId ? undefined : bot.id)}>
            <BotAvatar name={bot.name} avatar={bot.avatar} size={32} />
            <span><strong>{bot.name}</strong><small>{state.profiles.find((profile) => profile.id === bot.profileId)?.label ?? "Codex"} · {bot.enabled ? "已启用" : "已停用"}</small></span>
            <IconChevronRight />
          </button>)}
          {!bots.length && <p className="settings-hint">还没有 Bot。</p>}
        </div>
        <div className="settings-row">
          <button type="button" className="btn-ghost small" disabled={!enabled} onClick={() => setCreation("blank")}>＋ 新建 Bot</button>
          <button type="button" className="btn-ghost small" disabled={!enabled} onClick={() => setCreation("templates")}>浏览模板</button>
          <button type="button" className="link-btn" disabled={!enabled} onClick={() => setCreation("link")}>从链接创建</button>
        </div>
      </div>}
    </section>
    {editing && deviceOpen && <div ref={editor}><BotSettingsEditor key={editing.id} bot={editing} link={link} state={state} enabled={enabled} confirmReset={confirmReset} onOpenChat={onOpenChat} /></div>}
    {creation && <BotCreation entry={creation} link={link} bots={bots} profiles={state.profiles} workspaces={state.workspaces}
      onClose={() => setCreation(undefined)} onBot={(bot) => { setCreation(undefined); setDeviceOpen(true); edit(bot.id); }} />}
  </div>;
}

function BotSettingsEditor({ bot: selected, link, state, enabled, confirmReset, onOpenChat }: {
  bot: StudioBot; link: HostLink; state: StateSnapshot; enabled: boolean; confirmReset: boolean; onOpenChat?(session: Session): void;
}) {
  const { id } = selected;
  const [draft, setDraft] = useState<BotInput>(selected);
  const [chats, setChats] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const change = <K extends keyof BotInput>(field: K, value: BotInput[K]) => setDraft((old) => ({ ...old, [field]: value }));

  useEffect(() => {
    let active = true;
    void call(link, "GET /api/bots/:id/chats", { id }).then((rows) => { if (active) setChats(rows); }).catch(() => {});
    return () => { active = false; };
  }, [id, link, selected.homeSessionId]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try { await action(); }
    catch (err) { setNotice({ text: err instanceof Error ? err.message : String(err), error: true }); }
    finally { setBusy(false); }
  }

  async function openHome(reset: boolean) {
    await perform(async () => {
      const home = await call(link, "POST /api/bots/:id/home", { id }, { reset });
      setAskReset(false);
      onOpenChat?.(home);
    });
  }

  function importButton(field: BotMarkdownField, label: string): ReactNode {
    return <label className="btn-ghost small bot-import">{label}<input type="file" accept=".md,.txt,text/plain,text/markdown" aria-label={label} disabled={busy} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (file) void perform(async () => change(field, await readBotMarkdown(field, file)));
    }} /></label>;
  }

  const feedback = notice && <p className={notice.error ? "form-error" : "settings-feedback"} role={notice.error ? "alert" : "status"}>{notice.text}</p>;
  return <div className="bot-settings-editor">
    <form className="settings-section" aria-label={`配置 ${selected.name}`} onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        setDraft(await call(link, "PUT /api/bots/:id", { id }, draft));
        setNotice({ text: "已保存。" });
      });
    }}>
      <h3 className="settings-heading">{selected.name}</h3>
      <SettingField label="头像"><BotAvatarPicker draft={draft} busy={busy} change={change} run={perform} /></SettingField>
      <label className="bot-form-field">名称<input className="field" required maxLength={40} value={draft.name} disabled={busy} onChange={(event) => change("name", event.target.value)} /></label>
      <BotModelField link={link} profiles={state.profiles} draft={draft} change={change} disabled={busy} />
      <small className="settings-hint">保存后，新建聊天使用所选模型、推理强度和权限。{selected.homeSessionId && "要在主聊天中使用新设置，请点「新建主聊天」。"}</small>
      <BotLocalFields workspaces={state.workspaces} draft={draft} change={change} disabled={busy} />
      <SettingField label="职责" htmlFor="studio-bot-purpose"><textarea id="studio-bot-purpose" className="field" rows={3} required maxLength={8000} value={draft.purpose} disabled={busy} onChange={(event) => change("purpose", event.target.value)} />{importButton("purpose", "导入 SOUL.md")}</SettingField>
      <SettingField label="记忆" htmlFor="studio-bot-memory" hint="支持 Markdown。新聊天会读取保存的记忆。">
        <textarea id="studio-bot-memory" className="field" rows={3} maxLength={32_000} value={draft.memory} disabled={busy} onChange={(event) => change("memory", event.target.value)} />
        {importButton("memory", "导入 MEMORY.md")}
      </SettingField>
      <SettingField label="启用" htmlFor="studio-bot-enabled"><label><input id="studio-bot-enabled" type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => change("enabled", event.target.checked)} /> 接收消息并出现在 @ 列表</label></SettingField>
      <SettingActions below={!askReset && feedback}>
        <button type="submit" className="btn-primary small" disabled={busy || !draft.name.trim() || !draft.purpose.trim() || !draft.profileId}>保存</button>
        {enabled && selected.enabled && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void openHome(false)}>打开主聊天</button>}
        {enabled && selected.enabled && !!selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => {
          if (confirmReset) { setNotice(undefined); setAskReset(true); }
          else void openHome(true);
        }}>新建主聊天</button>}
      </SettingActions>
    </form>
    {askReset && <ConfirmDialog title="新建主聊天" action="新建" busy={busy} onCancel={() => setAskReset(false)} onConfirm={() => void openHome(true)}>
      <p>接下来的主聊天消息会进入新对话。旧聊天和记忆会保留。</p>
      {feedback}
    </ConfirmDialog>}
    {!!chats.length && <section className="settings-section"><h3 className="settings-heading">聊天记录</h3>
      {chats.map((chat) => <div className="settings-row" key={chat.id}>
        <button type="button" className="btn-ghost small bot-history-row" onClick={() => onOpenChat?.(chat)}>{botChatName(chat, selected.homeSessionId)}{chat.archivedAt ? "（已归档）" : ""} ↗</button>
        {chat.id !== selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void perform(async () => {
          const route = chat.archivedAt ? "POST /api/sessions/:id/unarchive" : "POST /api/sessions/:id/archive";
          await call(link, route, { id: chat.id });
          setChats(await call(link, "GET /api/bots/:id/chats", { id }));
        })}>{chat.archivedAt ? "恢复" : "归档"}</button>}
      </div>)}
    </section>}
    <BotWebhooks link={link} id={id} />
  </div>;
}
