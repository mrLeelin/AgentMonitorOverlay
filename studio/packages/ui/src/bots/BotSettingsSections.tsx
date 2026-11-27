import { useEffect, useState, type ReactNode } from "react";
import { DEFAULT_BOT_PREFERENCES, type BotFiles, type BotInput, type BotPreferences, type BotSkillRef, type DutyItem, type Session, type StateSnapshot, type StudioBot } from "@amo-studio/protocol";
import { IconChevronRight, IconPlus } from "../chat/icons.js";
import { setDuty, useDuty } from "../duty/duty.js";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { revealInExplorer } from "../lib/openin.js";
import { showToast } from "../lib/toast.js";
import { scheduleText } from "../settings/DutyPage.js";

export const botSettingsTabs = [["overview", "概览"], ["runtime", "运行配置"], ["memory", "角色与记忆"], ["automation", "自动化"], ["access", "访问与技能"], ["notifications", "通知"]] as const;
export type BotSettingsTab = typeof botSettingsTabs[number][0];
export type BotMemoryPage = "purpose" | "memory" | "notes";

const notificationLabels = { approval: "需要授权", completed: "任务完成", failed: "无法完成" };
const permissionLabels: Record<string, string> = { "read-only": "只读", plan: "只读", "workspace-write": "工作区可写", acceptEdits: "允许编辑", "full-access": "完全访问", bypassPermissions: "完全访问" };

function OverviewRow({ label, value, open }: { label: string; value: ReactNode; open(): void }) {
  return <button className="bot-settings-summary-row" type="button" onClick={open}><span>{label}</span><span>{value}<IconChevronRight /></span></button>;
}

export function BotSettingsOverview({ bot, draft, state, shared, chats, open }: {
  bot: StudioBot; draft: BotInput; state: StateSnapshot; shared?: BotSkillRef[]; chats: Session[]; open(tab: BotSettingsTab, file?: BotMemoryPage): void;
}) {
  const duty = useDuty();
  const jobs = duty?.items.filter((item) => item.action.kind === "bot" && item.action.botId === bot.id) ?? [];
  const preferences = draft.preferences ?? DEFAULT_BOT_PREFERENCES;
  const lastChat = chats.reduce((latest, chat) => Math.max(latest, Date.parse(chat.updatedAt)), 0);
  const inactive = lastChat && Date.now() - lastChat >= preferences.inactiveDays * 86_400_000;
  const profile = state.profiles.find((value) => value.id === draft.profileId);
  const workspace = state.workspaces.find((value) => value.id === draft.workspaceId);
  const schedule = (memory: boolean) => {
    const active = jobs.filter((item) => item.enabled && item.action.kind === "bot" && (item.action.job === "memory") === memory);
    return active.length === 1 ? scheduleText(active[0]!.schedule) : active.length > 1 ? `${active.length} 项已开启` : "未开启";
  };
  return <div className="bot-settings-summary">
    <section className="bot-settings-card"><h4>运行配置</h4>
      <OverviewRow label="模型" value={draft.model ?? profile?.label ?? "请选择模型"} open={() => open("runtime")} />
      <OverviewRow label="执行权限" value={permissionLabels[draft.permission ?? "read-only"] ?? "自定义权限"} open={() => open("runtime")} />
      <OverviewRow label="默认项目" value={workspace?.name ?? "公共目录"} open={() => open("runtime")} />
    </section>
    <section className="bot-settings-card bot-settings-memory-card"><h4>角色与记忆</h4>
      <OverviewRow label="角色职责" value={<code>SOUL.md</code>} open={() => open("memory", "purpose")} />
      <OverviewRow label="长期记忆" value={<code>MEMORY.md</code>} open={() => open("memory", "memory")} />
      <OverviewRow label="记忆文件夹" value={<code>memory/</code>} open={() => open("memory", "notes")} />
    </section>
    <section className="bot-settings-card"><h4>自动化</h4>
      <OverviewRow label="巡视" value={schedule(false)} open={() => open("automation")} />
      <OverviewRow label="记忆整理" value={schedule(true)} open={() => open("automation")} />
      <OverviewRow label="长期未活动" value={inactive ? `已超过 ${preferences.inactiveDays} 天` : `${preferences.inactiveDays} 天`} open={() => open("automation")} />
    </section>
    <section className="bot-settings-card"><h4>访问与技能</h4>
      <OverviewRow label="谁可以提问" value={preferences.allowGroupAsk ? "你及同群 Bot" : "自己"} open={() => open("access")} />
      <OverviewRow label="技能" value={`${shared?.length ?? 0} 项共有 · ${draft.skills?.length ?? 0} 项专用`} open={() => open("access")} />
      <OverviewRow label="连接器" value="Webhook" open={() => open("access")} />
    </section>
    <section className="bot-settings-card bot-settings-summary-wide"><h4>通知</h4>
      <OverviewRow label="需要授权、完成与失败" value={`${Object.values(preferences.notifications).filter(Boolean).length} 项已开启`} open={() => open("notifications")} />
    </section>
  </div>;
}

export function BotNotificationSettings({ preferences, disabled, onChange }: {
  preferences: BotPreferences; disabled: boolean; onChange(value: BotPreferences): void;
}) {
  return <section className="bot-settings-card" aria-label="Bot 通知">
    <h4>Studio 内提醒</h4>
    {(Object.keys(notificationLabels) as Array<keyof BotPreferences["notifications"]>).map((kind) => <label key={kind} className="bot-settings-summary-row">
      <span>{notificationLabels[kind]}</span><input className="bot-setting-switch" type="checkbox" role="switch" disabled={disabled} checked={preferences.notifications[kind]}
        onChange={(event) => onChange({ ...preferences, notifications: { ...preferences.notifications, [kind]: event.target.checked } })} />
    </label>)}
  </section>;
}

export function BotAutomation({ bot, link, preferences, disabled, memorySupported, onChange, onManage }: {
  bot: StudioBot; link: HostLink; preferences: BotPreferences; disabled: boolean; memorySupported: boolean; onChange(value: BotPreferences): void; onManage(): void;
}) {
  const duty = useDuty();
  const [editingPatrol, editPatrol] = useState(false);
  const [editingTime, editTime] = useState<{ jobId: string; value: string }>();
  const [period, setPeriod] = useState("4");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState<{ runningItemId?: string }>();
  const [error, setError] = useState("");
  const busy = !!pending;
  const jobs = duty?.items.filter((item) => item.action.kind === "bot" && item.action.botId === bot.id) ?? [];

  async function change(action: () => Promise<void>, runningItemId?: string) {
    setPending({ runningItemId });
    setError("");
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPending(undefined); }
  }

  async function runJob(item: DutyItem) {
    await change(async () => {
      const state = await call(link, "POST /api/duty/items/:id/run", { id: item.id });
      setDuty(state);
      if (item.action.kind !== "bot" || item.action.job !== "memory") return;
      const run = state.runs.find((entry) => entry.itemId === item.id);
      if (run?.endedAt) showToast({ key: item.id, text: `${run.ok ? "记忆整理完成。" : "记忆整理失败。"}${run.summary}`, error: run.ok === false });
    }, item.id);
  }

  function renderJob(item: DutyItem) {
    const latest = duty?.runs.find((run) => run.itemId === item.id && run.endedAt);
    const running = pending?.runningItemId === item.id || duty?.running.includes(item.id);
    const daily = item.action.kind === "bot" && item.action.job === "memory" && "daily" in item.schedule ? item.schedule.daily : undefined;
    return <div key={item.id}>
      <div className="bot-settings-scheduled">
        <div><strong>{item.title}</strong><small className="settings-hint">{scheduleText(item.schedule)}{latest && ` · ${latest.summary}`}</small></div>
        {daily && <button type="button" className="btn-ghost small" disabled={busy || disabled} onClick={() => editTime({ jobId: item.id, value: daily })}>修改时间</button>}
        <button type="button" className="btn-ghost small" disabled={busy || disabled || !bot.enabled || running}
          onClick={() => void runJob(item)}>{running ? "运行中…" : "运行一次"}</button>
        <input aria-label={`启用${item.title}`} className="bot-setting-switch" type="checkbox" role="switch" checked={item.enabled} disabled={busy || disabled}
          onChange={(event) => { const enabled = event.target.checked; void change(async () => setDuty(await call(link, "PATCH /api/duty/items/:id", { id: item.id }, { enabled }))); }} />
      </div>
      {editingTime?.jobId === item.id && <form className="bot-settings-schedule-form" onSubmit={(event) => {
        event.preventDefault();
        void change(async () => {
          setDuty(await call(link, "PATCH /api/duty/items/:id", { id: item.id }, { schedule: { daily: editingTime.value } }));
          editTime(undefined);
        });
      }}>
        <label className="bot-form-field">每天运行时间<input className="field" type="time" value={editingTime.value} onChange={(event) => editTime({ jobId: item.id, value: event.target.value })} /></label>
        <div className="settings-row">
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => editTime(undefined)}>取消</button>
          <button type="submit" className="btn-primary small" disabled={busy || disabled || !editingTime.value}>保存时间</button>
        </div>
      </form>}
    </div>;
  }

  return <div className="bot-settings-details">
    <div className="settings-row"><button className="btn-ghost small" type="button" onClick={onManage}>管理值守</button></div>
    {(["patrol", "memory"] as const).map((kind) => <section key={kind} className="bot-settings-card">
      <h4>{kind === "patrol" ? "巡视" : "记忆整理"}</h4>
      <p className="settings-hint">{kind === "patrol" ? "按计划在独立聊天里发送巡视指令。"
        : memorySupported ? "由 Bot 的 Codex 或 Claude 模型回顾近期直接聊天，将长期偏好、决定和纠正里体现的约定写入 MEMORY.md。"
        : "切换到 Codex 或 Claude 渠道后可整理记忆。"}</p>
      {(kind === "patrol" || memorySupported) && jobs.filter((item) => item.action.kind === "bot" && (item.action.job === "memory") === (kind === "memory")).map(renderJob)}
      {kind === "patrol" && (editingPatrol ? <div className="bot-settings-schedule-form">
        <label className="bot-form-field">巡视频率<select className="field" value={period} onChange={(event) => setPeriod(event.target.value)}><option value="4">每 4 小时</option><option value="8">每 8 小时</option><option value="24">每 24 小时</option></select></label>
        <label className="bot-form-field">巡视指令<textarea className="field" value={prompt} rows={3} maxLength={20_000} onChange={(event) => setPrompt(event.target.value)} /></label>
        <div className="settings-row">
          <button type="button" className="btn-ghost small" disabled={busy} onClick={() => editPatrol(false)}>取消</button>
          <button type="button" className="btn-primary small" disabled={busy || disabled || !prompt.trim()} onClick={() => void change(async () => {
            setDuty(await call(link, "POST /api/duty/items", {}, {
              title: `${bot.name} · 巡视`, enabled: true, schedule: { every: Number(period) * 3600 },
              action: { kind: "bot", botId: bot.id, prompt: prompt.trim() },
            }));
            editPatrol(false);
            setPrompt("");
          })}>保存计划</button>
        </div>
      </div> : <button className="link-btn bot-settings-add" type="button" disabled={disabled || busy || !duty} onClick={() => editPatrol(true)}><IconPlus />新建巡视</button>)}
    </section>)}
    <section className="bot-settings-card"><label className="bot-settings-summary-row"><span>多久算长期未活动</span><select className="field" value={preferences.inactiveDays} disabled={disabled}
      onChange={(event) => onChange({ ...preferences, inactiveDays: Number(event.target.value) as BotPreferences["inactiveDays"] })}>
      <option value={5}>5 天</option><option value={7}>7 天</option><option value={14}>14 天</option></select></label></section>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function BotMemoryFiles({ link, botId, active, file, select, purpose, memory }: {
  link: HostLink; botId: string; active: boolean; file: BotMemoryPage; select(page: BotMemoryPage): void; purpose: ReactNode; memory: ReactNode;
}) {
  const [files, setFiles] = useState<BotFiles>();
  const [note, setNote] = useState<string>();
  const [original, setOriginal] = useState<string | null>();
  const [content, setContent] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, reload] = useState(0);
  const generated = !creating && note === "自动整理.md";

  useEffect(() => onHostEvent((event) => {
    if (event.type === "bot-files.changed" && event.botId === botId) reload((n) => n + 1);
  }), [botId]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    void call(link, "GET /api/bots/:id/files", { id: botId }).then((result) => { if (live) { setFiles(result); setError(""); } },
      (err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [active, botId, link, revision]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  function selectNote(value: string) {
    select("notes");
    setCreating(false);
    setNote(value);
    setOriginal(undefined);
    void perform(async () => {
      const { text } = await call(link, "GET /api/bots/:id/notes/:name", { id: botId, name: value });
      setOriginal(text);
      setContent(text);
    });
  }

  function saveNote() {
    const fileName = creating ? name.trim() : note;
    if (!fileName || original === undefined) return;
    void perform(async () => {
      const result = await call(link, "PUT /api/bots/:id/notes/:name", { id: botId, name: fileName }, { text: content, expected: original });
      setFiles(result);
      setNote(fileName);
      setOriginal(content);
      setCreating(false);
    });
  }

  return <div className="bot-settings-details">
    <div>
      <div className="settings-row"><h4 className="settings-heading">Bot 资料目录</h4><button className="btn-ghost small" type="button" disabled={!files || busy}
        onClick={() => void perform(async () => { if (files) await revealInExplorer(link, { path: files.folder }); })}>打开资料目录</button></div>
      <p className="settings-hint">每个 Bot 保存自己的职责和长期记忆。任务仍在原项目或工作树运行。</p>
    </div>
    <div className="bot-settings-file-browser">
      <nav aria-label="Bot 资料文件">
        <button type="button" aria-pressed={file === "purpose"} onClick={() => select("purpose")}>SOUL.md</button>
        <button type="button" aria-pressed={file === "memory"} onClick={() => select("memory")}>MEMORY.md</button>
        <details open><summary>memory/</summary>
          {files?.notes.map((value) => <button key={value} type="button" disabled={busy} aria-pressed={file === "notes" && !creating && note === value} onClick={() => selectNote(value)}>{value}</button>)}
          <button type="button" disabled={!files || busy} aria-pressed={file === "notes" && creating} onClick={() => { select("notes"); setNote(undefined); setCreating(true); setName(""); setContent(""); setOriginal(null); }}>新建记忆文件</button>
        </details>
      </nav>
      <div className="bot-settings-file-body">
        <div hidden={file !== "purpose"}>{purpose}</div>
        <div hidden={file !== "memory"}>{memory}</div>
        {file === "notes" && (creating || note ? <>
          {creating ? <label className="bot-form-field">文件名<input className="field" value={name} placeholder="审查笔记.md" maxLength={78} onChange={(event) => setName(event.target.value)} /></label>
            : <label className="bot-settings-file-title" htmlFor="bot-note-content">{note}</label>}
          <textarea aria-label="记忆文件内容" id="bot-note-content" className="field" value={content} readOnly={generated} disabled={busy || original === undefined} maxLength={32_000} onChange={(event) => setContent(event.target.value)} />
          {generated ? <p className="settings-hint">旧版整理记录。现在的整理结果写入 MEMORY.md。</p>
            : <div className="settings-row"><button type="button" className="btn-primary small" disabled={busy || original === undefined || (creating ? !name.trim() : content === original)} onClick={saveNote}>保存文件</button></div>}
        </> : <p className="settings-hint">选择一份记忆文件，或新建笔记。</p>)}
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error}{!files && <button className="link-btn" type="button" onClick={() => reload((n) => n + 1)}>重试</button>}</p>}
  </div>;
}
