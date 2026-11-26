import { useState } from "react";
import type { BotDraftContent, BotGroup, BotInput, ModelProfile, StudioBot, Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { BotDialogHeader } from "./BotDialogHeader.js";
import { BotGroupDialog } from "./BotGroupDialog.js";
import { BotAvatarPicker, BotLocalFields, BotModelField, readBotMarkdown, type BotMarkdownField } from "./BotProfileFields.js";
import { BotTemplatesDialog } from "./BotTemplatesDialog.js";
import { newBotDraft } from "./roster.js";

export type BotCreationEntry = "blank" | "group" | "templates" | "link" | "import";

export function BotCreation({ entry, link, bots, profiles, workspaces, onBot, onGroup, onClose }: {
  entry: BotCreationEntry; link: HostLink; bots: readonly StudioBot[]; profiles: readonly ModelProfile[]; workspaces: readonly Workspace[];
  onBot(bot: StudioBot): void; onGroup?(group: BotGroup): void; onClose(): void;
}) {
  const [page, setPage] = useState(entry);
  const [draft, setDraft] = useState(() => newBotDraft(profiles));
  const [source, setSource] = useState("");
  const [share, setShare] = useState("");
  const [imported, setImported] = useState<Partial<Record<BotMarkdownField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = <K extends keyof BotInput>(field: K, value: BotInput[K]) => setDraft((current) => ({ ...current, [field]: value }));

  function open(next: BotCreationEntry) {
    setError("");
    setPage(next);
  }

  function useContent(content: BotDraftContent, from: string) {
    setDraft((current) => ({ ...current, ...content }));
    setSource(from);
    open("blank");
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  const canCreate = !busy && !!draft.name.trim() && !!draft.purpose.trim() && !!draft.profileId;
  const create = () => {
    if (canCreate) void run(async () => onBot(await call(link, "POST /api/bots", {}, draft)));
  };
  const closeButton = <button className="btn-ghost" type="button" disabled={busy} onClick={onClose}>取消</button>;
  const problem = error && <p className="form-error" role="alert">{error}</p>;

  if (page === "group") return <BotGroupDialog link={link} bots={bots} onSaved={(group) => { onGroup?.(group); onClose(); }} onClose={onClose} />;
  if (page === "templates") return <BotTemplatesDialog onUse={(template) => useContent({ name: template.name, purpose: template.purpose, memory: "", avatar: null }, template.title)} onBlank={() => open("blank")} onLink={() => open("link")} onClose={onClose} />;
  if (page === "link") return <Modal portal label="从链接创建" className="bot-dialog bot-link-dialog" backdropClassName="bot-backdrop" busy={busy} onClose={onClose} onSubmit={(event) => {
    event.preventDefault();
    if (share.trim()) void run(async () => useContent(await call(link, "POST /api/bots/import-link", {}, { url: share.trim() }), "Orca 分享"));
  }}>
    <BotDialogHeader title="从链接创建" busy={busy} onClose={onClose} />
    <label className="bot-form-field">Bot 分享链接
      <input className="field" autoFocus required type="text" inputMode="url" maxLength={2048} placeholder="https://app.orca.dev/bots/share/…" value={share} disabled={busy} onChange={(event) => { setShare(event.target.value); setError(""); }} />
    </label>
    <p className="settings-hint">继续后可以查看并修改分享中的名称、职责和记忆。</p>
    {problem}
    <footer className="bot-dialog-actions">{closeButton}<button className="btn-primary" type="submit" disabled={busy || !share.trim()}>{busy ? "读取中…" : "继续"}</button></footer>
  </Modal>;
  if (page === "import") return <Modal portal label="从其他应用导入" className="bot-dialog bot-link-dialog" backdropClassName="bot-backdrop" busy={busy} onClose={onClose} onSubmit={(event) => {
    event.preventDefault();
    if (imported.purpose || imported.memory) useContent({ name: draft.name, purpose: imported.purpose ?? draft.purpose, memory: imported.memory ?? draft.memory }, "Markdown 文件");
  }}>
    <BotDialogHeader title="从其他应用导入" busy={busy} onClose={onClose} />
    <p className="settings-hint">选择原 Bot 的职责或记忆文件。</p>
    {([["purpose", "SOUL.md（职责）"], ["memory", "MEMORY.md（记忆）"]] as const).map(([field, label]) => <label key={field} className="bot-form-field">{label}
      <input className="field bot-file-field" type="file" accept=".md,.txt,text/markdown,text/plain" disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        setImported((current) => ({ ...current, [field]: undefined }));
        if (file) {
          void run(async () => {
            const value = await readBotMarkdown(field, file);
            setImported((current) => ({ ...current, [field]: value }));
          });
        }
      }} />
    </label>)}
    {problem}
    <footer className="bot-dialog-actions">{closeButton}<button className="btn-primary" type="submit" disabled={busy || (!imported.purpose && !imported.memory)}>继续</button></footer>
  </Modal>;

  return <Modal portal label="新建 Bot" className="bot-dialog bot-create-dialog" backdropClassName="bot-backdrop" busy={busy} onClose={onClose}
    onSubmit={(event) => { event.preventDefault(); create(); }}
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        create();
      }
    }}
  >
    <BotDialogHeader title="新建 Bot" busy={busy} onClose={onClose} />
    <div className="bot-create-identity">
      <BotAvatarPicker draft={draft} busy={busy} change={change} run={run} />
      <label className="bot-form-field">名称<input className="field" autoFocus required maxLength={40} placeholder="给 Bot 起个名字" value={draft.name} disabled={busy} onChange={(event) => change("name", event.target.value)} /></label>
    </div>
    {source && <p className="bot-source" role="status">来源 · {source}</p>}
    <label className="bot-form-field">职责<textarea className="field" rows={4} required maxLength={8000} placeholder="它负责什么，怎样给出结果" value={draft.purpose} disabled={busy} onChange={(event) => change("purpose", event.target.value)} /></label>
    {source && (draft.memory || source === "Orca 分享" || source === "Markdown 文件") && <label className="bot-form-field">记忆
      <textarea className="field" rows={3} maxLength={32_000} value={draft.memory} disabled={busy} onChange={(event) => change("memory", event.target.value)} />
    </label>}
    <BotModelField link={link} profiles={profiles} draft={draft} change={change} disabled={busy} />
    <BotLocalFields workspaces={workspaces} draft={draft} change={change} disabled={busy} />
    {problem}
    <footer className="bot-dialog-actions">
      <button type="button" className="btn-ghost left" disabled={busy} onClick={() => open("templates")}>模板</button>
      {closeButton}
      <button type="submit" className="btn-primary" disabled={!canCreate}>{busy ? "创建中…" : "创建"}</button>
    </footer>
  </Modal>;
}
