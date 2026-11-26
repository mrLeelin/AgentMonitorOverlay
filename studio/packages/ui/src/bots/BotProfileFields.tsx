import { botMascotAvatar, botMascotId, defaultBotPermission, PICKABLE_BOT_MASCOT_IDS, projectWorkspaces, type BotInput, type ModelProfile, type Workspace } from "@amo-studio/protocol";
import { useId, useRef, useState } from "react";
import { IconChevronDown, IconChevronRight, IconEnvironment } from "../chat/icons.js";
import { EffortPicker } from "../chat/EffortPicker.js";
import { FastToggle, Mark, PermissionTiles } from "../chat/pickers.js";
import { ModelDrawer } from "../newtask/ModelRow.js";
import { BotAvatar, botMascotUrl, encodeBotAvatar, randomBotMascot } from "./BotAvatar.js";
import { botProfiles } from "./roster.js";
import type { HostLink } from "../host/client.js";
import { activeModel, effortLabel, modelName, useChoicesFor, useProfileChoices } from "../lib/choices.js";

export type ChangeBotDraft = <K extends keyof BotInput>(field: K, value: BotInput[K]) => void;
export type BotMarkdownField = "purpose" | "memory";

export async function readBotMarkdown(field: BotMarkdownField, file: File): Promise<string> {
  const max = field === "purpose" ? 8000 : 32_000;
  if (file.size > max * 4) throw new Error(`Markdown 最多 ${max} 个字符。`);
  const text = await file.text();
  if (text.length > max) throw new Error(`Markdown 最多 ${max} 个字符。`);
  return text;
}

export function BotAvatarPicker({ draft, busy, change, run }: { draft: Pick<BotInput, "name" | "avatar">; busy: boolean; change: ChangeBotDraft; run(action: () => Promise<void>): Promise<void> }) {
  const [open, setOpen] = useState(false);
  const gridId = useId();
  const current = botMascotId(draft.avatar);
  // 形象网格作为同级元素放在名称后面，由外层的 flex-wrap 换到下一整行，窄的头像列放不下它。
  return <>
    <div className="bot-avatar-picker" data-testid="bot-avatar-preview">
      <button type="button" className="bot-avatar-trigger" aria-expanded={open} aria-controls={gridId} aria-label="选择形象" title="选择形象" disabled={busy} onClick={() => setOpen((value) => !value)}>
        <BotAvatar name={draft.name} avatar={draft.avatar} size={54} />
      </button>
      <button className="link-btn" type="button" onClick={() => change("avatar", randomBotMascot(draft.avatar))} disabled={busy}>换一个</button>
      <label className="btn-ghost small bot-import">上传图片<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传头像图片" disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void run(async () => change("avatar", await encodeBotAvatar(file)));
      }} /></label>
      {draft.avatar && <button className="link-btn" type="button" onClick={() => change("avatar", null)} disabled={busy}>恢复默认头像</button>}
    </div>
    {open && <div className="bot-mascot-grid" id={gridId} role="radiogroup" aria-label="形象">
      {PICKABLE_BOT_MASCOT_IDS.map((id) => <button key={id} type="button" role="radio" aria-checked={current === id} aria-label={`形象 ${id}`} disabled={busy} onClick={() => change("avatar", botMascotAvatar(id))}>
        <img src={botMascotUrl(id)} alt="" draggable={false} />
      </button>)}
    </div>}
  </>;
}

export function BotModelField({ link, profiles, draft, change, disabled }: { link: HostLink; profiles: readonly ModelProfile[]; draft: BotInput; change: ChangeBotDraft; disabled: boolean }) {
  const choices = botProfiles(profiles);
  const current = profiles.find((profile) => profile.id === draft.profileId);
  const { choices: catalog, error } = useProfileChoices(link, draft.profileId);
  const model = catalog ? activeModel(catalog, { model: draft.model ?? undefined }) : undefined;
  const [open, setOpen] = useState(false);
  const drawerId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const catalogs = useChoicesFor(link, open ? choices.map((p) => p.id) : []);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const title = modelName(model) ?? draft.model ?? current?.label ?? "选择模型";
  const readOnlyPermission = defaultBotPermission(current?.runtime ?? "");
  const loadingCatalog = !!current && !catalog && !error;
  const effortHint = draft.effort ? `${effortLabel(draft.effort)} · 已保存` : loadingCatalog ? "正在读取…" : "此型号不提供强度设置";
  const fastProps = { fast: model?.fast, value: draft.fast ?? undefined, onChange: (fast: boolean) => change("fast", fast), disabled };
  const pickModel = (profileId: string, modelId: string | null) => {
    if (draft.profileId !== profileId || (draft.model ?? null) !== modelId) {
      if (draft.profileId !== profileId) change("permission", null);
      change("profileId", profileId);
      change("model", modelId);
      change("effort", null);
      change("fast", null);
    }
    close();
  };
  return <>
    <div className="bot-form-field" onKeyDown={(e) => {
      if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    }}>
      <span>模型</span>
      <button ref={trigger} type="button" className="field bot-model-trigger" aria-label={`选择模型：${title}`} aria-expanded={open} aria-controls={open ? drawerId : undefined}
        disabled={disabled} onClick={() => setOpen(!open)}>
        <Mark profile={current} small /><strong>{title}</strong>
        {current && title !== current.label && <small>{current.label}</small>}
        {open ? <IconChevronDown /> : <IconChevronRight />}
      </button>
      {open && <fieldset id={drawerId} className="bot-model-drawer" disabled={disabled} aria-label="全部型号">
        <ModelDrawer profiles={choices} choices={catalogs} pick={{ profileId: draft.profileId, model: draft.model ?? null }}
          onPick={(next) => pickModel(next.profileId, next.model)} />
        {draft.model && <button type="button" className="link-btn" onClick={() => pickModel(draft.profileId, null)}>跟随当前渠道默认型号</button>}
        {!choices.length && <small className="settings-hint">暂无可用的 Bot 模型渠道。</small>}
      </fieldset>}
    </div>
    <div className="bot-effort-field">
      <span>推理强度</span>
      {model?.efforts.length ? <EffortPicker key={draft.profileId + "/" + model.id} efforts={model.efforts} value={draft.effort ?? null}
        fallback={model.defaultEffort} modelLabel={title} fastControl={<FastToggle {...fastProps} iconOnly />} disabled={disabled}
        onChange={(effort) => change("effort", effort)} onOpen={() => setOpen(false)} onModel={() => { setOpen(true); trigger.current?.focus(); }} />
        : <><small className="settings-hint">{effortHint}</small><FastToggle {...fastProps} small /></>}
    </div>
    <div className="bot-permission-panel">
      <div className="tray-h">权限 <span className="tray-note">新聊天生效</span></div>
      {catalog?.permissions.length ? <PermissionTiles choices={catalog} value={draft.permission ?? readOnlyPermission} onChange={(id) => change("permission", id)} disabled={disabled}
        descriptions={{ [readOnlyPermission]: "只读项目文件，不能写入" }} />
        : <small className="settings-hint">{loadingCatalog ? "正在读取…" : "暂无可选权限"}</small>}
    </div>
    {error && <small className="form-error">{error}</small>}
  </>;
}

export function BotLocalFields({ workspaces, draft, change, disabled }: { workspaces: readonly Workspace[]; draft: BotInput; change: ChangeBotDraft; disabled: boolean }) {
  return <div className="bot-form-grid">
    <div className="bot-form-field"><span>运行位置</span><span className="bot-device-field"><IconEnvironment /> 本地 Windows</span></div>
    <label className="bot-form-field">默认项目
      <select className="field" value={draft.workspaceId ?? ""} disabled={disabled} onChange={(event) => change("workspaceId", event.target.value || null)}>
        <option value="">公共目录</option>
        {projectWorkspaces(workspaces).map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>
    </label>
  </div>;
}
