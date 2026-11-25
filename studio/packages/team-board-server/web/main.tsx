import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { TeamBoardClient, TeamBoardError, type TeamBoardAction, type TeamBoardChange, type TeamBoardSnapshot, type TeamBoardSummary, type TeamBoardTicket, type TeamTaskPerson } from "@amo-studio/protocol";
import { TeamBoardColumns, TeamBoardDetail, TeamBoardForm, TeamBoardNotices, teamBoardMessage } from "../../ui/src/teamtasks/SharedTeamBoard.js";
import "./page.css";

const client = new TeamBoardClient();
const requestId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

function App() {
  const [snapshot, setSnapshot] = useState<TeamBoardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<TeamBoardTicket | null>(null);
  const [action, setAction] = useState<TeamBoardAction | null>(null);
  const [people, setPeople] = useState<TeamTaskPerson[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const submission = useRef("");
  const detailPane = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const detailSeq = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++seq.current;
    try {
      const result = await client.snapshot();
      if (current === seq.current) { setSnapshot(result); setError(""); }
    } catch (err) {
      if (current !== seq.current) return;
      if (err instanceof TeamBoardError && err.status === 401) { setSnapshot(null); setSelected(null); setPeople(null); }
      else setError(teamBoardMessage(err));
    } finally { if (current === seq.current) setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); return () => { seq.current++; detailSeq.current++; }; }, [refresh]);
  const selectedId = selected?.id;
  useEffect(() => { if (selectedId) detailPane.current?.scrollIntoView({ block: "nearest" }); }, [selectedId, action]);
  useEffect(() => {
    if (!snapshot?.name) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    return () => clearInterval(timer);
  }, [refresh, snapshot?.name]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(""); setBusy(true);
    try { await client.login(String(data.get("name")), String(data.get("password"))); await refresh(); }
    catch (err) { setError(teamBoardMessage(err)); }
    finally { setBusy(false); }
  }

  async function detail(id: string, next: TeamBoardAction | null = null) {
    const current = ++detailSeq.current;
    setError(""); setNotice(""); setPeople(null);
    try {
      const ticket = await client.detail(id);
      if (current !== detailSeq.current) return;
      setSelected(ticket); setAction(next);
      if (snapshot?.notices.some((item) => item.ticketId === id && item.unread)) { await client.readNotice(id); void refresh(); }
    } catch (err) { if (current === detailSeq.current) setError(teamBoardMessage(err)); }
  }

  async function createForm() {
    const current = ++detailSeq.current;
    setSelected(null); setNotice(""); setError("");
    try {
      const identity = await client.identity();
      if (current !== detailSeq.current) return;
      submission.current = requestId(); setPeople(identity.members);
    } catch (err) { setError(teamBoardMessage(err)); }
  }

  async function change(value: TeamBoardChange) {
    if (!selected) return;
    try {
      const ticket = await client.change(selected.id, value);
      setSelected(ticket); setAction(null);
      setNotice(value.action === "deliver" ? `已通知提出人 ${ticket.creator} 验收` : "团队原单已更新");
      await refresh();
    } catch (err) {
      if (err instanceof TeamBoardError && err.status === 409) await detail(selected.id, value.action);
      throw err;
    }
  }

  async function move(ticket: TeamBoardSummary, next: TeamBoardAction) {
    setError(""); setNotice(""); setPeople(null);
    try {
      const updated = await client.change(ticket.id, { action: next, revision: ticket.revision });
      setSelected(updated); setAction(next === "return" ? "note" : null);
      setNotice(next === "deliver" ? `已通知提出人 ${ticket.creator} 验收` : "团队原单已更新");
      await refresh();
    } catch (err) { await refresh(); setError(teamBoardMessage(err)); }
  }

  return <div className="tb-page">
    <header><strong>AMO 团队看板</strong>{snapshot && <div className="tb-row"><span className="tb-meta">{snapshot.name}</span><button className="tb-button" type="button" onClick={() => {
      void client.logout().then(() => { seq.current++; detailSeq.current++; setSnapshot(null); setSelected(null); setPeople(null); setNotice(""); setError(""); }, (err: unknown) => setError(teamBoardMessage(err)));
    }}>退出登录</button></div>}</header>
    <main>
      {error && <p className="tb-error" role="alert">{error}</p>}
      {notice && <p className="tb-meta" role="status">{notice}</p>}
      {loading && <p className="tb-meta">正在连接团队看板…</p>}
      {!loading && !snapshot && <section className="tb-login">
        <h1>登录团队看板</h1><p className="tb-meta">使用已有的 AMO 团队账号。</p>
        <form className="tb-form" onSubmit={(event) => void login(event)}>
          <label>账号<input name="name" required autoComplete="username" /></label>
          <label>密码<input name="password" required type="password" autoComplete="current-password" /></label>
          <div className="tb-row"><button className="tb-button tb-primary" disabled={busy} type="submit">{busy ? "正在登录…" : "登录"}</button></div>
        </form>
      </section>}
      {snapshot && <>
        <div className="tb-between tb-head"><h1>团队看板</h1><div className="tb-row"><TeamBoardNotices snapshot={snapshot} onOpen={(id) => void detail(id)} /><button type="button" className="tb-button" onClick={() => void refresh()}>刷新</button><button type="button" className="tb-button tb-primary" onClick={() => void createForm()}>提交任务</button></div></div>
        {people && <section className="tb-compose" aria-label="提交团队任务"><TeamBoardForm people={people} onClose={() => setPeople(null)} onSubmit={async (input) => {
          const ticket = await client.create({ ...input, requestId: submission.current });
          setPeople(null); setSelected(ticket); setAction(null); setNotice("任务已提交到待定"); await refresh();
        }} /></section>}
        <p className="tb-board-hint tb-meta">执行者在 Studio 接单。送审后，提出人可在此验收或退回。</p>
        <TeamBoardColumns snapshot={snapshot} onOpen={(id) => void detail(id)} onMove={(ticket, next) => void move(ticket, next)} />
        {selected && <div className="tb-web-detail" ref={detailPane}><TeamBoardDetail key={selected.id} ticket={selected} name={snapshot.name} action={action} setAction={setAction} onChange={change} onClose={() => { detailSeq.current++; setSelected(null); setAction(null); }} onFile={(file) => {
          const anchor = document.createElement("a");
          anchor.href = client.fileUrl(selected.id, file.id); anchor.download = file.name; anchor.click();
        }} /></div>}
      </>}
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App />);
