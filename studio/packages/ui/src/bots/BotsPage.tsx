import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DEFAULT_BOT_PREFERENCES, type BotInput, type BotSkillRef, type Session, type StateSnapshot, type StudioBot, type StudioSettings } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { IconCheck, IconChevronDown, IconChevronRight, IconEnvironment, IconPlus } from "../chat/icons.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { BotCreation, type BotCreationEntry } from "./BotCreation.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotAvatarPicker, BotLocalFields, BotModelField, readBotMarkdown, type BotMarkdownField } from "./BotProfileFields.js";
import { BotWebhooks } from "./BotWebhooks.js";
import { BotSharedSkills, BotSkillsSection } from "./BotSkills.js";
import { botChatName, useBots } from "./roster.js";
import { OPEN_SETTINGS_EVENT } from "../mcp/shared.js";
import { BotEntityDialog } from "./BotEntityDialog.js";
import { BotAutomation, BotMemoryFiles, BotNotificationSettings, BotSettingsOverview, botSettingsTabs, type BotMemoryPage, type BotSettingsTab } from "./BotSettingsSections.js";

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
  const suspendedDrafts = useRef(new Map<string, BotInput>());
  const sharedHeading = useRef<HTMLHeadingElement>(null);
  const focusShared = useRef(false);
  const [shared, setShared] = useState<BotSkillRef[]>();
  const [sharedError, setSharedError] = useState("");
  const [sharedRevision, reloadShared] = useState(0);
  const narrowBack = useRef<HTMLButtonElement>(null);
  const deviceToggle = useRef<HTMLButtonElement>(null);
  const roster = useRef<HTMLDivElement>(null);
  const rosterReturn = useRef<HTMLButtonElement | null>(null);
  const [creation, setCreation] = useState<BotCreationEntry>();
  const [saving, setSaving] = useState<BotPreferences>();
  const [settingError, setSettingError] = useState("");
  const enabled = (saving?.botsEnabled ?? settings?.botsEnabled) !== false;
  const confirmReset = (saving?.confirmBotHomeReset ?? settings?.confirmBotHomeReset) !== false;

  useEffect(() => {
    let current = true;
    void call(link, "GET /api/bot-skills/shared").then(
      (skills) => { if (current) { setShared(skills); setSharedError(""); } },
      (error: unknown) => { if (current) setSharedError(error instanceof Error ? error.message : String(error)); },
    );
    return () => { current = false; };
  }, [link, bots, sharedRevision]);

  useLayoutEffect(() => {
    if (!editing?.id && focusShared.current) {
      focusShared.current = false;
      sharedHeading.current?.focus();
      sharedHeading.current?.scrollIntoView({ block: "nearest" });
    }
    if (editing?.id && narrowBack.current?.offsetWidth) narrowBack.current.focus();
    if (!editing?.id && rosterReturn.current) {
      (rosterReturn.current?.offsetWidth ? rosterReturn.current : deviceToggle.current)?.focus();
      rosterReturn.current = null;
    }
  }, [editing?.id]);

  async function savePreference(change: BotPreferences) {
    setSaving(change);
    setSettingError("");
    try { await call(link, "PUT /api/settings", {}, change); }
    catch (err) { setSettingError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(undefined); }
  }

  return <div className="bots-settings" data-testid="studio-bots-settings" data-editing={!!editing}>
    <div className="bot-settings-rail" role="group" aria-label="Bot 列表">
      <div className="bot-settings-create">
        <button type="button" className="btn-primary" disabled={!enabled} onClick={() => setCreation("blank")}><IconPlus /> 新建 Bot</button>
        <div className="bot-settings-create-links">
          <button type="button" className="link-btn" disabled={!enabled} onClick={() => setCreation("templates")}>浏览模板</button>
          <button type="button" className="link-btn" disabled={!enabled} onClick={() => setCreation("link")}>从链接创建</button>
        </div>
      </div>
      <div className="bot-settings-directory">
        <button ref={deviceToggle} className="bot-device-toggle" type="button" aria-expanded={deviceOpen} aria-controls="bot-settings-list" onClick={() => setDeviceOpen(!deviceOpen)}>
          <IconEnvironment /><strong>本地 Windows</strong><small>{bots.length}</small>{deviceOpen ? <IconChevronDown /> : <IconChevronRight />}
        </button>
        <div ref={roster} id="bot-settings-list" className="bot-settings-roster" hidden={!deviceOpen}>
          {bots.map((bot) => {
            const profile = state.profiles.find((profile) => profile.id === bot.profileId)?.label ?? "Codex";
            const status = bot.enabled ? "已启用" : "已停用";
            const selected = bot.id === editingId;
            return <button key={bot.id} type="button" className="bot-settings-bot" aria-pressed={selected} aria-label={bot.name} aria-description={`${profile}，${status}`} title={`${bot.name} · ${profile} · ${status}`} onClick={() => edit(selected ? undefined : bot.id)}>
              <BotAvatar name={bot.name} avatar={bot.avatar} size={30} />
              <span><strong>{bot.name}</strong><small><span>{profile}</span><span>· {status}</span></small></span>
              {selected && <IconCheck />}
            </button>;
          })}
          {!bots.length && <p className="settings-hint">还没有 Bot。可以新建或浏览模板。</p>}
        </div>
      </div>
      <button type="button" className="bot-settings-general" aria-pressed={!editing} onClick={() => edit(undefined)}>通用设置</button>
    </div>
    {editing ? <div className="bot-editor-pane">
      <button ref={narrowBack} type="button" className="bot-editor-back link-btn" onClick={() => {
        rosterReturn.current = roster.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]') ?? deviceToggle.current;
        edit(undefined);
      }}><IconChevronRight /> 返回 Bot 列表</button>
      <BotSettingsEditor key={editing.id} bot={editing} initial={suspendedDrafts.current.get(editing.id)} link={link} state={state} enabled={enabled} confirmReset={confirmReset} shared={shared} onOpenChat={onOpenChat}
        onSave={() => suspendedDrafts.current.delete(editing.id)} onDelete={() => { suspendedDrafts.current.delete(editing.id); edit(undefined); }}
        onManage={(draft) => { suspendedDrafts.current.set(editing.id, draft); focusShared.current = true; edit(undefined); }} />
    </div> : <section className="bot-preferences" aria-labelledby="bot-preferences-title">
      <h3 id="bot-preferences-title">通用设置</h3>
      <BotPreference label="启用 Bots" hint="在本机显示 Bots，接收新消息并运行值守和 Webhook。" checked={enabled} disabled={!!saving || !settings} onChange={(value) => void savePreference({ botsEnabled: value })} />
      <BotPreference label="开始新的主聊天前询问" hint="新建主聊天会切换默认对话，旧聊天仍可在历史中打开。" checked={confirmReset} disabled={!!saving || !settings} onChange={(value) => void savePreference({ confirmBotHomeReset: value })} />
      {settingError && <p className="form-error" role="alert">{settingError}</p>}
      <BotSharedSkills link={link} shared={shared} error={sharedError} retry={() => reloadShared((n) => n + 1)} onSave={setShared} heading={sharedHeading} />
    </section>}
    {creation && <BotCreation entry={creation} link={link} bots={bots} profiles={state.profiles} workspaces={state.workspaces}
      onClose={() => setCreation(undefined)} onBot={(bot) => { setCreation(undefined); setDeviceOpen(true); edit(bot.id); }} />}
  </div>;
}

function BotSettingsEditor({ bot: selected, initial, link, state, enabled, confirmReset, shared, onOpenChat, onSave, onDelete, onManage }: {
  bot: StudioBot; initial?: BotInput; link: HostLink; state: StateSnapshot; enabled: boolean; confirmReset: boolean; shared?: BotSkillRef[];
  onOpenChat?(session: Session): void; onSave(): void; onDelete(): void; onManage(draft: BotInput): void;
}) {
  const { id } = selected;
  const formId = useId();
  const [draft, setDraft] = useState<BotInput>(initial ?? selected);
  const [expectedFiles, setExpectedFiles] = useState({ purpose: selected.purpose, memory: selected.memory });
  const [section, setSection] = useState<BotSettingsTab>(initial ? "access" : "overview");
  const [memoryPage, setMemoryPage] = useState<BotMemoryPage>("memory");
  const [askDelete, setAskDelete] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const [chats, setChats] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const change = <K extends keyof BotInput>(field: K, value: BotInput[K]) => setDraft((old) => ({ ...old, [field]: value }));
  const preferences = draft.preferences ?? DEFAULT_BOT_PREFERENCES;

  function openSection(tab: BotSettingsTab, file?: BotMemoryPage) {
    if (file) setMemoryPage(file);
    setSection(tab);
    scroll.current?.scrollTo({ top: 0 });
  }

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
  return <div className="bot-settings-editor bot-settings-sections">
    <header className="bot-editor-heading">
      <h3 title={selected.name}>{selected.name}</h3>
      <label className="bot-editor-enabled" title="接收消息并出现在 @ 列表">
        <input form={formId} type="checkbox" className="bot-setting-switch" role="switch" aria-description="启用后出现在 @ 列表" checked={draft.enabled} disabled={busy} onChange={(event) => change("enabled", event.target.checked)} /> 接收消息
      </label>
    </header>
    <nav className="bot-settings-tabs" aria-label="Bot 设置分区">
      {botSettingsTabs.map(([key, label]) => <button key={key} type="button" aria-current={section === key ? "page" : undefined} onClick={() => openSection(key)}>{label}</button>)}
    </nav>
    <div className="bot-editor-scroll" ref={scroll}>
      <form id={formId} className="bot-editor-form" aria-label={`配置 ${selected.name}`} onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          const saved = await call(link, "PUT /api/bots/:id", { id }, { ...draft, expectedFiles });
          setDraft(saved);
          setExpectedFiles({ purpose: saved.purpose, memory: saved.memory });
          onSave();
          setNotice({ text: "已保存。" });
        });
      }}>
        {section === "overview" && <BotSettingsOverview bot={selected} draft={draft} state={state} shared={shared} chats={chats} open={openSection} />}
        <div className="bot-settings-details" hidden={section !== "runtime"}><div className="bot-editor-identity">
          <BotAvatarPicker draft={draft} busy={busy} change={change} run={perform} />
          <label className="bot-form-field">名称<input className="field" required maxLength={40} value={draft.name} disabled={busy} onChange={(event) => change("name", event.target.value)} /></label>
        </div>
        <section className="bot-editor-section" aria-labelledby="bot-editor-runtime-title">
          <h4 id="bot-editor-runtime-title">运行配置</h4>
          <div className="bot-editor-runtime">
            <BotModelField link={link} profiles={state.profiles} draft={draft} change={change} disabled={busy} />
            <small className="settings-hint">保存后，新建聊天使用所选模型、推理强度和权限。{selected.homeSessionId && "要在主聊天中使用新设置，请点「新建主聊天」。"}</small>
            <BotLocalFields workspaces={state.workspaces} draft={draft} change={change} disabled={busy} />
          </div>
        </section>
        <button className="link-btn bot-settings-delete" type="button" disabled={busy} onClick={() => setAskDelete(true)}>删除 Bot…</button>
        </div>
        <div className="bot-settings-details" hidden={section !== "access"}>
          <section className="bot-settings-card"><h4>访问权限</h4>
            <BotPreference label="允许同群 Bot 提问" hint="仅在你明确要求群成员转问时接收。" checked={preferences.allowGroupAsk} disabled={busy}
              onChange={(allowGroupAsk) => change("preferences", { ...preferences, allowGroupAsk })} />
          </section>
          <BotSkillsSection link={link} name={draft.name} profileId={draft.profileId} workspaceId={draft.workspaceId} shared={shared} skills={draft.skills}
            busy={busy} onChange={(skills) => change("skills", skills)} onManage={() => onManage(draft)} />
        </div>
        <div hidden={section !== "memory"}><BotMemoryFiles link={link} botId={id} active={section === "memory"} file={memoryPage} select={setMemoryPage}
          purpose={<div className="bot-form-field">
            <div className="bot-settings-file-title"><label htmlFor="studio-bot-purpose"><code>SOUL.md</code></label>{importButton("purpose", "导入 SOUL.md")}</div>
            <textarea aria-label="职责" id="studio-bot-purpose" className="field" rows={3} required maxLength={8000} value={draft.purpose} disabled={busy} onChange={(event) => change("purpose", event.target.value)} />
          </div>}
          memory={<div className="bot-form-field">
            <div className="bot-settings-file-title"><label htmlFor="studio-bot-memory"><code>MEMORY.md</code></label>{importButton("memory", "导入 MEMORY.md")}</div>
            <textarea aria-label="记忆" id="studio-bot-memory" className="field" rows={3} maxLength={32_000} value={draft.memory} disabled={busy} aria-describedby="studio-bot-memory-hint" onChange={(event) => change("memory", event.target.value)} />
            <small className="settings-hint" id="studio-bot-memory-hint">支持 Markdown。新聊天会读取保存的记忆。</small>
          </div>} /></div>
      </form>
      <div hidden={section !== "automation"}><BotAutomation bot={selected} link={link} preferences={preferences} disabled={busy}
        onChange={(value) => change("preferences", value)} onManage={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "duty" }))} /></div>
      {section === "notifications" && <BotNotificationSettings preferences={preferences} disabled={busy} onChange={(value) => change("preferences", value)} />}
      {section === "runtime" && !!chats.length && <section className="settings-section"><h4 className="settings-heading">聊天记录</h4>
        {chats.map((chat) => <div className="settings-row" key={chat.id}>
          <button type="button" className="btn-ghost small bot-history-row" onClick={() => onOpenChat?.(chat)}>{botChatName(chat, selected.homeSessionId)}{chat.archivedAt ? "（已归档）" : ""} ↗</button>
          {chat.id !== selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void perform(async () => {
            const route = chat.archivedAt ? "POST /api/sessions/:id/unarchive" : "POST /api/sessions/:id/archive";
            await call(link, route, { id: chat.id });
            setChats(await call(link, "GET /api/bots/:id/chats", { id }));
          })}>{chat.archivedAt ? "恢复" : "归档"}</button>}
        </div>)}
      </section>}
      {section === "access" && <BotWebhooks link={link} id={id} />}
    </div>
    <footer className="bot-editor-actions">
      {!askReset && feedback}
      <div className="settings-row">
        {enabled && selected.enabled && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void openHome(false)}>打开主聊天</button>}
        {enabled && selected.enabled && !!selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => {
          if (confirmReset) { setNotice(undefined); setAskReset(true); }
          else void openHome(true);
        }}>新建主聊天</button>}
        <button type="submit" form={formId} className="btn-primary small bot-editor-save" disabled={busy || !draft.name.trim() || !draft.purpose.trim() || !draft.profileId}>保存</button>
      </div>
    </footer>
    {askReset && <ConfirmDialog title="新建主聊天" action="新建" busy={busy} onCancel={() => setAskReset(false)} onConfirm={() => void openHome(true)}>
      <p>接下来的主聊天消息会进入新对话。旧聊天和记忆会保留。</p>
      {feedback}
    </ConfirmDialog>}
    {askDelete && <BotEntityDialog link={link} bots={[]} edit={{ action: "delete", entity: { kind: "bot", item: selected } }} onClose={() => setAskDelete(false)} onDeleted={onDelete} />}
  </div>;
}
