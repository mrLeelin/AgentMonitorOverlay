import { IconX } from "../chat/icons.js";

export function BotDialogHeader({ title, busy, onClose }: { title: string; busy?: boolean; onClose(): void }) {
  return <header className="bot-dialog-head">
    <h2>{title}</h2>
    <button type="button" className="bot-icon-button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}><IconX /></button>
  </header>;
}
