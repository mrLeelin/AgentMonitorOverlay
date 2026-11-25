import { useEffect, useRef, useState } from "react";
import type { BotGroup, BotGroupPost, StudioBot } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { BotRequestList } from "./BotRequests.js";

export function BotGroups({ link, bots, onOpen }: { link: HostLink; bots: readonly StudioBot[]; onOpen(task: string, session: string): void }) {
  const [groups, setGroups] = useState<BotGroup[]>([]);
  const [posts, setPosts] = useState<BotGroupPost[]>([]);
  const [selected, select] = useState<string>();
  const [editing, edit] = useState(false);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [text, setText] = useState("");
  const [idle, setIdle] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<{ key: string; id: string } | undefined>(undefined);
  const group = groups.find((entry) => entry.id === selected);
  const enabledMembers = bots.filter((bot) => bot.enabled && group?.memberIds.includes(bot.id));

  useEffect(() => {
    let active = true;
    void call(link, "GET /api/bot-groups").then((result) => { if (active) setGroups(result); }).catch(() => {});
    return () => { active = false; };
  }, [link]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const load = () => { void call(link, "GET /api/bot-groups/:id/posts", { id: selected }).then((result) => { if (active) setPosts(result); }).catch(() => {}); };
    load();
    const interval = setInterval(load, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [link, selected]);

  function choose(id?: string) {
    select(id);
    setPosts([]);
    setText("");
    setTarget("");
    setError("");
    const next = groups.find((entry) => entry.id === id);
    setName(next?.name ?? "");
    setMembers(next?.memberIds ?? []);
    edit(!id);
  }

  async function run(work: () => Promise<void>) {
    if (!idle) return;
    setIdle(false);
    setError("");
    try { await work(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setIdle(true); }
  }

  return <section className="settings-section" aria-label="Bot 群组">
    <div className="settings-row"><strong>群组</strong><button type="button" className="btn-ghost small" onClick={() => choose()} disabled={!bots.length || !idle}>新建群组</button></div>
    {!!groups.length && <div className="settings-row">{groups.map((entry) => <button type="button" className="btn-ghost small" aria-pressed={entry.id === selected} key={entry.id} onClick={() => choose(entry.id)} disabled={!idle}>{entry.name}</button>)}</div>}
    {editing && <form className="settings-section" onSubmit={(event) => {
      event.preventDefault();
      void run(async () => {
        const body = { name, memberIds: members };
        const saved = selected ? await call(link, "PUT /api/bot-groups/:id", { id: selected }, body) : await call(link, "POST /api/bot-groups", {}, body);
        setGroups((old) => [...old.filter((entry) => entry.id !== saved.id), saved]);
        select(saved.id);
        edit(false);
      });
    }}>
      <label>群组名称 <input className="field" value={name} maxLength={40} required onChange={(e) => setName(e.target.value)} /></label>
      <div className="settings-row" role="group" aria-label="群组成员">{bots.map((bot) => <label key={bot.id}><input type="checkbox" checked={members.includes(bot.id)} onChange={(e) => setMembers(e.target.checked ? [...members, bot.id] : members.filter((id) => id !== bot.id))} /> {bot.name}</label>)}</div>
      <div className="settings-row"><button type="submit" className="btn-primary small" disabled={!idle || !name.trim() || !members.length}>保存群组</button><button type="button" className="btn-ghost small" onClick={() => edit(false)}>取消</button></div>
    </form>}
    {group && !editing && <>
      <div className="settings-row"><span className="settings-hint">{bots.filter((bot) => group.memberIds.includes(bot.id)).map((bot) => bot.name).join("、")}</span><button type="button" className="btn-ghost small" onClick={() => edit(true)} disabled={!idle}>编辑群组</button></div>
      <div className="bot-group-posts">{[...posts].reverse().map((post) => <div key={post.id} className="bot-group-post"><p>{post.text}</p><BotRequestList rows={post.replies} bots={bots} onOpen={onOpen} /></div>)}</div>
      <form className="settings-section" onSubmit={(event) => {
        event.preventDefault();
        const targetIds = target ? [target] : enabledMembers.map((bot) => bot.id);
        const content = text.trim();
        if (!content || !targetIds.length) return;
        const key = JSON.stringify([group.id, content, targetIds]);
        if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
        const id = request.current.id;
        void run(async () => {
          const posted = await call(link, "POST /api/bot-groups/:id/posts", { id: group.id }, { id, text: content, targetIds });
          setPosts((old) => [posted, ...old.filter((entry) => entry.id !== posted.id)]);
          request.current = undefined;
          setText("");
        });
      }}><label>发送给 <select className="field" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">所有已启用成员</option>{enabledMembers.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>
        <textarea aria-label="群组消息" className="field" value={text} onChange={(e) => setText(e.target.value)} maxLength={20_000} />
        <button type="submit" className="btn-primary small bot-history-row" disabled={!idle || !text.trim() || !enabledMembers.length}>发送群组消息</button>
      </form>
    </>}
    {error && <div role="alert" className="form-error">{error}</div>}
  </section>;
}
