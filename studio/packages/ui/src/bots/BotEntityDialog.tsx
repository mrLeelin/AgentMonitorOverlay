import { useState } from "react";
import type { BotGroup, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { ConfirmDialog } from "../lib/ConfirmDialog.js";
import { Modal } from "../lib/Modal.js";
import { BotDialogHeader } from "./BotDialogHeader.js";
import { BotGroupDialog } from "./BotGroupDialog.js";

export type BotEntity = { kind: "bot"; item: StudioBot } | { kind: "group"; item: BotGroup };
export type BotEntityEdit = { action: "rename" | "delete"; entity: BotEntity } | { action: "members"; entity: Extract<BotEntity, { kind: "group" }> };

export function BotEntityDialog({ link, bots, edit, onClose, onDeleted }: { link: HostLink; bots: readonly StudioBot[]; edit: BotEntityEdit; onClose(): void; onDeleted(entity: BotEntity): void }) {
  const { entity } = edit;
  const [name, setName] = useState(entity.item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const group = entity.kind === "group";
  const params = { id: entity.item.id };
  const noun = group ? "群组" : " Bot";

  async function apply(action: "rename" | "delete") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (action === "delete") {
        await call(link, group ? "DELETE /api/bot-groups/:id" : "DELETE /api/bots/:id", params);
        onDeleted(entity);
      } else {
        if (!name.trim()) return;
        await call(link, group ? "PATCH /api/bot-groups/:id" : "PATCH /api/bots/:id", params, { name });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  if (edit.action === "members") return <BotGroupDialog link={link} bots={bots} group={edit.entity.item} onClose={onClose} onSaved={onClose} />;

  const problem = error && <p className="form-error" role="alert">{error}</p>;
  if (edit.action === "delete") return <ConfirmDialog title={`删除${noun}`} action="删除" danger busy={busy} onCancel={onClose} onConfirm={() => void apply("delete")}>
    <p>{group ? `将删除「${entity.item.name}」及其群聊记录。成员各自的会话可从 Bot 聊天记录查看。` : `将删除「${entity.item.name}」的配置和记忆，并从群组中移除它。历史回复仍可查看。`}</p>
    {problem}
  </ConfirmDialog>;

  const title = `重命名${noun}`;
  return <Modal portal label={title} className="bot-dialog" backdropClassName="bot-backdrop" busy={busy} onClose={onClose} onSubmit={(event) => { event.preventDefault(); void apply("rename"); }}>
    <BotDialogHeader title={title} busy={busy} onClose={onClose} />
    <label className="bot-form-field">{group ? "群组名称" : "Bot 名称"}<input className="field" autoFocus required maxLength={40} value={name} disabled={busy} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setName(event.target.value)} /></label>
    {problem}
    <footer className="bot-dialog-actions">
      <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>取消</button>
      <button type="submit" className="btn-primary" disabled={busy || !name.trim() || name.trim() === entity.item.name}>保存</button>
    </footer>
  </Modal>;
}
