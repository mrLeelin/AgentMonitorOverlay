import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { BOT_SKILL_LIMIT, type BotSkillCatalog, type BotSkillChoice, type BotSkillRef, type BotSkillSource } from "@amo-studio/protocol";
import { IconOpenWindow, IconPlus, IconRead, IconSearch } from "../chat/icons.js";
import { viewFile } from "../files/FileLinks.js";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";

const EMPTY: BotSkillRef[] = [];
const GROUPS: [BotSkillSource, string][] = [["global", "本机全局"], ["project", "项目技能"], ["plugin", "插件内置"]];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type CatalogState = { catalog?: BotSkillCatalog; error?: string };

function useSkillPicker(link: HostLink, needed: boolean, profileId?: string, workspaceId?: string | null) {
  const [open, setOpen] = useState(false);
  const [revision, refresh] = useState(0);
  const [response, setResponse] = useState<{ request: string; state: CatalogState }>();
  const request = JSON.stringify([link.url, profileId, workspaceId, revision]);
  const active = needed || open;
  useEffect(() => {
    if (!active) return;
    let current = true;
    void call(link, "POST /api/bot-skills/catalog", {}, profileId ? { profileId, workspaceId } : {}).then(
      (catalog) => { if (current) setResponse({ request, state: { catalog } }); },
      (error: unknown) => { if (current) setResponse({ request, state: { error: errorText(error) } }); },
    );
    return () => { current = false; };
  }, [link, request, active, profileId, workspaceId]);
  return {
    open, state: response?.request === request ? response.state : {},
    show: () => { refresh((n) => n + 1); setOpen(true); },
    close: () => setOpen(false),
    retry: () => refresh((n) => n + 1),
  };
}

function SkillList({ skills, state, inherited, onRemove }: {
  skills: readonly BotSkillRef[]; state: CatalogState; inherited?: boolean; onRemove?(id: string): void;
}) {
  const available = new Map(state.catalog?.skills.map((skill) => [skill.id, skill]));
  if (!skills.length) return <p className="bot-skill-empty settings-hint">{inherited ? "还没有设置共有技能。" : "还没有添加技能。"}</p>;
  return <ul className={`bot-skill-list${inherited ? " inherited" : ""}`}>
    {skills.map((ref) => {
      const skill = available.get(ref.id);
      const reason = state.error ? "暂时无法核对" : !state.catalog ? "正在核对…" :
        skill?.unavailable ?? (!skill ? "当前渠道或目录下不可用" : "");
      return <li key={ref.id} className="bot-skill-row">
        <span className="bot-skill-icon" aria-hidden="true"><IconRead /></span>
        <span className="bot-skill-detail"><strong>{skill?.name ?? ref.name}</strong><small>{skill?.label ?? ref.label}{reason && ` · ${reason}`}</small></span>
        {onRemove && <button type="button" className="link-btn" aria-label={`移除 ${ref.name}`} onClick={() => onRemove(ref.id)}>移除</button>}
      </li>;
    })}
  </ul>;
}

function SkillPicker({ scope, state, existing, limit, retry, onClose, onAdd }: {
  scope: string; state: CatalogState; existing: readonly BotSkillRef[]; limit: number; retry(): void; onClose(): void; onAdd(skills: BotSkillRef[]): void;
}) {
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<BotSkillSource | "all">("all");
  const [checked, setChecked] = useState<string[]>([]);
  useEffect(() => search.current?.focus(), []);
  const terms = query.trim().toLowerCase().split(/\s+/);
  const assigned = new Set(existing.map((skill) => skill.id));
  const available = state.catalog?.skills.filter((skill) => !assigned.has(skill.id)) ?? [];
  const visible = available.filter((skill) => (source === "all" || source === skill.source) &&
    terms.every((term) => `${skill.name} ${skill.label} ${skill.description}`.toLowerCase().includes(term)));
  const selected = available.filter((skill) => !skill.unavailable && checked.includes(skill.id));

  function choice(skill: BotSkillChoice) {
    const picked = checked.includes(skill.id);
    return <div className="bot-skill-choice" key={skill.id}>
      <label>
        <input type="checkbox" checked={picked} disabled={!!skill.unavailable || (!picked && selected.length >= limit)} onChange={(event) => {
          setChecked((old) => event.target.checked ? [...old, skill.id] : old.filter((value) => value !== skill.id));
        }} />
        <span className="bot-skill-detail"><strong>{skill.name}</strong><small>{[skill.label, skill.description].filter(Boolean).join(" · ")}</small></span>
      </label>
      {skill.unavailable ? <small className="bot-skill-state">{skill.unavailable}</small> :
        <button type="button" className="link-btn bot-skill-view" aria-label={`查看 ${skill.name} 说明`} onClick={() => viewFile({ file: { path: skill.path } }, null)}>说明 <IconOpenWindow /></button>}
    </div>;
  }

  return <Modal portal className="bot-skill-picker" backdropClassName="confirm-backdrop bot-skill-backdrop" labelledBy={id} onClose={onClose}>
    <header><h3 className="modal-title" id={id}>添加技能</h3><p className="settings-hint">{scope}</p></header>
    <div className="bot-skill-toolbar">
      <label className="bot-skill-search"><IconSearch /><input ref={search} className="field" type="search" aria-label="搜索技能" placeholder="搜索名称、简介或来源" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <select className="field" aria-label="技能来源" value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
        <option value="all">全部来源</option>
        {GROUPS.filter(([key]) => available.some((skill) => skill.source === key)).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select>
    </div>
    <div className="bot-skill-results">
      {state.error ? <div className="bot-skill-loading form-error" role="alert">读取技能失败：{state.error} <button type="button" className="link-btn" onClick={retry}>重试</button></div> :
        !state.catalog ? <p className="bot-skill-loading settings-hint" role="status">正在读取技能…</p> : <>
          {state.catalog.note && <p className="bot-skill-loading settings-hint">{state.catalog.note}</p>}
          {!visible.length && <p className="bot-skill-loading settings-hint">{query.trim() || source !== "all" ? "没有匹配的技能。" : "没有可添加的技能。可在「技能展览」查看本机技能。"}</p>}
          {GROUPS.map(([key, label]) => {
            const rows = visible.filter((skill) => skill.source === key);
            return rows.length > 0 && <section className="bot-skill-choice-group" key={key}><h4>{label}</h4>{rows.map(choice)}</section>;
          })}
        </>}
    </div>
    <footer className="settings-row end bot-skill-picker-footer">
      {limit === 0 && <span className="settings-hint">已达到技能数量上限。</span>}
      <button type="button" className="btn-ghost small" onClick={onClose}>取消</button>
      <button type="button" className="btn-primary small" disabled={!selected.length} onClick={() => onAdd(selected.map(({ id, name, source, label }) => ({ id, name, source, label })))}>
        {selected.length ? `添加（${selected.length}）` : "添加"}
      </button>
    </footer>
  </Modal>;
}

export function BotSharedSkills({ link, shared, error, retry, onSave, heading }: {
  link: HostLink; shared?: BotSkillRef[]; error?: string; retry(): void; onSave(skills: BotSkillRef[]): void; heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [draft, setDraft] = useState<BotSkillRef[]>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const skills = draft ?? shared ?? EMPTY;
  const picker = useSkillPicker(link, !!skills.length);
  const changed = !!draft && JSON.stringify(draft) !== JSON.stringify(shared);
  async function save() {
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      onSave(await call(link, "PUT /api/bot-skills/shared", {}, { skills }));
      setDraft(undefined);
      setNotice("已保存，新建聊天时生效。");
    } catch (error) { setSaveError(errorText(error)); }
    finally { setSaving(false); }
  }
  return <section className="bot-editor-section bot-skill-section" aria-labelledby="bot-shared-skills-title">
    <header className="bot-skill-head">
      <div><h4 id="bot-shared-skills-title" ref={heading} tabIndex={-1}>共有技能</h4><p className="settings-hint">本机现有和以后新建的 Bot 都会继承。可添加本机的公共 Agent 技能。</p></div>
      <button type="button" className="btn-ghost small bot-skill-add" disabled={!shared || saving} onClick={picker.show}><IconPlus /> 添加技能</button>
    </header>
    {shared ? <SkillList skills={skills} state={picker.state} onRemove={saving ? undefined : (id) => { setNotice(""); setDraft(skills.filter((skill) => skill.id !== id)); }} /> :
      error ? <p className="form-error" role="alert">读取共有技能失败：{error} <button type="button" className="link-btn" onClick={retry}>重试</button></p> :
        <p className="settings-hint" role="status">正在读取共有技能…</p>}
    <div className="settings-row end bot-skill-save">
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      {notice && <p className="settings-feedback" role="status">{notice}</p>}
      <button type="button" className="btn-primary small" disabled={!changed || saving} onClick={() => void save()}>保存共有技能</button>
    </div>
    {picker.open && <SkillPicker scope="添加到所有 Bot 的共有技能" state={picker.state} existing={skills} limit={BOT_SKILL_LIMIT - skills.length}
      retry={picker.retry} onClose={picker.close} onAdd={(added) => { setNotice(""); setDraft([...skills, ...added]); picker.close(); }} />}
  </section>;
}

export function BotSkillsSection({ link, name, profileId, workspaceId, shared, skills = EMPTY, busy, onChange, onManage }: {
  link: HostLink; name: string; profileId: string; workspaceId: string | null; shared?: BotSkillRef[]; skills?: BotSkillRef[]; busy: boolean; onChange(skills: BotSkillRef[]): void; onManage(): void;
}) {
  const picker = useSkillPicker(link, !!skills.length || !!shared?.length, profileId, workspaceId);
  const unique = new Set(shared?.map((skill) => skill.id));
  const custom = skills.filter((skill) => !unique.has(skill.id));
  return <section className="bot-editor-section bot-skill-section" aria-labelledby="bot-skills-title">
    <h4 id="bot-skills-title">技能</h4>
    <div className="bot-skill-group">
      <header className="bot-skill-head"><h5>继承的共有技能 {shared && <span className="bot-skill-count">{shared.length}</span>}</h5>
        <button type="button" className="link-btn" disabled={busy} onClick={onManage}>管理共有技能 <IconOpenWindow /></button>
      </header>
      {shared ? <SkillList skills={shared} state={picker.state} inherited /> : <p className="settings-hint">共有技能可在通用设置中查看。</p>}
    </div>
    <div className="bot-skill-group">
      <header className="bot-skill-head"><h5>此 Bot 专用技能 <span className="bot-skill-count">{custom.length}</span></h5>
        <button type="button" className="btn-ghost small bot-skill-add" disabled={busy || !profileId} onClick={picker.show}><IconPlus /> 添加技能</button>
      </header>
      <SkillList skills={custom} state={picker.state} onRemove={busy ? undefined : (id) => onChange(skills.filter((skill) => skill.id !== id))} />
      <p className="settings-hint">保存后，新建聊天使用更新后的技能。</p>
    </div>
    {picker.open && <SkillPicker scope={`添加到「${name}」的专用技能`} state={picker.state} existing={[...skills, ...(shared ?? EMPTY)]} limit={BOT_SKILL_LIMIT - skills.length}
      retry={picker.retry} onClose={picker.close} onAdd={(added) => { onChange([...skills, ...added]); picker.close(); }} />}
  </section>;
}
