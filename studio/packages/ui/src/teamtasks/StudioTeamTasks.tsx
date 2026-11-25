import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { LinkedTeamTask, TeamTaskChange, TeamTaskFile } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { readTeamTaskFiles, TeamStatus, TeamTaskHistory } from "./shared.js";
import "./teamtasks.css";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");

async function save(ticket: string, file: TeamTaskFile): Promise<void> {
  if (!window.amo?.saveTeamTaskAttachment) throw new Error("请更新并重新打开 AMO Studio 后，再保存附件");
  await window.amo.saveTeamTaskAttachment(ticket, file.id, file.name);
}


export function LocalTeamTask({ link, taskId, archived }: { link: HostLink; taskId: string; archived: boolean }) {
  const [value, setValue] = useState<LinkedTeamTask | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const detail = await call(link, "GET /api/team-tasks/local/:id", { id: taskId });
      if (current === generation.current) {
        setValue(detail);
        if (detail?.ticket.status !== "doing") setDelivering(false);
        setError("");
      }
    } catch (err) {
      if (current === generation.current && (!(err instanceof HostApiError) || (err.code !== "not_found" && err.status !== 404))) setError(message(err));
    }
  }, [link, taskId]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  useEffect(() => {
    if (!open || busy || delivering) return;
    const timer = setInterval(() => void refresh(), 7000);
    return () => clearInterval(timer);
  }, [open, busy, delivering, refresh]);

  async function change(action: TeamTaskChange["action"], event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!value) return;
    const input = event && new FormData(event.currentTarget);
    generation.current++;
    setBusy(true);
    setError("");
    try {
      const files = await readTeamTaskFiles(input ? input.getAll("files").filter((file): file is File => file instanceof File && !!file.name) : []);
      const updated = await call(link, "POST /api/team-tasks/local/:id/change", { id: taskId }, { revision: value.ticket.revision, action, text: input ? String(input.get("text")) : "", files });
      setValue(updated);
      setDelivering(false);
      showToast(action === "deliver" ? "结果已发给提交人" : "已同步开工状态");
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }

  if (!value && !error) return null;
  const ticket = value?.ticket;
  return <section className="tt-local" aria-label="团队原单">
    <div className="tt-actions"><button type="button" className="tt-button" aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void refresh(); }}>团队原单</button>{ticket && <TeamStatus status={ticket.status} />}</div>
    {(open || !ticket) && <div className="tt-local-content">
      {error && <p className="tt-error" role="alert">{error}</p>}
      {ticket && <><h3>{ticket.title}</h3><p className="tt-muted tt-task-meta">提交人 {ticket.creator}</p><p className="tt-copy">{ticket.description}</p><TeamTaskHistory ticket={ticket} onFile={(file) => void save(ticket.id, file).catch((err) => setError(message(err)))} /></>}
      {!archived && <div className="tt-actions">
        <button type="button" className="tt-button" disabled={busy} onClick={() => void refresh()}>刷新原单</button>
        {value?.needsStartSync && <button type="button" className="tt-button tt-solid" disabled={busy} onClick={() => void change("start")}>同步开工状态</button>}
        {ticket?.status === "doing" && !delivering && <button type="button" className="tt-button tt-solid" disabled={busy} onClick={() => setDelivering(true)}>提交结果</button>}
      </div>}
      {delivering && !archived && <form className="tt-form tt-feedback" onSubmit={(event) => void change("deliver", event)}>
        <label>处理说明和验证结果<textarea name="text" required maxLength={6000} /></label>
        <label>验证附件（选填）<input name="files" type="file" multiple /></label>
        <div className="tt-actions"><button className="tt-button tt-solid" disabled={busy}>{busy ? "正在提交…" : "提交给验收人"}</button><button className="tt-button" disabled={busy} type="button" onClick={() => setDelivering(false)}>取消</button></div>
      </form>}
    </div>}
  </section>;
}
