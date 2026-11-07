import { useEffect, useMemo, useRef, useState } from "react";
import { composeGitReviewMessage, type GitChangedFile, type GitReviewComment, type Workspace } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { buildTranscript, segmentMembers } from "../chat/turns.js";
import { turnChanges, type ChangedFile } from "../files/changes.js";
import { fileName } from "../files/paths.js";
import { showToast } from "../lib/toast.js";
import { TitleMark, WindowControls } from "../shell/WindowControls.js";
import { openViewer } from "../viewer/open.js";
import { DiffView } from "./DiffView.js";
import { FileList, Splitter } from "./FileList.js";
import { dropDraft, newDraftKey } from "./drafts.js";
import { diffRows, step } from "./logic.js";
import { diffText, typingIn, useSelectAll } from "./selectAll.js";
import { useDiffTokens } from "./tokens.js";
import { turnDiff } from "./turnDiff.js";

type TurnComment = GitReviewComment & { rowKey: string };

/** A finished turn's saved edits, independent of the working tree and later turns. */
export function TurnReview({ link, workspace, sessionId, turnItemId, file, nonce }: { link: HostLink; workspace: Workspace; sessionId: string; turnItemId: string; file: string | null; nonce: string }) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(file);
  const [split, setSplit] = useState(false);
  const [width, setWidth] = useState(300);
  const [comments, setComments] = useState<TurnComment[]>([]);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scope = `turn:${sessionId}:${turnItemId}`;

  useEffect(() => {
    document.title = `本轮改动 · Review · ${workspace.name}`;
  }, [workspace.name]);
  useEffect(() => {
    let live = true;
    call(link, "GET /api/sessions/:id/items", { id: sessionId }).then((items) => {
      if (!live) return;
      const members = buildTranscript(items, false).map(segmentMembers).find((items) => items.some((item) => item.id === turnItemId));
      if (!members) throw new Error("找不到这一轮的记录。");
      const changes = turnChanges(members);
      setFiles(changes);
      setSelected((current) => changes.some((f) => f.path === current) ? current : changes[0]?.path ?? null);
    }).catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    return () => { live = false; };
  }, [link, sessionId, turnItemId]);
  useEffect(() => {
    if (file) setSelected(file);
    setDraftAt(null);
    setActive(null);
  }, [file, nonce]);
  useEffect(() => {
    setDraftAt(null);
    setActive(null);
    scroller.current?.scrollTo({ top: 0 });
  }, [selected]);

  const listed = useMemo<GitChangedFile[]>(() => (files ?? []).map((f) => ({ path: f.path, status: f.change === "add" ? "added" : f.change === "delete" ? "deleted" : "modified", additions: f.added, deletions: f.removed, binary: false })), [files]);
  const shown = files?.find((f) => f.path === selected) ?? null;
  const diff = useMemo(() => shown ? turnDiff(shown) : null, [shown]);
  // Repeated edits can reuse a source line number. Keep each recorded occurrence independently addressable.
  const rows = useMemo(() => diff ? diffRows(diff, "changes").map((r, i) => ({ ...r, key: `${r.key}:${i}` })) : [], [diff]);
  const tokens = useDiffTokens(diff);
  const placed = useMemo(() => {
    const map = new Map<string, TurnComment[]>();
    for (const c of comments) if (c.path === selected) map.set(c.rowKey, [...(map.get(c.rowKey) ?? []), c]);
    return map;
  }, [comments, selected]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of comments) map.set(c.path, (map.get(c.path) ?? 0) + 1);
    return map;
  }, [comments]);
  const draftKey = (row: string) => newDraftKey(scope, selected ?? "", row);
  useSelectAll(true, () => scroller.current?.querySelector<HTMLElement>(".gr-lines") ?? null, () => diffText(rows));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "e") { e.preventDefault(); setSplit((s) => !s); }
      if (key === "j" || key === "k") {
        const index = files?.findIndex((f) => f.path === selected) ?? -1;
        const next = step((files ?? []).map((_, i) => i), index, key === "j" ? 1 : -1);
        if (next !== null && files) { e.preventDefault(); setSelected(files[next]!.path); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [files, selected]);

  async function copy(close: boolean) {
    setBusy(true);
    try {
      await copyText(`【本轮改动批注】\n${composeGitReviewMessage(comments, workspace.name)}`);
      setComments([]);
      if (close) window.close();
    } catch (err) {
      showToast({ text: String(err), error: true });
    } finally { setBusy(false); }
  }

  return (
    <div className="gr-app" data-testid="turn-review">
      <header className="gr-head titlebar">
        <TitleMark />
        <span className="gr-title">Review</span>
        <span className="gr-project">{workspace.name}</span>
        <span data-testid="review-scope">本轮改动</span>
        <span className="spacer" />
        <div className="gr-seg" role="group" aria-label="显示方式">
          <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>单栏</button>
          <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>左右对照</button>
        </div>
        <WindowControls />
      </header>
      <div className="gr-body">
        <nav className="gr-files" aria-label="本轮改动的文件" style={{ width }}>
          <div className="gr-files-head">{files ? `${files.length} 个文件` : "正在读取…"}</div>
          <div className="gr-files-hint gr-dim">J / K 切换文件，E 切换单栏 / 左右对照</div>
          <FileList files={listed} layout="flat" selected={selected} perFile={counts} closed={new Set()} onToggle={() => undefined} onSelect={setSelected} onMenu={(f) => setSelected(f.path)} />
        </nav>
        <Splitter width={width} onChange={setWidth} />
        <section className="gr-diff" aria-label="本轮文件改动">
          {shown && (
            <div className="gr-file-head" data-testid="review-file-head">
              <code title={shown.path}>{fileName(shown.path)}</code>
              <span className="gr-dim">本轮改动</span>
              <span className="spacer" />
              <span className="add">+{shown.added}</span>
              <span className="del">−{shown.removed}</span>
              <button type="button" className="btn-ghost small" onClick={() => openViewer({ path: shown.path, workspaceId: workspace.id, sessionId })} data-testid="review-open-viewer">
                查看当前文件
              </button>
            </div>
          )}
          <div className="gr-scroll-wrap"><div className="gr-scroll" ref={scroller}>
            {error && <div className="gr-notice" role="alert">{error}</div>}
            {!files && !error && <div className="gr-notice">正在读取本轮改动…</div>}
            {files && !shown && <div className="gr-notice">这一轮没有这个文件的改动记录。</div>}
            {shown && !rows.length && <div className="gr-notice">这一轮记录了文件改动，但没有保存差异内容。</div>}
            {diff && rows.length > 0 && <DiffView
              diff={diff}
              rows={rows}
              split={split}
              tokens={tokens}
              placed={placed}
              elsewhere={[]}
              showSent={false}
              draftAt={draftAt}
              active={active}
              busy={busy}
              draftKey={draftKey}
              onDraft={setDraftAt}
              onActivate={setActive}
              onAdd={(row, note) => {
                setComments((cs) => [...cs, { id: crypto.randomUUID(), workspaceId: workspace.id, range: "working", path: diff.path, side: row.side, line: row.number, lineText: row.line.text, note, state: "draft", sessionId, createdAt: "", updatedAt: "", sentAt: null, rowKey: row.key }]);
                dropDraft(draftKey(row.key));
                setDraftAt(null);
              }}
              onEdit={(id, note) => setComments((cs) => cs.map((c) => c.id === id ? { ...c, note } : c))}
              onDelete={(id) => setComments((cs) => cs.filter((c) => c.id !== id))} onLocate={() => undefined} />}
          </div></div>
        </section>
      </div>
      <footer className="gr-bar">
        <span data-testid="review-draft-count">草稿批注 {comments.length} 条</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" disabled={busy || !comments.length} onClick={() => void copy(false)}>复制注释</button>
        <button type="button" className="btn-primary" disabled={busy || !comments.length} onClick={() => void copy(true)}>复制并关闭</button>
      </footer>
    </div>
  );
}
