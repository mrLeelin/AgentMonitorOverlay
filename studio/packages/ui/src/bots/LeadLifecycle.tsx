import { useId, useRef, useState } from "react";
import { isManagedBy, managementRoot, type BotLeadControlInput, type BotLeadLegacyIssue, type BotLeadTaskView, type BotLeadTerm, type BotLeadTermSummary, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Modal } from "../lib/Modal.js";
import { botProfiles } from "./roster.js";
import type { LeadDirectory } from "./LeadAppointment.js";

function candidates(directory: LeadDirectory) {
  const profiles = botProfiles(directory.profiles);
  return directory.bots.filter((bot) => bot.enabled && profiles.some((profile) => profile.id === bot.profileId));
}

export function ReplaceLeadDialog({ directory, task, term, onClose }: { directory: LeadDirectory; task: Task; term: BotLeadTermSummary; onClose(): void }) {
  const heading = useId();
  const [botId, setBotId] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const used = new Set(directory.tasks.filter((item) => item.id === task.id || isManagedBy(directory.tasks, task.id, item.id) || isManagedBy(directory.tasks, item.id, task.id))
    .flatMap((item) => item.botLead?.kind === "appointed" ? [item.botLead.term.botId] : []));
  used.add(term.botId);
  const bots = candidates(directory).filter((bot) => !used.has(bot.id));
  async function replace() {
    if (busy || !botId) return;
    const input = { action: "replace", expectedTerm: { termId: term.termId, generation: term.generation }, botId, ...(summary.trim() ? { summary: summary.trim() } : {}) } satisfies Omit<Extract<BotLeadControlInput, { action: "replace" }>, "operationId">;
    const key = JSON.stringify(input);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await call(directory.link, "POST /api/tasks/:id/bot-lead/control", { id: task.id }, { ...input, operationId: attempt.current.id });
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <Modal portal className="lead-appointment" labelledBy={heading} onClose={onClose}>
    <h2 className="modal-title" id={heading}>更换负责机器人</h2>
    <p className="side-note">{task.title} · 当前由 {term.name} 负责。原任务、画布位置和交付记录会保留。</p>
    <label className="lead-field">接任机器人
      <select className="field" value={botId} onChange={(e) => setBotId(e.target.value)}><option value="">选择机器人</option>
        {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select>
    </label>
    {!bots.length && <p className="side-note">请在 Bots 设置中启用或创建一位可用机器人。</p>}
    <label className="lead-field">交接备注（可选）
      <textarea className="field" value={summary} maxLength={20000} rows={3} onChange={(e) => setSummary(e.target.value)} />
    </label>
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="lead-actions"><button type="button" className="btn-ghost" onClick={onClose}>取消</button><button type="button" className="btn-primary" disabled={!botId || busy} onClick={() => void replace()}>确认换任</button></div>
  </Modal>;
}

export function LegacyLeadBindingDialog({ directory, task, onClose }: { directory: LeadDirectory; task: Task; onClose(): void }) {
  const heading = useId();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const root = managementRoot(directory.tasks, task.id);
  const members = root ? [root] : [];
  const seen = new Set(members.map((member) => member.id));
  for (const member of members) {
    for (const child of directory.tasks) {
      if (child.managerTaskId !== member.id || child.archivedAt || seen.has(child.id)) continue;
      seen.add(child.id);
      members.push(child);
    }
  }
  const invalid = members.filter((member) => member.topicId !== root?.topicId || member.remote || member.botLead?.kind === "legacy" && member.botLead.issue);
  const leads = members.filter((member) => member.lead && member.botLead?.kind === "legacy" && member.botLead.state === "needs-bot");
  const bots = candidates(directory);
  const blocked = !root || !!invalid.length || !leads.length || leads.some((lead) => !selected[lead.id]);

  async function bind() {
    if (!root || blocked || busy) return;
    const bindings = leads.map((lead) => ({ taskId: lead.id, botId: selected[lead.id]!, expectedTerm: null }));
    const key = JSON.stringify(bindings);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const result = await call(directory.link, "POST /api/tasks/:id/bot-lead/legacy-bindings", { id: root.id }, { operationId: attempt.current.id, bindings });
      onClose();
      const target = result.find((item) => item.taskId === task.id) ?? result[0];
      if (target?.topicId) directory.onCanvas(target.topicId, target.taskId);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <Modal portal className="lead-appointment" labelledBy={heading} onClose={onClose}>
    <h2 className="modal-title" id={heading}>绑定旧主控树</h2>
    <p className="side-note">{root?.title ?? task.title} · 按原管理关系逐项选择机器人，同一条上下级链使用不同机器人。</p>
    {!root && <p className="form-error">请先从任务的「管理关系」修正直属主控。</p>}
    {invalid.map((member) => <div key={member.id} className="lead-actions">
      <span role="status">{member.title} · {member.botLead?.kind === "legacy" && member.botLead.issue || "管理范围异常"}</span>
      <button type="button" className="link-btn" onClick={() => { onClose(); directory.onTask(member.id); }}>打开任务修复</button>
    </div>)}
    {leads.map((lead) => <label className="lead-field" key={lead.id}>{lead.managerTaskId ? "中控" : "总主控"} · {lead.title}
      <select className="field" value={selected[lead.id] ?? ""} onChange={(e) => setSelected((current) => ({ ...current, [lead.id]: e.target.value }))}>
        <option value="">待选机器人</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select>
    </label>)}
    {!bots.length && <p className="side-note">请在 Bots 设置中启用或创建可用机器人。</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <div className="lead-actions"><button type="button" className="btn-ghost" onClick={onClose}>取消</button><button type="button" className="btn-primary" disabled={blocked || busy} onClick={() => void bind()}>绑定并交接</button></div>
  </Modal>;
}

export function LeadHistory({ directory, task, onClose }: { directory: LeadDirectory; task: Task; onClose(): void }) {
  const heading = useId();
  const [view, , refresh] = useLiveResource<BotLeadTaskView | null>({ initial: null, load: () => call(directory.link, "GET /api/tasks/:id/bot-lead", { id: task.id }) }, [directory.link.url, directory.link.token, task.id]);
  const [term, setTerm] = useState<BotLeadTerm>();
  const [error, setError] = useState("");
  return <Modal portal className="lead-appointment" labelledBy={heading} onClose={onClose}>
    <h2 id={heading} className="modal-title">主控任期记录</h2>
    <p className="side-note">{task.title}</p>
    {!view && <button type="button" className="btn-ghost" onClick={refresh}>读取任期</button>}
    {view?.terms?.map((item) => <button type="button" className="link-btn" key={item.termId} onClick={() => void call(directory.link, "GET /api/tasks/:id/bot-lead/terms/:termId", { id: task.id, termId: item.termId }).then(setTerm, (err: Error) => setError(err.message))}>
      第 {item.generation} 任 · {item.name} · {item.state === "ended" ? "已结束" : "当前任期"}
    </button>)}
    {term && <div className="lead-workflow-row">
      <span className="side-note">{new Date(term.startedAt).toLocaleString()}{term.endedAt ? ` 至 ${new Date(term.endedAt).toLocaleString()}` : ""}</span>
      <p className="workflow-text">{term.handoff}</p>
      {term.sessionId && <button type="button" className="link-btn" onClick={() => { onClose(); directory.onTask(task.id, term.sessionId!); }}>打开该任期会话</button>}
    </div>}
    {error && <p role="alert" className="form-error">{error}</p>}
    <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
  </Modal>;
}

export function LegacyLeadIssues({ link, onTask, onClose }: { link: HostLink; onTask(id: string): void; onClose(): void }) {
  const heading = useId();
  const [issues, , refresh] = useLiveResource<BotLeadLegacyIssue[] | null>({
    initial: null, load: () => call(link, "GET /api/bot-leads/legacy-issues", {}),
  }, [link.url, link.token]);
  return <Modal portal className="lead-appointment" labelledBy={heading} onClose={onClose}>
    <h2 id={heading} className="modal-title">管理关系异常</h2>
    {issues === null ? <button type="button" className="btn-ghost" onClick={refresh}>读取管理链</button>
      : !issues.length ? <p className="side-note">当前没有需要修复的管理链。</p> : <ul className="lead-handoff-blockers">
        {issues.map((issue) => <li key={issue.taskId}><button type="button" className="link-btn" onClick={() => { onClose(); onTask(issue.taskId); }}>{issue.title || "未命名任务"}</button>
          <span className="side-note">{issue.reason}，请在任务的「管理关系」调整直属主控。</span></li>)}
      </ul>}
    <button type="button" className="btn-ghost" onClick={onClose}>关闭</button>
  </Modal>;
}
