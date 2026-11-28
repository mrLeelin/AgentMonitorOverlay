import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BotFiles, StudioBot } from "@amo-studio/protocol";
import { IconChevronDown, IconChevronRight, IconCopy, IconOpenWindow, IconRead, IconSearch, IconX } from "../chat/icons.js";
import { call, copyText, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { ActionMenu } from "../lib/ActionMenu.js";
import { revealInExplorer } from "../lib/openin.js";
import { showToast } from "../lib/toast.js";
import "./BotWorkspaceFiles.css";

type FileSnapshot = { files: BotFiles; documents: { name: string; text: string }[] };
type NoteSearch = { snapshot: FileSnapshot; query: string; matches: Set<string>; unreadable: number };
type NotePreview = { snapshot: FileSnapshot; path: string; text?: string; error?: string };

export function BotWorkspaceFiles({ link, bot }: { link: HostLink; bot: StudioBot }) {
  return <BotFileBrowser key={bot.id} link={link} botId={bot.id} />;
}

function BotFileBrowser({ link, botId }: { link: HostLink; botId: string }) {
  const [snapshot, setSnapshot] = useState<FileSnapshot>();
  const [refreshing, setRefreshing] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState<"name" | "content">("name");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [noteSearch, setNoteSearch] = useState<NoteSearch>();
  const [preview, setPreview] = useState<NotePreview>();
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLButtonElement }>();
  const term = query.trim().toLocaleLowerCase();
  const contentTerm = mode === "content" ? term : "";
  const noteName = selected?.startsWith("memory/") ? selected.slice("memory/".length) : undefined;
  const refresh = () => setRevision((n) => n + 1);

  useEffect(() => {
    const reload = () => setRevision((n) => n + 1);
    const offEvent = onHostEvent((event) => {
      if (event.type === "bots.changed" || (event.type === "bot-files.changed" && event.botId === botId)) reload();
    });
    const offReconnect = onHostReconnect(reload);
    return () => { offEvent(); offReconnect(); };
  }, [botId]);

  useEffect(() => {
    let current = true;
    setRefreshing(true);
    setLoadError("");
    // The Bot record reads the two root documents from disk, including changes made in an external editor.
    void Promise.all([call(link, "GET /api/bots/:id/files", { id: botId }), call(link, "GET /api/bots")]).then(([files, bots]) => {
      if (!current) return;
      const record = bots.find((item) => item.id === botId);
      if (!record) throw new Error("找不到这个 Bot。");
      setSnapshot({ files, documents: [{ name: "MEMORY.md", text: record.memory }, { name: "SOUL.md", text: record.purpose }] });
      setSelected((path) => path?.startsWith("memory/") && !files.notes.includes(path.slice("memory/".length)) ? undefined : path);
    }).catch((error: unknown) => {
      if (current) setLoadError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current) setRefreshing(false); });
    return () => { current = false; };
  }, [link, botId, revision]);

  useEffect(() => {
    if (!snapshot || !contentTerm || !snapshot.files.notes.length) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      const matches = new Set<string>();
      let unreadable = 0;
      // Limit concurrent reads and stop scheduling when the search changes or the file tab closes.
      for (let start = 0; current && start < snapshot.files.notes.length; start += 3) {
        const batch = snapshot.files.notes.slice(start, start + 3);
        const outcomes = await Promise.allSettled(batch.map((name) => call(link, "GET /api/bots/:id/notes/:name", { id: botId, name })));
        outcomes.forEach((outcome, index) => {
          if (outcome.status === "rejected") unreadable++;
          else if (outcome.value.text.toLocaleLowerCase().includes(contentTerm)) matches.add(batch[index]!);
        });
      }
      if (current) setNoteSearch({ snapshot, query: contentTerm, matches, unreadable });
    }, 180);
    return () => { current = false; window.clearTimeout(timer); };
  }, [link, botId, snapshot, contentTerm]);

  useEffect(() => {
    if (!snapshot || !noteName || !snapshot.files.notes.includes(noteName)) return;
    let current = true;
    const path = `memory/${noteName}`;
    void call(link, "GET /api/bots/:id/notes/:name", { id: botId, name: noteName }).then(
      ({ text }) => { if (current) setPreview({ snapshot, path, text }); },
      (error: unknown) => { if (current) setPreview({ snapshot, path, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { current = false; };
  }, [link, botId, snapshot, noteName]);

  const matchingNotes = noteSearch?.snapshot === snapshot && noteSearch?.query === contentTerm ? noteSearch : undefined;
  const notes = snapshot?.files.notes.filter((name) => contentTerm ? matchingNotes?.matches.has(name) : `memory/${name}`.toLocaleLowerCase().includes(term)) ?? [];
  const documents = snapshot?.documents.filter((file) => (mode === "content" ? file.text : file.name).toLocaleLowerCase().includes(term)) ?? [];
  const showMemory = !!snapshot && (!term || notes.length > 0 || (mode === "name" && "memory/".includes(term)));
  const showNotes = term ? notes.length > 0 : expanded;
  const searching = !!(contentTerm && snapshot?.files.notes.length && !matchingNotes);
  const selectedPreview = preview?.snapshot === snapshot && preview?.path === selected ? preview : undefined;
  const text = noteName ? selectedPreview?.text : snapshot?.documents.find((file) => file.name === selected)?.text;

  function fileRow(path: string, name: string, inFolder = false) {
    return <button key={path} type="button" className="bot-files-row" data-child={inFolder || undefined} aria-pressed={selected === path} title={path} onClick={() => setSelected(path)}><IconRead /><span>{name}</span></button>;
  }

  function closeMenu() {
    if (document.activeElement?.closest(".action-menu")) menu?.trigger.focus({ preventScroll: true });
    setMenu(undefined);
  }

  function openFolder(folder: string) {
    void revealInExplorer(link, { path: folder }).catch((error: unknown) => showToast({ text: String(error), error: true }));
  }

  return <section className="bot-workspace-files" aria-label="Bot 文件">
    <header className="bot-files-top"><strong>Bot 资料目录</strong><div>
      <button type="button" className="bot-icon-button" aria-label="刷新文件" title="刷新文件" disabled={refreshing} onClick={refresh}>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.5 6A5.8 5.8 0 0 0 3 4.2L2.5 6m0-3.4V6H6m-3.5 4A5.8 5.8 0 0 0 13 11.8l.5-1.8m0 3.4V10H10" /></svg>
      </button>
      <button type="button" className="bot-icon-button" aria-label="文件操作" title="文件操作" aria-haspopup="menu" aria-expanded={!!menu} disabled={!snapshot} onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu(menu ? undefined : { x: rect.right - 150, y: rect.bottom + 4, trigger: event.currentTarget });
      }}><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1" /><circle cx="8" cy="8" r="1" /><circle cx="12.5" cy="8" r="1" /></svg></button>
    </div></header>
    <div className="bot-files-filter">
      <div className="bot-files-segments" role="group" aria-label="查找方式">
        <button type="button" aria-pressed={mode === "name"} onClick={() => setMode("name")}>名称</button>
        <button type="button" aria-pressed={mode === "content"} onClick={() => setMode("content")}>内容</button>
      </div>
      <div className="bot-search-box"><IconSearch /><input type="search" aria-label={mode === "name" ? "查找文件" : "搜索文件内容"} placeholder={mode === "name" ? "查找文件" : "搜索文件内容"} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
    </div>
    {loadError && <p className="bot-files-hint form-error" role="alert">{loadError}</p>}
    <div className="bot-files-body" data-preview={!!selected || undefined}>
      <div className="bot-files-list" role="group" aria-label="资料文件" aria-busy={refreshing || searching}>
        {showMemory && <>
          <button type="button" className="bot-files-row" aria-expanded={showNotes} disabled={!!term} onClick={() => setExpanded(!expanded)}>
            {showNotes ? <IconChevronDown /> : <IconChevronRight />}
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" /></svg><span>memory</span>
          </button>
          {showNotes && notes.map((name) => fileRow(`memory/${name}`, name, true))}
        </>}
        {documents.map(({ name }) => fileRow(name, name))}
        {searching && <p className="bot-files-hint" role="status">正在查找文件内容…</p>}
        {matchingNotes && matchingNotes.unreadable > 0 && <p className="bot-files-hint" role="status">有 {matchingNotes.unreadable} 个文件无法读取。</p>}
        {!searching && term && snapshot && !showMemory && !documents.length && <p className="bot-files-hint">没有匹配的文件。</p>}
        {refreshing && !snapshot && <p className="bot-files-hint" role="status">正在读取文件…</p>}
      </div>
      {selected && <section className="bot-files-preview" aria-label="文件预览">
        <header><strong title={selected}>{selected}</strong><button type="button" className="bot-icon-button" aria-label="关闭预览" onClick={() => setSelected(undefined)}><IconX /></button></header>
        {text !== undefined ? text ? <pre>{text}</pre> : <p className="bot-files-hint">文件为空。</p>
          : selectedPreview?.error ? <p className="bot-files-hint form-error" role="alert">{selectedPreview.error}</p> : <p className="bot-files-hint" role="status">正在读取文件…</p>}
      </section>}
    </div>
    {menu && snapshot && createPortal(<ActionMenu label="文件操作" at={menu} onClose={closeMenu} focus groups={[[
      { label: "打开资料目录", icon: <IconOpenWindow />, run: () => openFolder(snapshot.files.folder) },
      { label: "复制资料目录路径", icon: <IconCopy />, run: () => void copyText(snapshot.files.folder).then(() => showToast({ text: "已复制资料目录路径" }), (error: unknown) => showToast({ text: String(error), error: true })) },
    ]]} />, document.body)}
  </section>;
}
