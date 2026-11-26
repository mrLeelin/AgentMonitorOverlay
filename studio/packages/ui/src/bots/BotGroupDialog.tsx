import { useState } from "react";
import type { BotGroup, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotDialogHeader } from "./BotDialogHeader.js";

export function BotGroupDialog({ link, bots, group, onSaved, onClose }: { link: HostLink; bots: readonly StudioBot[]; group?: BotGroup; onSaved(group: BotGroup): void; onClose(): void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [members, setMembers] = useState(group?.memberIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visible = bots.filter((bot) => bot.enabled || group?.memberIds.includes(bot.id));
  const minimum = group && group.memberIds.length < 2 ? 1 : 2;
  const title = group ? "管理群组成员" : "新建群组";
  const canSave = !busy && name.trim() && members.length >= minimum;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const saved = group
        ? await call(link, "PATCH /api/bot-groups/:id", { id: group.id }, { memberIds: members })
        : await call(link, "POST /api/bot-groups", {}, { name, memberIds: members });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  return <Modal portal label={title} className="bot-dialog" backdropClassName="bot-backdrop" busy={busy} onClose={onClose} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <BotDialogHeader title={title} busy={busy} onClose={onClose} />
    {group ? <p className="settings-hint">{group.name}</p> : <label className="bot-form-field">群组名称<input className="field" autoFocus required maxLength={40} placeholder="为群组命名" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>}
    <fieldset className="bot-member-list">
      <legend>成员</legend>
      {visible.map((bot) => {
        const checked = members.includes(bot.id);
        return <label key={bot.id} className="bot-member">
          <BotAvatar name={bot.name} avatar={bot.avatar} size={30} />
          <span><strong>{bot.name}</strong><small>{bot.enabled ? bot.purpose : "已停用"}</small></span>
          <input type="checkbox" aria-label={bot.name} checked={checked} disabled={busy || (!checked && members.length >= 30)} onChange={() => setMembers(checked ? members.filter((id) => id !== bot.id) : [...members, bot.id])} />
        </label>;
      })}
      {!visible.length && <p className="settings-hint">先创建并启用群组成员。</p>}
    </fieldset>
    {error && <p className="form-error" role="alert">{error}</p>}
    <footer className="bot-dialog-actions">
      <span className="settings-hint">已选 {members.length} 个 · 至少 {minimum} 个 Bot</span>
      <button className="btn-ghost" type="button" disabled={busy} onClick={onClose}>取消</button>
      <button className="btn-primary" type="submit" disabled={!canSave}>{busy ? "保存中…" : group ? "保存群组" : "创建群组"}</button>
    </footer>
  </Modal>;
}
