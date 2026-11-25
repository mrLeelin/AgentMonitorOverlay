import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PlaneTaskDraft } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { showToast } from "../lib/toast.js";
import { teamBoardMessage } from "./SharedTeamBoard.js";

const emptyDraft: PlaneTaskDraft = { title: "", description: "" };

export function PublishPlaneTaskDialog({ link, project, state, onClose, onDone }: { link: HostLink; project?: string; state?: { id: string; name: string }; onClose(): void; onDone(): void }) {
  const [draft, setDraft] = useState<PlaneTaskDraft>(emptyDraft);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  useEffect(() => {
    let live = true;
    void call(link, "GET /api/team-board/plane/draft").then(
      (saved) => { if (live) { setDraft(saved ?? emptyDraft); setLoaded(true); } },
      (err) => { if (live) setError(teamBoardMessage(err)); },
    );
    return () => { live = false; };
  }, [link]);

  async function save(publish: boolean) {
    if (!loaded || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const input = { title: draft.title, description: draft.description, stateId: state?.id };
    try {
      if (publish) {
        const ticket = await call(link, "POST /api/team-board/plane/publish", {}, input);
        showToast(`已发布到 Plane · ${ticket.title}`);
        onDone();
      } else {
        await call(link, "PUT /api/team-board/plane/draft", {}, input);
        showToast("草稿已保存到本机。");
      }
      onClose();
    } catch (err) {
      const message = publish && err instanceof HostApiError && err.status >= 500 ? "暂时无法连接 Plane" : teamBoardMessage(err);
      setError(message);
      if (publish) {
        const saved = await call(link, "GET /api/team-board/plane/draft").catch(() => null);
        if (saved) {
          setDraft(saved);
          setError(`${message.replace(/[。！？]$/, "")}。草稿已保留，可重试。`);
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <Modal portal className="team-return-modal" label="新建团队任务" busy={busy} onClose={onClose}
    onSubmit={(event) => { event.preventDefault(); void save(true); }}>
    <h2 className="modal-title">新建团队任务</h2>
    {draft.publishing ? <p className="tb-meta">上次发布结果待确认。重试会沿用原来的内容、账号和项目。</p>
      : <p className="tb-meta">{project ? `发布到 ${project}${state ? ` · ${state.name}` : ""}` : "标题和说明可先存草稿，连接 Plane 并选好项目后再发布。"}</p>}
    <label className="team-return-reason">任务标题<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} disabled={!loaded || busy || !!draft.publishing} maxLength={200} required /></label>
    <label className="team-return-reason">任务说明<textarea value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} disabled={!loaded || busy || !!draft.publishing} rows={4} maxLength={6000} /></label>
    {error && <p className="team-return-error" role="alert">{error}</p>}
    <div className="settings-row end">
      <button type="button" className="btn-ghost small" disabled={busy} onClick={onClose}>关闭</button>
      <button type="button" className="btn-ghost small" disabled={busy || !loaded || !!draft.publishing} onClick={() => void save(false)}>保存草稿</button>
      <button type="submit" className="btn-primary small" disabled={busy || !loaded || !draft.title.trim()}>{draft.publishing ? "重试发布" : "发布到 Plane"}</button>
    </div>
  </Modal>;
}

export function LinkPlaneTaskDialog({ link, taskId, onClose, onDone }: { link: HostLink; taskId: string; onClose(): void; onDone(): void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      await call(link, "POST /api/team-board/local/:id/link", { id: taskId }, { url: url.trim() });
      showToast("已添加 Plane 原单链接。");
      onDone();
    } catch (err) { setError(teamBoardMessage(err)); }
    finally { setBusy(false); }
  }
  return <Modal portal className="team-return-modal" label="添加 Plane 原单链接" busy={busy} onClose={onClose} onSubmit={(event) => void submit(event)}>
    <h2 className="modal-title">添加 Plane 原单链接</h2>
    <p className="tb-meta">粘贴可访问的 Plane 工作项链接，方便从本地任务打开原单。</p>
    <label className="team-return-reason">Plane 原单链接<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} maxLength={512} required /></label>
    {error && <p className="team-return-error" role="alert">{error}</p>}
    <div className="settings-row end">
      <button type="button" className="btn-ghost small" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className="btn-primary small" disabled={busy || !url.trim()}>关联原单</button>
    </div>
  </Modal>;
}
