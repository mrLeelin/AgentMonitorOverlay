import { useEffect, useState } from "react";
import type { BotInput, Session, StateSnapshot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { SettingActions, SettingField } from "../settings/SettingField.js";
import { botsChanged, useBots } from "./BotRequests.js";
import { BotWebhooks } from "./BotWebhooks.js";
import { BotAvatar, encodeBotAvatar } from "./BotAvatar.js";

const REVIEW_PURPOSE = "审查代码改动，优先报告可复现的功能回归。每条结论附文件、行号、影响和触发条件，并注明未验证项。";

export function BotsPage({ link, state, onOpenChat }: { link: HostLink; state: StateSnapshot; onOpenChat?(session: Session): void }) {
  const bots = useBots(link);
  const models = state.profiles.filter((p) => p.runtime === "codex" && !p.unavailable && !p.hidden);
  const initial = (): BotInput => ({ name: "", purpose: "", memory: "", profileId: models[0]?.id ?? "", workspaceId: null, enabled: true });
  const [id, select] = useState<string | null>(null);
  const [draft, setDraft] = useState<BotInput>(initial);
  const [chats, setChats] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const selected = bots.find((bot) => bot.id === id);
  const change = <K extends keyof BotInput>(field: K, value: BotInput[K]) => setDraft((old) => ({ ...old, [field]: value }));

  useEffect(() => {
    setChats([]);
    if (!id) return;
    let current = true;
    void call(link, "GET /api/bots/:id/chats", { id }).then((rows) => { if (current) setChats(rows); }).catch(() => {});
    return () => { current = false; };
  }, [id, link]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setNotice(undefined);
    try { await action(); }
    catch (err) { setNotice({ text: err instanceof Error ? err.message : String(err), error: true }); }
    finally { setBusy(false); }
  }

  async function save() {
    await perform(async () => {
      const bot = id ? await call(link, "PUT /api/bots/:id", { id }, draft) : await call(link, "POST /api/bots", {}, draft);
      select(bot.id);
      setDraft(bot);
      botsChanged();
      setNotice({ text: "已保存。" });
    });
  }

  async function openHome(reset: boolean) {
    if (!id) return;
    await perform(async () => {
      const home = await call(link, "POST /api/bots/:id/home", { id }, { reset });
      botsChanged();
      onOpenChat?.(home);
    });
  }

  function importText(field: "purpose" | "memory", file: File | undefined) {
    if (!file) return;
    void perform(async () => {
      const max = field === "purpose" ? 8000 : 32_000;
      if (file.size > max * 4) throw new Error(`Markdown 最多 ${max} 个字符。`);
      const text = await file.text();
      if (text.length > max) throw new Error(`Markdown 最多 ${max} 个字符。`);
      change(field, text);
    });
  }

  function importButton(field: "purpose" | "memory", label: string) {
    return <label className="btn-ghost small bot-import">{label}<input type="file" accept=".md,.txt,text/plain,text/markdown" aria-label={label} disabled={busy} onChange={(event) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      importText(field, file);
    }} /></label>;
  }

  return <div className="bots-settings" data-testid="studio-bots-settings">
    <div className="settings-row bots-chooser">
      {bots.map((bot) => <button key={bot.id} type="button" className={id === bot.id ? "btn small" : "btn-ghost small"} aria-pressed={id === bot.id} disabled={busy} onClick={() => { select(bot.id); setDraft(bot); setNotice(undefined); }}><span className="bot-identity"><BotAvatar name={bot.name} avatar={bot.avatar} size={22} />{bot.name}{bot.enabled ? "" : "（已停用）"}</span></button>)}
      <button type="button" className="btn-ghost small" disabled={busy} onClick={() => { select(null); setDraft(initial()); setNotice(undefined); }}>＋ 新建 Bot</button>
      <button type="button" className="btn-ghost small" disabled={busy} onClick={() => { select(null); setDraft({ ...initial(), name: "审核员", purpose: REVIEW_PURPOSE }); setNotice(undefined); }}>用审核员模板</button>
    </div>
    <form className="settings-section" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <SettingField label="头像" hint="图片会居中裁成正方形。">
        <div className="settings-row" data-testid="bot-avatar-preview">
          <BotAvatar name={draft.name} avatar={draft.avatar} size={52} />
          <label className="btn-ghost small bot-import">选择头像<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择头像" disabled={busy} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void perform(async () => change("avatar", await encodeBotAvatar(file)));
          }} /></label>
          {draft.avatar && <button className="btn-ghost small" type="button" onClick={() => change("avatar", null)} disabled={busy}>恢复默认头像</button>}
        </div>
      </SettingField>
      <SettingField label="名称" htmlFor="studio-bot-name"><input id="studio-bot-name" className="field" required maxLength={40} value={draft.name} onChange={(e) => change("name", e.target.value)} /></SettingField>
      <SettingField label="模型配置" htmlFor="studio-bot-model"><select id="studio-bot-model" className="field" required value={draft.profileId} onChange={(e) => change("profileId", e.target.value)}><option value="">选择 Codex 配置</option>{models.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></SettingField>
      <SettingField label="默认项目" htmlFor="studio-bot-project" hint="从任务发起时，消息会附上任务会话的实际工作目录。"><select id="studio-bot-project" className="field" value={draft.workspaceId ?? ""} onChange={(e) => change("workspaceId", e.target.value || null)}><option value="">公共目录</option>{state.workspaces.filter((w) => !w.archivedAt && w.builtin !== "common").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></SettingField>
      <SettingField label="职责" htmlFor="studio-bot-purpose"><textarea id="studio-bot-purpose" className="field" rows={3} required maxLength={8000} value={draft.purpose} onChange={(e) => change("purpose", e.target.value)} />{importButton("purpose", "导入 SOUL.md")}</SettingField>
      <SettingField label="记忆" htmlFor="studio-bot-memory" hint="支持 Markdown。新聊天会读取保存的记忆。">
        <textarea id="studio-bot-memory" className="field" rows={3} maxLength={32000} value={draft.memory} onChange={(e) => change("memory", e.target.value)} />
        {importButton("memory", "导入 MEMORY.md")}
      </SettingField>
      <SettingField label="权限"><span className="setting-field-value">只读</span></SettingField>
      <SettingField label="启用" htmlFor="studio-bot-enabled"><label><input id="studio-bot-enabled" type="checkbox" checked={draft.enabled} onChange={(e) => change("enabled", e.target.checked)} /> 出现在 @ 列表</label></SettingField>
      <SettingActions below={notice && <p className={notice.error ? "form-error" : "settings-feedback"} role={notice.error ? "alert" : "status"}>{notice.text}</p>}>
        <button type="submit" className="btn-primary small" disabled={busy || !draft.name.trim() || !draft.purpose.trim() || !draft.profileId}>保存</button>
        {selected?.enabled && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void openHome(false)}>打开主聊天</button>}
        {selected?.enabled && selected.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void openHome(true)}>新建主聊天</button>}
      </SettingActions>
    </form>
    {!!chats.length && <section className="settings-section"><h3 className="settings-heading">聊天记录</h3>
      {chats.map((chat) => <div className="settings-row" key={chat.id}>
        <button type="button" className="btn-ghost small bot-history-row" onClick={() => onOpenChat?.(chat)}>{chat.id === selected?.homeSessionId ? "主聊天" : chat.title || "未命名聊天"}{chat.archivedAt ? "（已归档）" : ""} ↗</button>
        {id && chat.id !== selected?.homeSessionId && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void perform(async () => {
          const route = chat.archivedAt ? "POST /api/sessions/:id/unarchive" : "POST /api/sessions/:id/archive";
          await call(link, route, { id: chat.id });
          setChats(await call(link, "GET /api/bots/:id/chats", { id }));
        })}>{chat.archivedAt ? "恢复" : "归档"}</button>}
      </div>)}
    </section>}
    {id && <BotWebhooks key={id} link={link} id={id} />}
  </div>;
}
