import { useEffect, useId, useRef, useState } from "react";
import type { BotLeadAppointmentInput, BotLeadChoice, BotLeadOperationReceipt, BotLeadUserSource, DecisionRequest, Id, ModelProfile, StudioBot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { topicWorkspaceIds } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { EditTopicDialog } from "../board/EditTopicDialog.js";
import { readStored, writeStored } from "../lib/stored.js";
import { botProfiles, newBotDraft } from "./roster.js";
import type { LeadAttentionTarget } from "./lead-navigation.js";
import "./lead-appointment.css";

export type LeadCanvasOpen = (topicId: Id, taskId: Id, attention?: LeadAttentionTarget) => void;

export interface LeadDirectory {
  link: HostLink;
  tasks: readonly Task[];
  topics: readonly Topic[];
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  bots: readonly StudioBot[];
  decisions?: readonly DecisionRequest[];
  originTopicId?: Id;
  onCanvas: LeadCanvasOpen;
  onTask(taskId: Id, sessionId?: Id): void;
}

export interface LeadSeed {
  source: BotLeadUserSource;
  botId?: Id;
  taskId?: Id;
  topicId?: Id;
  workspaceId?: Id;
  profileId?: Id;
  title?: string;
  topicTitle?: string;
  text?: string;
  summary?: string;
  intent?: BotLeadAppointmentInput["intent"];
  fixedTarget?: boolean;
  sourceUse?: "new-goal";
  start?: boolean;
}

export function appointmentSourceKey(source: BotLeadUserSource) {
  if (source.kind === "bot-request") return `request:${source.requestId}`;
  if (source.kind === "user-message") return `message:${source.sessionId}:${source.messageId}`;
  return null;
}

export function operationKey(source: BotLeadUserSource) {
  const key = appointmentSourceKey(source);
  return key ? `amo.lead-operation:${key}` : null;
}

export function appointmentTargets(tasks: readonly Task[], topics: readonly Topic[], topicId?: Id) {
  const live = new Set(topics.filter((topic) => !topic.archivedAt).map((topic) => topic.id));
  return tasks.filter((task) => task.lead && !task.managerTaskId && !task.archivedAt && !task.remote && task.topicId && live.has(task.topicId) &&
    (!topicId || task.topicId === topicId) && task.botLead?.kind === "appointed" && task.botLead.term.state === "active");
}

export function leadTargetLabel(target: Task, topics: readonly Topic[], workspaces: readonly Workspace[]) {
  const topic = topics.find((item) => item.id === target.topicId);
  const workspace = workspaces.find((item) => item.id === target.workspaceId);
  const owner = target.botLead?.kind === "appointed" ? target.botLead.term.name : "";
  return [topic?.title, target.title || "未命名目标", owner, workspace && `${workspace.name}（${workspace.path}）`].filter(Boolean).join(" · ");
}

export function openLeadReceipt(directory: Pick<LeadDirectory, "onCanvas" | "onTask">, receipt: BotLeadOperationReceipt) {
  if (receipt.action !== "worker" && receipt.topicId && receipt.state.kind !== "pending-upgrade") directory.onCanvas(receipt.topicId, receipt.taskId);
  else directory.onTask(receipt.taskId);
}

export function LeadAppointment({ directory, seed, onClose, onReceipt }: { directory: LeadDirectory; seed: LeadSeed; onClose(): void; onReceipt(receipt: BotLeadOperationReceipt): void }) {
  const { link, tasks, topics, workspaces, profiles, bots } = directory;
  const heading = useId();
  const projects = workspaces.filter((item) => !item.archivedAt && !item.builtin);
  const eligibleProfiles = botProfiles(profiles);
  const eligibleBots = bots.filter((item) => item.enabled && eligibleProfiles.some((profile) => profile.id === item.profileId));
  const targets = appointmentTargets(tasks, topics, seed.topicId).filter((item) => !seed.fixedTarget || item.id === seed.taskId);
  const upgrade = seed.intent === "upgrade";
  const original = upgrade ? tasks.find((item) => item.id === seed.taskId) : undefined;
  const [intent, setIntent] = useState(seed.intent ?? (seed.topicId && targets.length ? "continue" : "create"));
  const [targetId, setTargetId] = useState(seed.intent === "continue" && seed.taskId ? seed.taskId : seed.topicId && targets.length === 1 ? targets[0]!.id : "");
  const picked = targets.find((item) => item.id === targetId);
  const term = picked?.botLead?.kind === "appointed" ? picked.botLead.term : undefined;
  const termKey = term ? `${term.termId}:${term.generation}` : "";
  const [pickedTerm, setPickedTerm] = useState(termKey);
  const [botId, setBotId] = useState(seed.botId ?? (eligibleBots.length === 1 ? eligibleBots[0]!.id : ""));
  const initialTopic = topics.find((topic) => topic.id === seed.topicId && !topic.archivedAt);
  const initialAuthorized = initialTopic ? new Set(topicWorkspaceIds(initialTopic, tasks, workspaces)) : null;
  const initialProjects = initialAuthorized ? projects.filter((item) => initialAuthorized.has(item.id)) : projects;
  const [workspaceId, setWorkspaceId] = useState((initialProjects.some((item) => item.id === seed.workspaceId) ? seed.workspaceId : undefined) ?? (initialProjects.length === 1 ? initialProjects[0]!.id : ""));
  const [topicId, setTopicId] = useState(seed.topicId ?? "");
  const [title, setTitle] = useState(seed.title ?? "");
  const [topicTitle, setTopicTitle] = useState(seed.topicTitle ?? seed.title?.slice(0, 100) ?? "");
  const [text, setText] = useState(seed.summary ?? seed.text ?? "");
  const [reopen, setReopen] = useState(false);
  const [newBotName, setNewBotName] = useState("");
  const [profileId, setProfileId] = useState(eligibleProfiles.find((profile) => profile.id === seed.profileId)?.id ?? eligibleProfiles[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<BotLeadOperationReceipt>();
  const [editTopic, setEditTopic] = useState<Topic>();
  const attempt = useRef<{ payload: string; id: Id } | null>(null);
  const pending = useRef(false);
  const storageKey = seed.sourceUse ? null : operationKey(seed.source);
  const completed = picked?.column === "done" || picked?.column === "review";
  const selectedBot = eligibleBots.find((item) => item.id === botId);
  const selectedTopic = topics.find((item) => item.id === topicId && !item.archivedAt);
  const authorized = selectedTopic ? new Set(topicWorkspaceIds(selectedTopic, tasks, workspaces)) : null;
  const availableProjects = authorized ? projects.filter((item) => authorized.has(item.id)) : projects;
  const selectedWorkspace = availableProjects.find((item) => item.id === workspaceId);
  const choice: BotLeadChoice | undefined = selectedBot ? { botId: selectedBot.id } : botId === "new" && newBotName.trim() && eligibleProfiles.some((profile) => profile.id === profileId)
    ? { newBot: { ...newBotDraft(profiles), name: newBotName.trim(), profileId, workspaceId: original?.workspaceId ?? selectedWorkspace?.id ?? null } }
    : undefined;
  const maySubmit = intent === "continue" ? !!term && pickedTerm === termKey && !!text.trim() && (!completed || reopen)
    : !!choice && (upgrade ? !!original && !!text.trim() && (!!original.topicId || !!topicTitle.trim()) : !!selectedWorkspace && !!title.trim() && (!!selectedTopic || !topicId && !!topicTitle.trim()));

  useEffect(() => {
    const id = storageKey && readStored(storageKey);
    if (!id) return;
    let current = true;
    void call(link, "GET /api/bot-leads/operations/:id", { id }).then((view) => {
      if (current && !pending.current) setReceipt(view.receipt);
    }).catch(() => {});
    return () => { current = false; };
  }, [link.url, link.token, storageKey]);

  async function submit() {
    if (!maySubmit || pending.current || receipt) return;
    let input: BotLeadAppointmentInput;
    const base = { operationId: "", source: seed.source };
    if (intent === "continue" && picked && term) {
      input = { ...base, intent, taskId: picked.id, expectedTerm: { termId: term.termId, generation: term.generation }, text: text.trim(), purpose: reopen ? "reopen" : "work" };
    } else if (intent === "upgrade" && original && choice) {
      input = { ...base, ...choice, intent, taskId: original.id, expectedTerm: null, summary: text.trim(), ...(!original.topicId ? { topicTitle: topicTitle.trim() } : {}) };
    } else if (intent === "create" && selectedWorkspace && choice) {
      input = { ...base, ...choice, intent, workspaceId: selectedWorkspace.id, title: title.trim(), topic: selectedTopic ? { topicId: selectedTopic.id } : { topicTitle: topicTitle.trim() },
        ...(text.trim() ? { firstMessage: text.trim() } : {}), ...(seed.sourceUse ? { sourceUse: seed.sourceUse } : {}), ...(seed.start === false ? { start: false } : {}) };
    } else return;
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload) attempt.current = { payload, id: crypto.randomUUID() };
    const id = attempt.current.id;
    if (storageKey) writeStored(storageKey, id);
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await call(link, "POST /api/bot-leads/appointments", {}, { ...input, operationId: id });
      if (storageKey) writeStored(storageKey, result.operationId);
      onReceipt(result);
    } catch (err) {
      const details = err instanceof HostApiError ? err.details : undefined;
      if (details?.reason === "source-already-accepted") {
        if (storageKey) writeStored(storageKey, details.receipt.operationId);
        onReceipt(details.receipt);
      } else {
        setError(details?.reason === "stale-term" ? "主控已变化。请核对当前收件人后重新发送。" : err instanceof Error ? err.message : String(err));
      }
    } finally { pending.current = false; setBusy(false); }
  }

  const header = upgrade ? "请机器人带队" : intent === "continue" ? "交给已有主控" : "建立独立主控任务";
  const projectName = (id: Id) => workspaces.find((item) => item.id === id)?.name ?? "未知项目";
  const changeTopic = (id: Id) => {
    const next = topics.find((item) => item.id === id);
    const available = next ? new Set(topicWorkspaceIds(next, tasks, workspaces)) : null;
    const choices = available ? projects.filter((item) => available.has(item.id)) : projects;
    setTopicId(id);
    if (!choices.some((item) => item.id === workspaceId)) setWorkspaceId(choices.length === 1 ? choices[0]!.id : "");
  };
  return <><Modal portal className="lead-appointment" labelledBy={heading} testId="lead-appointment" busy={busy} onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")].filter((item) => item.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget.querySelector("form"))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }}
    onSubmit={(event) => { event.preventDefault(); if (receipt) onReceipt(receipt); else void submit(); }}>
    <h2 className="modal-title" id={heading}>{header}</h2>
    {receipt ? <p role="status">这条请求已有承接。可打开对应工作查看当前状态。</p> : <fieldset disabled={busy}>
      {!upgrade && !seed.sourceUse && <div className="lead-mode" role="group" aria-label="接单方式">
        <button type="button" className="btn-ghost small" aria-pressed={intent === "continue"} onClick={() => setIntent("continue")}>交给已有主控</button>
        <button type="button" className="btn-ghost small" aria-pressed={intent === "create"} onClick={() => setIntent("create")}>建立独立主控任务</button>
      </div>}
      {intent === "continue" ? <>
        <label className="stack-field">收件目标<select className="field" value={targetId} disabled={!!seed.fixedTarget} onChange={(event) => {
          const id = event.target.value;
          const next = targets.find((item) => item.id === id)?.botLead;
          setPickedTerm(next?.kind === "appointed" ? `${next.term.termId}:${next.term.generation}` : "");
          setTargetId(id); setReopen(false); setError("");
        }}>
          <option value="">选择专题、目标与主控…</option>{targets.map((item) => {
            const label = leadTargetLabel(item, topics, workspaces);
            return <option key={item.id} value={item.id}>{label}{targets.some((other) => other.id !== item.id && leadTargetLabel(other, topics, workspaces) === label) ? ` · ${item.id.slice(-6)}` : ""}</option>;
          })}
        </select></label>
        {!targets.length && <span className="side-note">这里还没有可接收追加的主控任务。</span>}
        {picked && <p className="lead-target" title={leadTargetLabel(picked, topics, workspaces)}>{leadTargetLabel(picked, topics, workspaces)}</p>}
        {term && pickedTerm !== termKey && <div className="lead-mode"><span role="status">收件主控已变化。</span><button type="button" className="link-btn" onClick={() => setPickedTerm(termKey)}>选用当前主控</button></div>}
        {completed && <div className="lead-mode"><label><input type="checkbox" checked={reopen} onChange={(event) => setReopen(event.target.checked)} />重开这项工作</label><button type="button" className="link-btn" onClick={() => setIntent("create")}>作为新目标</button></div>}
      </> : <>
        {upgrade && original ? <p className="lead-target">{original.title || "未命名任务"} · {projectName(original.workspaceId)} · {topics.find((item) => item.id === original.topicId)?.title ?? "新建专题"}
          {original.managerTaskId && <> · 直属主控 {tasks.find((item) => item.id === original.managerTaskId)?.title ?? "待核对"}</>}</p> : <>
          <label className="stack-field">专题<select className="field" value={topicId} disabled={!!seed.topicId} onChange={(event) => changeTopic(event.target.value)}><option value="">新建专题</option>
            {topics.filter((item) => !item.archivedAt).map((item) => <option key={item.id} value={item.id}>{item.title} · {topicWorkspaceIds(item, tasks, workspaces).map(projectName).join("、") || "未选项目"}{topics.some((other) => other.id !== item.id && other.title === item.title && !other.archivedAt) ? ` · ${item.id.slice(-6)}` : ""}</option>)}</select></label>
          <label className="stack-field">项目<select className="field" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">选择本地项目…</option>
            {availableProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.path}</option>)}</select></label>
          {selectedTopic && !availableProjects.length && <div className="lead-mode"><span className="side-note">请先把一个本地项目加入专题。</span><button type="button" className="btn-ghost small" onClick={() => setEditTopic(selectedTopic)}>编辑专题项目</button></div>}
          <label className="stack-field">交付目标<input className="field" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：移植旧分支 Free UI" /></label>
        </>}
        {(upgrade ? !original?.topicId : !topicId) && <label className="stack-field">新专题名称<input className="field" maxLength={100} value={topicTitle} onChange={(event) => setTopicTitle(event.target.value)} /></label>}
        <label className="stack-field">负责机器人<select className="field" value={botId} onChange={(event) => setBotId(event.target.value)}><option value="">选择可用机器人…</option>
          {eligibleBots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name} · {eligibleProfiles.find((profile) => profile.id === bot.profileId)?.label}{bot.workspaceId ? ` · ${projectName(bot.workspaceId)}` : ""}{eligibleBots.some((other) => other.id !== bot.id && other.name === bot.name) ? ` · ${bot.id.slice(-6)}` : ""}</option>)}
          {upgrade && !!eligibleProfiles.length && <option value="new">快速创建并任命机器人…</option>}</select></label>
        {botId === "new" && <>
          <label className="stack-field">机器人名称<input className="field" maxLength={100} value={newBotName} onChange={(event) => setNewBotName(event.target.value)} /></label>
          <label className="stack-field">模型配置<select className="field" value={profileId} onChange={(event) => setProfileId(event.target.value)}>{eligibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
        </>}
      </>}
      <label className="stack-field" htmlFor={`${heading}-text`}>
        {upgrade ? "交接说明、未决问题与证据" : intent === "continue" ? "追加工作" : "原话与相关结论"}
      </label>
      <textarea id={`${heading}-text`} className="field" rows={4} maxLength={20000} value={text} onChange={(event) => setText(event.target.value)} />
    </fieldset>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="lead-actions">
      <button type="button" className="btn-ghost small" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className="btn-primary small" disabled={busy || (!receipt && !maySubmit)}>{busy ? "正在办理…" : receipt ? "打开已有承接" : intent === "continue" ? reopen ? "确认重开并追加" : "发送给主控" : "任命机器人"}</button>
    </div>
  </Modal>{editTopic && <EditTopicDialog link={link} topic={editTopic} workspaces={workspaces} tasks={tasks} onClose={() => setEditTopic(undefined)} />}</>;
}
