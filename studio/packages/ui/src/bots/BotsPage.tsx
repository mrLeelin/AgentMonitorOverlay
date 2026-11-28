import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode } from "react";
import { DEFAULT_BOT_PREFERENCES, supportsBotMemory, type BotInput, type BotSkillRef, type Session, type StateSnapshot, type StudioBot, type StudioSettings } from "@amo-studio/protocol";
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
import { botSettingsSave } from "./BotSettingsSave.js";
import { BotAutomation, BotMemoryFiles, BotNotificationSettings, BotSettingsOverview, BotWorkspaceSettingsOverview, botSettingsTabs, type BotMemoryPage, type BotSettingsTab } from "./BotSettingsSections.js";
import { useSettings } from "../settings/useSettings.js";
import { useLiveResource } from "../host/live.js";
import "./BotWorkspaceSettings.css";

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
  const sharedFromBot = useRef<string>(undefined);
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
      <BotSettingsEditor key={editing.id} bot={editing} initialSection={sharedFromBot.current === editing.id ? "access" : "overview"} link={link} state={state} enabled={enabled} confirmReset={confirmReset} shared={shared} onOpenChat={onOpenChat}
        onDelete={() => edit(undefined)} onManage={() => { sharedFromBot.current = editing.id; focusShared.current = true; edit(undefined); }} />
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

export function BotWorkspaceSettings({ link, state, bot, initialSection = "overview", onBack, onDeleted, onOpenChat, onOpenConnectors, onShare }: {
  link: HostLink; state: StateSnapshot; bot: StudioBot; onBack(): void; onDeleted(): void;
  initialSection?: BotSettingsTab;
  onOpenChat?(session: Session): void; onOpenConnectors?(): void; onShare?(): void;
}) {
  const settings = useSettings(link);
  const [shared] = useLiveResource<BotSkillRef[] | undefined>({
    initial: undefined,
    load: () => call(link, "GET /api/bot-skills/shared"),
    reloadOn: (event) => event.type === "bots.changed",
  }, [link]);
  return <BotSettingsEditor key={`${bot.id}:${initialSection}`} bot={bot} initialSection={initialSection} link={link} state={state}
    enabled={settings?.botsEnabled !== false} confirmReset={settings?.confirmBotHomeReset !== false} shared={shared}
    workspace={{ onBack, onOpenConnectors, onShare }} onDelete={onDeleted} onOpenChat={onOpenChat}
    onManage={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "bots" }))} />;
}

function BotSettingsEditor({ bot: selected, initialSection, link, state, enabled, confirmReset, shared, onOpenChat, onDelete, onManage, workspace }: {
  bot: StudioBot; initialSection: BotSettingsTab; link: HostLink; state: StateSnapshot; enabled: boolean; confirmReset: boolean; shared?: BotSkillRef[];
  onOpenChat?(session: Session): void; onDelete(): void; onManage(): void;
  workspace?: { onBack(): void; onOpenConnectors?(): void; onShare?(): void };
}) {
  const { id } = selected;
  const save = botSettingsSave(link, selected);
  const { bot, changes, saving, saved, error } = useSyncExternalStore(save.subscribe, save.read);
  const draft: BotInput = { ...bot, ...changes };
  const { change } = save;
  const [textEdit, editText] = useState<{ field: "name" | BotMarkdownField; value: string }>();
  const [section, setSection] = useState(initialSection);
  const [memoryPage, setMemoryPage] = useState<BotMemoryPage>("memory");
  const [askDelete, setAskDelete] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const breadcrumbBack = useRef<HTMLButtonElement>(null);
  const workspaceReturnFocus = useRef<string | null>(null);
  const previousSection = useRef(section);
  const [chats, setChats] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [askReset, setAskReset] = useState(false);
  const [actionError, setActionError] = useState("");
  const preferences = draft.preferences ?? DEFAULT_BOT_PREFERENCES;
  const purposeId = useId();
  const memoryId = useId();
  const memoryHintId = useId();

  useLayoutEffect(() => { save.receive(selected); }, [save, selected]);
  useEffect(() => () => {
    save.endDocumentEdit();
    if (!save.read().error) void save.flush();
  }, [save]);

  function textField(field: "name" | BotMarkdownField) {
    return {
      value: textEdit?.field === field ? textEdit.value : draft[field],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { value } = event.target;
        if (field !== "name") save.beginDocumentEdit(field, draft[field]);
        editText({ field, value });
        change(field, value);
      },
      onBlur: () => {
        if (textEdit?.field !== field) return;
        editText(undefined);
        if (field !== "name") save.endDocumentEdit();
        if (!save.read().error) void save.flush();
      },
    };
  }

  function openSection(tab: BotSettingsTab, file?: BotMemoryPage) {
    if (workspace && section === "overview" && tab !== "overview") workspaceReturnFocus.current = document.activeElement?.getAttribute("aria-label") ?? null;
    if (file) setMemoryPage(file);
    setSection(tab);
    scroll.current?.scrollTo({ top: 0 });
  }

  useLayoutEffect(() => {
    if (!workspace || previousSection.current === section) return;
    previousSection.current = section;
    if (section === "overview") {
      const label = workspaceReturnFocus.current;
      const button = label && Array.from(scroll.current?.querySelectorAll<HTMLButtonElement>("button[aria-label]") ?? [])
        .find((candidate) => candidate.getAttribute("aria-label") === label);
      (button || breadcrumbBack.current)?.focus();
      workspaceReturnFocus.current = null;
    } else breadcrumbBack.current?.focus();
  }, [section, workspace]);

  useEffect(() => {
    if (workspace) return;
    let active = true;
    void call(link, "GET /api/bots/:id/chats", { id }).then((rows) => { if (active) setChats(rows); }).catch(() => {});
    return () => { active = false; };
  }, [id, link, selected.homeSessionId]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try { await action(); }
    catch (err) { setActionError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function openHome(reset: boolean) {
    await perform(async () => {
      if (!await save.flush()) return;
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

  const feedback = <>
    {actionError && <p className="form-error" role="alert">{actionError}</p>}
    {error ? <div className="bot-save-error">
      <p className="form-error" role="alert">{error}</p>
      <button className="link-btn" type="button" disabled={busy} onClick={() => void save.flush()}>重试</button>
      <button className="link-btn" type="button" disabled={busy} onClick={() => { editText(undefined); save.discard(); }}>放弃未保存的改动</button>
    </div> : (saving || saved || Object.keys(changes).length > 0) && <p className="settings-hint" role="status">{saving || !saved ? "正在自动保存…" : "已自动保存"}</p>}
  </>;
  const chatActions = enabled && draft.enabled;
  const hasFeedback = Boolean(actionError || error || saving || saved || Object.keys(changes).length);
  const memorySupported = supportsBotMemory(state.profiles.find((profile) => profile.id === draft.profileId && !profile.unavailable)?.runtime);
  const deleteBot = () => setAskDelete(true);
  return <div className={workspace ? "bot-settings-editor bot-settings-sections bot-workspace-settings" : "bot-settings-editor bot-settings-sections"}
    role={workspace ? "region" : undefined} aria-label={workspace ? "Bot 设置" : undefined}>
    {workspace ? <header className="bot-workspace-settings-breadcrumb">
      <button ref={breadcrumbBack} className="bot-icon-button" type="button" aria-label={section === "overview" ? "返回 Bot 主页" : "返回 Bot 设置"}
        onClick={() => section === "overview" ? workspace.onBack() : openSection("overview")}><IconChevronRight /></button>
      <span>{draft.name}</span><span aria-hidden="true">/</span><strong>设置</strong>
      {section !== "overview" && <><span aria-hidden="true">/</span><strong>{botSettingsTabs.find(([key]) => key === section)?.[1]}</strong></>}
    </header> : <><header className="bot-editor-heading">
      <h3 title={bot.name}>{bot.name}</h3>
      <label className="bot-editor-enabled" title="接收消息并出现在 @ 列表">
        <input type="checkbox" className="bot-setting-switch" role="switch" aria-description="启用后出现在 @ 列表" checked={draft.enabled} disabled={busy} onChange={(event) => change("enabled", event.target.checked)} /> 接收消息
      </label>
    </header>
    <nav className="bot-settings-tabs" aria-label="Bot 设置分区">
      {botSettingsTabs.map(([key, label]) => <button key={key} type="button" aria-current={section === key ? "page" : undefined} onClick={() => openSection(key)}>{label}</button>)}
    </nav></>}
    <div className="bot-editor-scroll" ref={scroll}>
      <form className="bot-editor-form" aria-label={`配置 ${bot.name}`} onSubmit={(event) => {
        event.preventDefault();
        void save.flush();
      }}>
        {section === "overview" && (workspace ? <BotWorkspaceSettingsOverview botId={id} link={link} draft={draft} state={state} shared={shared} disabled={busy}
          canDelete={!busy && !saving} memorySupported={memorySupported} open={openSection} onConnectors={workspace.onOpenConnectors} onShare={workspace.onShare} onDelete={deleteBot} change={change} />
          : <BotSettingsOverview bot={selected} draft={draft} state={state} shared={shared} chats={chats} open={openSection} />)}
        <div className="bot-settings-details" hidden={section !== "runtime"}><div className="bot-editor-identity">
          <BotAvatarPicker draft={draft} busy={busy} change={change} run={perform} />
          <label className="bot-form-field">名称<input className="field" required maxLength={40} disabled={busy} {...textField("name")} /></label>
        </div>
        <section className="bot-editor-section" aria-labelledby="bot-editor-runtime-title">
          <h4 id="bot-editor-runtime-title">运行配置</h4>
          <div className="bot-editor-runtime">
            <BotModelField link={link} profiles={state.profiles} draft={draft} change={change} disabled={busy} />
            {selected.homeSessionId && <small className="settings-hint">点「新建主聊天」即可在主聊天中使用新的运行配置。</small>}
            <BotLocalFields workspaces={state.workspaces} draft={draft} change={change} disabled={busy} />
          </div>
        </section>
        {!workspace && <button className="link-btn bot-settings-delete" type="button" disabled={busy || saving} onClick={deleteBot}>删除 Bot…</button>}
        </div>
        <div className="bot-settings-details" hidden={section !== "access"}>
          <section className="bot-settings-card"><h4>访问权限</h4>
            <BotPreference label="允许同群 Bot 提问" hint="仅在你明确要求群成员转问时接收。" checked={preferences.allowGroupAsk} disabled={busy}
              onChange={(allowGroupAsk) => change("preferences", { ...preferences, allowGroupAsk })} />
          </section>
          <BotSkillsSection link={link} name={draft.name} profileId={draft.profileId} workspaceId={draft.workspaceId} shared={shared} skills={draft.skills}
            busy={busy} onChange={(skills) => change("skills", skills)} onManage={onManage} />
        </div>
        <div hidden={section !== "memory"}><BotMemoryFiles link={link} botId={id} active={section === "memory"} file={memoryPage} select={setMemoryPage}
          purpose={<div className="bot-form-field">
            <div className="bot-settings-file-title"><label htmlFor={purposeId}><code>SOUL.md</code></label>{importButton("purpose", "导入 SOUL.md")}</div>
            <textarea aria-label="职责" id={purposeId} className="field" rows={3} required maxLength={8000} disabled={busy} {...textField("purpose")} />
          </div>}
          memory={<div className="bot-form-field">
            <div className="bot-settings-file-title"><label htmlFor={memoryId}><code>MEMORY.md</code></label>{importButton("memory", "导入 MEMORY.md")}</div>
            <textarea aria-label="记忆" id={memoryId} className="field" rows={3} maxLength={32_000} disabled={busy} aria-describedby={memoryHintId} {...textField("memory")} />
            <small className="settings-hint" id={memoryHintId}>支持 Markdown。新聊天会读取长期记忆。</small>
          </div>} /></div>
      </form>
      <div hidden={section !== "automation"}><BotAutomation bot={bot} link={link} preferences={preferences} disabled={busy}
        memorySupported={memorySupported}
        onChange={(value) => change("preferences", value)} onManage={() => window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "duty" }))} /></div>
      {!workspace && section === "notifications" && <BotNotificationSettings preferences={preferences} disabled={busy} onChange={(value) => change("preferences", value)} />}
      {!workspace && section === "runtime" && !!chats.length && <section className="settings-section"><h4 className="settings-heading">聊天记录</h4>
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
    {((chatActions && !workspace) || hasFeedback) && <footer className="bot-editor-actions">
      {!askReset && feedback}
      {chatActions && !workspace && <div className="settings-row">
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void openHome(false)}>打开主聊天</button>
        {!!selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => {
          if (confirmReset) { setActionError(""); setAskReset(true); }
          else void openHome(true);
        }}>新建主聊天</button>}
      </div>}
    </footer>}
    {askReset && <ConfirmDialog title="新建主聊天" action="新建" busy={busy} onCancel={() => setAskReset(false)} onConfirm={() => void openHome(true)}>
      <p>接下来的主聊天消息会进入新对话。旧聊天和记忆会保留。</p>
      {feedback}
    </ConfirmDialog>}
    {askDelete && <BotEntityDialog link={link} bots={[]} edit={{ action: "delete", entity: { kind: "bot", item: selected } }} onClose={() => setAskDelete(false)} onDeleted={() => { save.discard(); onDelete(); }} />}
  </div>;
}
