import { useEffect, useRef, useState } from "react";
import { MAX_SUBSESSION_NOTES, SUBSESSION_NOTE_MAX, type ModelOption, type ModelProfile, type StudioSettings, type SubsessionNote, type SubsessionPermission } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { effortLabel, modelName, useChoicesFor } from "../lib/choices.js";
import { pickable } from "../lib/profiles.js";
import { useProfiles } from "../lib/balance.js";
import { Mark } from "../chat/pickers.js";

// 2026-11-11: A 版分栏。切换型号只负责导航，不创建空配置；默认型号仍与渠道通用设置共用 model:null。
// Fast / 权限按型号覆盖渠道，用法单独填写时优先；渠道的强度只用于默认型号。
type Selection = { profileId: string; model: string | null };
type Defaults = Partial<Pick<SubsessionNote, "effort" | "fast" | "permission">>;
const LEVELS: Array<{ id: SubsessionPermission | null; label: string; hint: string }> = [
  { id: null, label: "沿用默认", hint: "沿用渠道设置，否则按父会话与运行方式的默认规则" },
  { id: "read-only", label: "只读", hint: "只读取内容，不修改文件" },
  { id: "write", label: "可写", hint: "允许修改工作目录，越界操作需要确认" },
  { id: "full", label: "完全访问", hint: "不使用沙箱与审批" },
];
const hasContent = (n: SubsessionNote) => !!n.note.trim() || !!n.effort || n.fast !== undefined || !!n.permission;
const keyOf = (n: Selection) => `${n.profileId}/${n.model ?? ""}`;
const emptyNote = (pick: Selection): SubsessionNote => ({ ...pick, note: "" });

export function SubsessionPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const profiles = useProfiles(link);
  const [notes, setNotes] = useState(settings?.subsessionNotes ?? []);
  const latest = useRef(notes);
  const writes = useRef(Promise.resolve());
  const outstanding = useRef(0);
  const failures = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // 保存中的响应由队列接续，避免旧 settings 事件覆盖下一次修改的基准。
    if (outstanding.current) return;
    latest.current = settings?.subsessionNotes ?? [];
    setNotes(latest.current);
  }, [settings?.subsessionNotes]);
  const available = pickable(profiles ?? []);
  const channels = (profiles ?? []).filter((p) => available.includes(p) || notes.some((n) => n.profileId === p.id));
  const choices = useChoicesFor(link, channels.map((p) => p.id));
  const profile = channels.find((p) => p.id === selection?.profileId) ?? channels[0];
  const pick: Selection | null = profile ? { profileId: profile.id, model: selection?.profileId === profile.id ? selection.model : null } : null;
  const selectedKey = pick ? keyOf(pick) : "";
  useEffect(() => { if (editor.current) editor.current.scrollTop = 0; }, [selectedKey]);

  const textOf = (n: SubsessionNote) => drafts[keyOf(n)] ?? n.note;
  function change(pick: Selection, edit: (current: SubsessionNote) => SubsessionNote | null, onSaved?: () => void) {
    outstanding.current++;
    setPending(true);
    const key = keyOf(pick);
    const channel = profiles?.find((p) => p.id === pick.profileId)?.label ?? "渠道";
    const target = pick.model ? `${channel} / ${modelName(choices.get(pick.profileId)?.models.find((m) => m.id === pick.model)) ?? pick.model}` : `${channel} / 渠道通用设置`;
    // 失焦保存与紧接着的选项点击，按顺序在最新结果上合并，避免整张设置列表互相覆盖。
    writes.current = writes.current.then(async () => {
      const current = latest.current;
      const previous = current.find((n) => keyOf(n) === keyOf(pick));
      const updated = edit(previous ?? emptyNote(pick));
      const keep = updated && hasContent(updated) ? updated : null;
      const next = current.flatMap((n) => keyOf(n) !== key ? [n] : keep ? [keep] : []);
      if (!previous && keep) next.push(keep);
      if (next.length > MAX_SUBSESSION_NOTES) throw new Error(`最多保存 ${MAX_SUBSESSION_NOTES} 项设置，请先清除不再使用的配置。`);
      const response = await call(link, "PUT /api/settings", {}, { subsessionNotes: next });
      latest.current = response.subsessionNotes;
      setNotes(response.subsessionNotes);
      failures.current.delete(key);
      setError([...failures.current.values()].join("；") || null);
      onSaved?.();
    }).catch((err: unknown) => {
      failures.current.set(key, `未能保存「${target}」：${err instanceof HostApiError || err instanceof Error ? err.message : String(err)}`);
      setError([...failures.current.values()].join("；"));
    }).finally(() => {
      outstanding.current--;
      setPending(outstanding.current > 0);
    });
  }
  function clearDraft(n: SubsessionNote, text: string) {
    const key = keyOf(n);
    setDrafts((current) => {
      if (current[key] !== text) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  }
  function commit(n: SubsessionNote) {
    const text = textOf(n);
    if (text.trim() !== n.note) change(n, (current) => ({ ...current, note: text.trim() }), () => clearDraft(n, text));
    else clearDraft(n, text);
  }
  function setDefaults(n: SubsessionNote, patch: Defaults) {
    const text = textOf(n);
    change(n, (current) => {
      const out = { ...current, note: text, ...patch };
      if (out.effort === undefined) delete out.effort;
      if (out.fast === undefined) delete out.fast;
      if (out.permission === undefined) delete out.permission;
      return out;
    }, () => clearDraft(n, text));
  }
  function remove(n: SubsessionNote) {
    const text = textOf(n);
    change(n, () => null, () => clearDraft(n, text));
  }

  if (!profiles) return <span className="settings-hint">正在读取渠道…</span>;
  if (!profile || !pick) return <section className="settings-section"><span className="settings-heading">子会话</span><span className="settings-hint">还没有可用的渠道，请先到「模型」设置添加。</span></section>;
  const models = choices.get(profile.id)?.models ?? [];
  const defaultModel = models.find((m) => m.isDefault) ?? models[0];
  const entries = models.filter((m) => !m.isDefault).map((m) => ({ model: m.id, label: modelName(m) ?? m.id, retired: false }));
  // 曾经单独设置过的型号即使后来成为默认，也保留原记录的入口，不把它偷偷合并进通用项。
  for (const n of notes.filter((n) => n.profileId === profile.id && n.model && !entries.some((e) => e.model === n.model))) entries.push({ model: n.model!, label: modelName(models.find((m) => m.id === n.model)) ?? n.model!, retired: true });
  const filtered = entries.filter((e) => `${e.label} ${e.model}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const note = notes.find((n) => keyOf(n) === selectedKey) ?? emptyNote(pick);
  const account = notes.find((n) => n.profileId === profile.id && n.model === null);
  const model = pick.model ? models.find((m) => m.id === pick.model) : defaultModel;
  const name = pick.model ? (modelName(model) ?? pick.model) : "渠道通用设置";
  const configured = hasContent(note);
  const status = pending ? "正在保存…" : failures.current.has(selectedKey) ? "保存失败，请重试" : drafts[selectedKey] !== undefined && drafts[selectedKey].trim() !== note.note.trim() ? "离开输入框后保存" : configured ? "已保存" : "尚未单独设置";
  return (
    <section className="settings-section subsession-page" aria-label="子会话">
      <header className="subsession-page-head">
        <div><span className="settings-heading">子会话</span><p className="settings-hint">设置 AI 开子会话时的默认选项，以及如何使用每个模型。</p></div>
        <details className="subsession-rules"><summary>ⓘ 生效规则</summary><div>
          <p><b>什么时候用</b><br />在「@ 开子会话」里作为初始值；AI 自己开子会话、没有指定选项时也会使用。</p>
          <p><b>启动选项</b><br />型号单独设置优先；Fast 和权限未设置时沿用渠道。思考强度只适用于当前型号，渠道的强度只用于默认型号。</p>
          <p><b>用法说明</b><br />写给主模型看，帮助它选择模型和交代任务。型号单独填写用法时优先使用，否则沿用渠道通用说明。</p>
          <p><b>保存方式</b><br />每段最多 {SUBSESSION_NOTE_MAX} 字，离开输入框时保存；选项改了立即保存。</p>
        </div></details>
      </header>
      <div className="subsession-channel-tabs" role="group" aria-label="选择渠道" data-testid="subsession-channels">
        {channels.map((p) => <button key={p.id} type="button" className="subsession-channel-tab" aria-pressed={p.id === profile.id} data-testid="subsession-channel" data-profile={p.id} onClick={() => { setSelection({ profileId: p.id, model: null }); setQuery(""); }}>
          <Mark profile={p} small /><span>{p.label}</span>{p.hidden && <span className="subsession-secondary">已隐藏</span>}<small>{notes.filter((n) => n.profileId === p.id && n.model !== null).length} 项</small>
        </button>)}
      </div>
      <div className="subsession-split">
        <nav key={profile.id} className="subsession-models" aria-label={`${profile.label} 的型号`}>
          <input className="field" type="search" value={query} placeholder="搜索型号…" aria-label="搜索子会话型号" onChange={(e) => setQuery(e.target.value)} />
          <button type="button" className="subsession-model" aria-current={pick.model === null ? "page" : undefined} aria-pressed={!!account && hasContent(account)} onClick={() => setSelection({ profileId: profile.id, model: null })} data-testid="subsession-chip" data-model="">
            <span><b>渠道通用设置</b><small>{defaultModel ? `默认型号：${modelName(defaultModel)}` : "所有型号的共用说明与选项"}</small></span>{account && hasContent(account) && <i className="subsession-configured-dot" aria-label="已设置" />}
          </button>
          <div className="subsession-models-label"><span>型号</span><span>{entries.length}</span></div>
          {filtered.map((e) => {
            const own = notes.find((n) => n.profileId === profile.id && n.model === e.model);
            const has = !!own && hasContent(own);
            const [title, ...source] = e.label.split(" · ");
            return <button key={e.model} type="button" className="subsession-model" aria-current={pick.model === e.model ? "page" : undefined} aria-pressed={has} title={e.label} onClick={() => setSelection({ profileId: profile.id, model: e.model })} data-testid="subsession-chip" data-model={e.model}>
              <span><b>{title}</b>{source.length > 0 && <small className="subsession-model-source">{source.join(" · ")}</small>}<small>{e.retired ? models.some((m) => m.id === e.model && m.isDefault) ? "原型号设置（现为默认）" : "已不在型号列表" : has ? "已单独设置" : "沿用默认"}</small></span>{has && <i className="subsession-configured-dot" aria-label="已设置" />}
            </button>;
          })}
          {filtered.length === 0 && <span className="subsession-list-empty">{query ? "没有匹配的型号" : models.length ? "此渠道使用默认型号，可在通用设置中配置。" : "正在读取型号，已保存的设置仍可编辑。"}</span>}
        </nav>
        <div ref={editor} className="subsession-editor" data-testid="subsession-note" data-model={pick.model ?? ""}>
          <header><div className="subsession-editor-title"><b>{name}</b><span className={`subsession-configured${configured ? "" : " inherited"}`}>{configured ? (pick.model ? "已单独设置" : "已设置") : "沿用默认"}</span></div><p className="settings-hint">{pick.model ? "仅为此型号设置，未指定的选项沿用默认。" : "用法、Fast 与权限适用于此渠道的所有型号。"}</p></header>
          <section className="subsession-editor-section"><div className="subsession-section-head"><b>启动选项</b><button type="button" className="link-btn" onClick={() => setDefaults(note, { effort: undefined, fast: undefined, permission: undefined })}>恢复默认选项</button></div>
            <NoteDefaults note={note} model={model} runtime={profile.runtime} account={account} onChange={(patch) => setDefaults(note, patch)} />
          </section>
          <section className="subsession-editor-section"><div className="subsession-section-head"><b>{pick.model ? "模型用法说明" : "渠道通用说明"}</b><span>给主模型看</span></div><p className="settings-hint">适合做什么、任务怎么交代、有哪些注意事项。</p>
            <textarea key={selectedKey} className="side-textarea" rows={4} maxLength={SUBSESSION_NOTE_MAX} aria-label={`${profile.label} ${name} 作为子会话的说明`} placeholder="例如：适合按计划改代码。交代时写清文件范围和验收方式。" value={textOf(note)} onChange={(e) => setDrafts((d) => ({ ...d, [selectedKey]: e.target.value }))} onBlur={() => commit(note)} data-testid="subsession-note-text" />
            <div className="subsession-text-footer"><span>离开输入框后保存</span><span>{textOf(note).length} / {SUBSESSION_NOTE_MAX}</span></div>
            {pick.model && account?.note && <div className="subsession-inherited-note"><span>渠道通用说明 · 未单独填写时使用</span><p>{account.note}</p></div>}
          </section>
          <footer className="subsession-editor-footer"><span role="status">{status}</span><button type="button" className="link-btn" disabled={!configured && !textOf(note)} onClick={() => remove(note)} data-testid="subsession-note-remove">{pick.model ? "清除单独设置" : "清除渠道通用设置"}</button></footer>
        </div>
      </div>
      {error && <span className="form-error" role="alert">{error}</span>}
    </section>
  );
}

function NoteDefaults({ note, model, runtime, account, onChange }: { note: SubsessionNote; model: ModelOption | undefined; runtime: ModelProfile["runtime"]; account?: SubsessionNote; onChange(patch: Defaults): void }) {
  const permission = note.permission ?? account?.permission;
  const hint = note.permission ? LEVELS.find((l) => l.id === note.permission)?.hint : note.model && account?.permission ? `沿用渠道：${LEVELS.find((l) => l.id === account.permission)?.label}` : "未指定时，按父会话与运行方式的默认规则。";
  return <div className="subsession-defaults" data-testid="subsession-defaults">
    <div className="subsession-default-field"><label htmlFor="subsession-effort">思考强度{note.model === null && <small>仅默认型号</small>}</label><div>
      {model?.efforts.length ? <select id="subsession-effort" className="field" value={note.effort ?? ""} onChange={(e) => onChange({ effort: e.target.value || undefined })}>
        <option value="">沿用模型默认{model.defaultEffort ? `（${effortLabel(model.defaultEffort)}）` : ""}</option>
        {note.effort && !model.efforts.includes(note.effort) && <option value={note.effort}>{note.effort}（当前型号不支持）</option>}
        {model.efforts.map((effort) => <option key={effort} value={effort}>{effort} · {effortLabel(effort)}</option>)}
      </select> : <span className="settings-hint">{model ? "此型号没有思考强度选项" : "此型号尚无可用的强度选项"}</span>}
    </div></div>
    {model?.fast && <div className="subsession-default-field"><span>Fast</span><div><div className="subsession-segments" role="group" aria-label="Fast" data-testid="subsession-default-fast">
      {([{ value: undefined, label: "沿用默认" }, { value: true, label: "开启" }, { value: false, label: "关闭" }] as const).map((option) => <button key={option.label} type="button" aria-pressed={note.fast === option.value} onClick={() => onChange({ fast: option.value })}>{option.label}</button>)}
    </div><small className="subsession-control-hint">{note.fast === undefined && note.model && account?.fast !== undefined ? `沿用渠道：${account.fast ? "开启" : "关闭"}。` : ""}{model.fast.description}</small></div></div>}
    <div className="subsession-default-field"><span>权限</span><div><div className="subsession-segments" role="group" aria-label="子会话默认权限">
      {LEVELS.map((l) => <button key={l.label} type="button" title={runtime === "pi" && l.id && l.id !== "full" ? "Pi 不支持只读或工作区沙箱" : l.hint} disabled={runtime === "pi" && l.id !== null && l.id !== "full"} aria-pressed={(note.permission ?? null) === l.id} onClick={() => onChange({ permission: l.id ?? undefined })} data-testid="subsession-default-permission">{l.label}</button>)}
    </div><small className="subsession-control-hint">{runtime === "pi" ? `Pi 仅支持完全访问。${permission === "full" ? "已允许主模型以完全访问启动。" : "选「完全访问」表示允许主模型以完全访问启动。"}` : hint}</small></div></div>
  </div>;
}
