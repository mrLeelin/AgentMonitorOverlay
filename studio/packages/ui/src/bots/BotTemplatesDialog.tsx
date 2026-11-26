import { useState } from "react";
import { IconSearch } from "../chat/icons.js";
import { Modal } from "../lib/Modal.js";
import { BotAvatar } from "./BotAvatar.js";
import { BotDialogHeader } from "./BotDialogHeader.js";
import { BOT_TEMPLATES, BOT_TEMPLATE_CATEGORIES, type BotTemplate } from "./templates.js";

export function BotTemplatesDialog({ onUse, onBlank, onLink, onClose }: { onUse(template: BotTemplate): void; onBlank(): void; onLink(): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [picked, setPicked] = useState(BOT_TEMPLATES[0]!.id);
  const term = query.normalize("NFKC").trim().toLowerCase();
  const rows = BOT_TEMPLATES.filter((row) => (category === "全部" || category === row.category) && `${row.title} ${row.name} ${row.description} ${row.category}`.toLowerCase().includes(term));
  const selected = rows.find((row) => row.id === picked) ?? rows[0];
  return <Modal portal label="Bot 模板" className="bot-dialog bot-template-dialog" backdropClassName="bot-backdrop" onClose={onClose}>
    <BotDialogHeader title="Bot 模板" onClose={onClose} />
    <div className="bot-template-tools">
      <label className="bot-search-box"><IconSearch /><input autoFocus value={query} aria-label="搜索模板" placeholder="搜索模板" onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" className="btn-ghost small" onClick={onLink}>从链接创建</button>
      <button type="button" className="btn-ghost small" onClick={onBlank}>空白 Bot</button>
    </div>
    <div className="bot-template-categories" role="group" aria-label="模板分类">
      {["全部", ...BOT_TEMPLATE_CATEGORIES].map((item) => <button key={item} type="button" aria-pressed={category === item} className="btn-ghost small" onClick={() => setCategory(item)}>{item}</button>)}
    </div>
    <div className="bot-template-grid">
      <div className="bot-template-list" role="group" aria-label="Bot 模板列表">
        {rows.map((row) => <button key={row.id} type="button" aria-pressed={row.id === selected?.id} className="bot-template-row" onClick={() => setPicked(row.id)}>
          <BotAvatar name={row.name} size={33} />
          <span><strong>{row.title}</strong><small>{row.description}</small></span>
        </button>)}
        {!rows.length && <p role="status" className="settings-hint">没有符合条件的模板。</p>}
      </div>
      {selected && <aside className="bot-template-info" aria-label="模板详情">
        <div className="bot-identity"><BotAvatar name={selected.name} size={44} /><div><h3>{selected.title}</h3><span className="settings-hint">{selected.category}</span></div></div>
        <div><strong>职责</strong><p>{selected.purpose}</p></div>
        <div className="bot-template-example"><strong>可以这样问</strong><p>{selected.example}</p></div>
        <button type="button" className="btn-primary" onClick={() => onUse(selected)}>使用模板</button>
      </aside>}
    </div>
  </Modal>;
}
