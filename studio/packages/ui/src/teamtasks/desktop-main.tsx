import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { TeamTask, TeamTaskChange, TeamTaskIdentity, TeamTaskSummary, TeamTasksDesktop } from "@amo-studio/protocol";
import { readTeamTaskFiles, teamDate, TeamStatus, TeamTaskHistory } from "./shared.js";
import "../styles/base.css";
import "../styles/workbench.css";
import "./teamtasks.css";

declare global { interface Window { teamTasks?: TeamTasksDesktop } }

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");

function Desktop({ api }: { api: TeamTasksDesktop }) {
  const [identity, setIdentity] = useState<TeamTaskIdentity | null>();
  const [tickets, setTickets] = useState<TeamTaskSummary[]>([]);
  const [filter, setFilter] = useState<"mine" | "assigned">("mine");
  const [selected, setSelected] = useState<TeamTask | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [mode, setMode] = useState<"note" | "return" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const sequence = useRef(0);
  const form = useRef<HTMLFormElement>(null);

  async function refresh() {
    const request = ++sequence.current;
    setError("");
    setNotice("");
    try {
      const account = await api.identity();
      const list = account ? await api.list() : [];
      const fresh = account && identity?.name === account.name && selected && list.some(({ id }) => id === selected.id) ? await api.detail(selected.id) : null;
      if (request !== sequence.current) return;
      setIdentity(account);
      setTickets(list);
      setSelected(fresh);
    } catch (err) {
      if (request !== sequence.current) return;
      setError(errorText(err));
    }
  }

  useEffect(() => { void refresh(); }, [api]);

  async function open(id: string) {
    const request = ++sequence.current;
    setError("");
    setNotice("");
    setOpening(id);
    try {
      const ticket = await api.detail(id);
      if (request !== sequence.current) return;
      setSelected(ticket);
      setMode(null);
    } catch (err) {
      if (request === sequence.current) setError(errorText(err));
    } finally {
      if (request === sequence.current) setOpening(null);
    }
  }

  async function run(work: () => Promise<TeamTask>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const ticket = await work();
      setTickets((current) => [ticket, ...current.filter((item) => item.id !== ticket.id)]);
      setSelected(ticket);
      setMode(null);
      setNotice(message);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    const element = event.currentTarget;
    void run(async () => {
      const files = await readTeamTaskFiles(input.getAll("files").filter((file): file is File => file instanceof File && !!file.name));
      const ticket = await api.create({ requestId: requestId.current, title: String(input.get("title")), description: String(input.get("description")), assignee: String(input.get("assignee")), files });
      requestId.current = crypto.randomUUID();
      element.reset();
      setFilter("mine");
      return ticket;
    }, "任务已提交");
  }

  function change(action: TeamTaskChange["action"], event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!selected || busy) return;
    const input = event && new FormData(event.currentTarget);
    void run(async () => {
      const files = await readTeamTaskFiles(input ? input.getAll("files").filter((file): file is File => file instanceof File && !!file.name) : []);
      return api.change(selected.id, { revision: selected.revision, action, text: input ? String(input.get("text")) : "", files });
    }, action === "accept" ? "已确认完成" : action === "return" ? "已发回继续处理" : "补充说明已发送");
  }

  const visible = tickets.filter((ticket) => (filter === "mine" ? ticket.creator : ticket.assignee) === identity?.name);
  const canAccept = selected?.status === "review" && selected.creator === identity?.name;
  const draft = identity && !selected;

  return (
    <div className="studio-workbench tt-desktop">
      <header className="tt-top"><div className="tt-brand"><span aria-hidden="true" className="tt-mark"><svg viewBox="0 0 24 24"><path d="M6 4h9l3 3v13H6zM9 10h6m-6 4h6" /></svg></span> AMO 团队任务</div><div className="tt-actions"><span className="tt-muted">{identity?.name}</span><button className="tt-button" disabled={busy || !!opening} onClick={() => void refresh()}>刷新</button></div></header>
      <main className="tt-desktop-main">
        {error && <p className="tt-error" role="alert">{error}</p>}
        {notice && <p className="tt-notice" role="status">{notice}</p>}
        {identity === undefined && !error && <p className="tt-muted" role="status">正在连接团队服务器…</p>}
        {identity === null && <section className="tt-sign-in"><h1>请先在 AMO 平台里登录</h1><p className="tt-muted">登录团队账号后，回到这里点刷新。</p></section>}
        {identity && <div className="tt-desktop-grid">
          <aside className="tt-sent" aria-label="任务列表">
            <div className="tt-between"><h2>团队任务</h2><button className="tt-button" disabled={busy || !!opening} onClick={() => { setSelected(null); setMode(null); setError(""); setNotice(""); requestAnimationFrame(() => form.current?.querySelector("input")?.focus()); }}>新建任务</button></div>
            <div className="tt-tabs"><button aria-pressed={filter === "mine"} disabled={busy} onClick={() => setFilter("mine")}>我提交的</button><button aria-pressed={filter === "assigned"} disabled={busy} onClick={() => setFilter("assigned")}>分配给我</button></div>
            <div className="tt-list">{!visible.length && <p className="tt-muted tt-empty">{filter === "mine" ? "还没有提交任务。" : "还没有分配给你的任务。"}</p>}{visible.map((ticket) => (
              <button key={ticket.id} type="button" className="tt-ticket" aria-current={selected?.id === ticket.id} disabled={busy || !!opening} onClick={() => void open(ticket.id)}>
                <strong>{ticket.title}</strong><span className="tt-between"><span>{filter === "mine" ? `接收人 ${ticket.assignee}` : `提交人 ${ticket.creator}`} · {teamDate(ticket.updatedAt)}</span><TeamStatus status={ticket.status} /></span>
              </button>
            ))}</div>
          </aside>
          <section className="tt-body" aria-label={selected ? "任务详情" : "新建任务"}>
            {opening && <p className="tt-muted" role="status">正在加载原单…</p>}
            <form hidden={!draft || !!opening} className="tt-form" ref={form} onSubmit={create}>
              <h1>新建任务</h1>
              <label>标题<input name="title" required maxLength={120} placeholder="例如：结算界面偶尔黑屏" /></label>
              <label>接收人<select name="assignee" defaultValue="" required><option value="" disabled>选择同事</option>{identity.members.map((member) => <option key={member.name} value={member.name}>{member.nick ? `${member.nick}（${member.name}）` : member.name}</option>)}</select></label>
              <label>说明<textarea name="description" required maxLength={4000} placeholder="发生了什么？可以附上复现步骤和预期结果。" /></label>
              <label>附件（选填）<input name="files" type="file" multiple /><span className="tt-muted">可添加截图、日志或需求文档，合计最多 16 MB。</span></label>
              <footer className="tt-form-footer"><span className="tt-muted">提交后可在「我提交的」查看进度。</span><button className="tt-button tt-solid" disabled={busy}>{busy ? "正在提交…" : "提交任务"}</button></footer>
            </form>
            {selected && !opening && <>
              <div className="tt-between"><h1>{selected.title}</h1><TeamStatus status={selected.status} /></div>
              <p className="tt-muted tt-task-meta">提交人 {selected.creator} · 接收人 {selected.assignee}</p>
              <p className="tt-copy">{selected.description}</p>
              <TeamTaskHistory ticket={selected} onFile={(file) => { void api.saveAttachment(selected.id, file).catch((err) => setError(errorText(err))); }} />
              {selected.status !== "done" && <div className="tt-actions">
                {canAccept && <button type="button" className="tt-button tt-solid" disabled={busy} onClick={() => change("accept")}>确认完成</button>}
                {canAccept && <button type="button" className="tt-button" disabled={busy} onClick={() => setMode("return")}>发回继续处理</button>}
                {!canAccept && <button type="button" className="tt-button" disabled={busy} onClick={() => setMode("note")}>补充说明</button>}
              </div>}
              {mode && <form className="tt-form tt-feedback" onSubmit={(event) => change(mode, event)} key={`${selected.id}:${mode}`}>
                <label>{mode === "return" ? "还需要处理什么？" : "补充说明"}<textarea name="text" maxLength={6000} required={mode === "return"} /></label>
                <label>附件（选填）<input name="files" type="file" multiple /></label>
                <div className="tt-actions"><button className="tt-button tt-solid" disabled={busy}>{busy ? "正在发送…" : "发送"}</button><button type="button" className="tt-button" disabled={busy} onClick={() => setMode(null)}>取消</button></div>
              </form>}
            </>}
          </section>
        </div>}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(window.teamTasks ? <Desktop api={window.teamTasks} /> : <p>请从 AMO 团队任务客户端打开。</p>);
