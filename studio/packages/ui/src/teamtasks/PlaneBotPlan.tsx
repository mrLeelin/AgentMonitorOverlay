import { useState } from "react";
import { isCommon, topicWorkspaceIds, type PlaneBotExecutionChoice, type PlaneBotJob } from "@amo-studio/protocol";
import { loadState, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { Markdown } from "../lib/markdown.js";

export function PlaneBotPlan({ link, job, busy, approve, decline }: {
  link: HostLink; job: PlaneBotJob; busy: boolean; approve(execution?: PlaneBotExecutionChoice): void; decline(): void;
}) {
  const [managed, setManaged] = useState(job.mode === "managed");
  const [topicId, setTopicId] = useState(job.topicId ?? "");
  const [topicTitle, setTopicTitle] = useState(`${job.item.number} · ${job.item.title}`.slice(0, 100));
  const [operationId] = useState(() => crypto.randomUUID());
  const [snapshot] = useLiveResource({ load: managed && !job.rootTaskId ? () => loadState(link) : null, initial: null, reset: true }, [link, managed, job.rootTaskId]);
  const topics = snapshot?.topics.filter((topic) => !topic.archivedAt && topicWorkspaceIds(topic, snapshot.tasks, snapshot.workspaces).includes(job.workspaceId)) ?? [];
  const targetId = job.rootTaskId ? job.topicId ?? "" : topics.some((topic) => topic.id === topicId) ? topicId : "";
  const confirm = () => {
    if (!managed) return approve();
    if (!job.baseCommit || !targetId && !topicTitle.trim()) return;
    approve({ mode: "managed", operationId, baseCommit: job.baseCommit, topic: targetId ? { topicId: targetId } : { topicTitle: topicTitle.trim() } });
  };
  return <section className="plane-bot-plan-choice" aria-label="确认开工">
    <p className="side-note">基准提交 <code title={job.baseCommit}>{job.baseCommit?.slice(0, 12)}</code> · 计划版本 <code title={job.planHash}>{job.planHash?.slice(0, 12)}</code></p>
    {job.project && <p className="side-note" title={job.project.path}>执行项目 {job.project.name} · <code>{job.project.path}</code></p>}
    {job.reapproval && <>
      <p className="side-note">上一版基准 <code>{job.reapproval.baseCommit.slice(0, 12)}</code>{job.reapproval.workspaceId !== job.workspaceId ? " · 执行项目已变更" : ""}</p>
      {job.reapproval.projectPath !== job.project?.path && <p className="side-note">上一版目录 <code>{job.reapproval.projectPath}</code></p>}
      <details><summary>上一版批准的计划</summary><div className="plane-bot-plan"><Markdown source={job.reapproval.plan} /></div></details>
      {job.reapproval.remainingTasks > 0 && <p className="side-note" aria-live="polite">请先在原专题归档旧版的 {job.reapproval.remainingTasks} 项下级任务，再批准新版。历史交付和工作树仍可查看。</p>}
    </>}
    {job.plan && <section className="plane-bot-plan" aria-label="Bot 计划"><Markdown source={job.plan} /></section>}
    {!job.rootTaskId && <label className="stack-field">执行方式
      <select value={managed ? "managed" : "independent"} onChange={(event) => setManaged(event.target.value === "managed")} disabled={busy}>
        <option value="independent">独立执行</option><option value="managed">机器人带队</option>
      </select>
    </label>}
    {managed && !job.rootTaskId && <>
      <label className="stack-field">承接专题
        <select value={targetId} disabled={busy} onChange={(event) => setTopicId(event.target.value)}>
          <option value="">新建专题</option>{topics.map((topic) => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
        </select>
      </label>
      {!targetId && <label className="stack-field">新专题名称<input value={topicTitle} maxLength={100} onChange={(event) => setTopicTitle(event.target.value)} disabled={busy} /></label>}
      <p className="side-note">这张原单有自己的主控和人工验收。派工在批准项目的独立工作树执行。</p>
    </>}
    {job.baseDrift && <p className="side-note" aria-live="polite">{managed ? job.baseDrift.reason
      : (job.behind ?? 0) > 0 ? `分析后项目有 ${job.behind} 个新提交。独立执行仍使用计划中的基准。` : "独立执行仍使用计划中的基准。"}{job.baseDrift.head && <> 当前提交 <code>{job.baseDrift.head.slice(0, 12)}</code></>}</p>}
    <div className="plane-bot-review-footer">
      <button type="button" className="btn-ghost small" disabled={busy || !job.planHash} onClick={decline}>放弃</button>
      <button type="button" className="btn-primary small" disabled={busy || !job.planHash || !job.plan || managed && (!!job.baseDrift || !targetId && !topicTitle.trim() || !!job.reapproval?.remainingTasks || !job.rootTaskId && !snapshot)} onClick={confirm}>
        {managed ? job.reapproval ? "批准新版" : "批准并让机器人带队" : "开工"}
      </button>
    </div>
  </section>;
}

export function PlaneBotReplanControl({ link, job, busy, replan }: {
  link: HostLink; job: PlaneBotJob; busy: boolean; replan(workspaceId?: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(job.workspaceId);
  const [snapshot] = useLiveResource({ load: open ? () => loadState(link) : null, initial: null, reset: true }, [link, open]);
  if (job.taskId || !job.planHash || !job.jobId || job.state === "planning" || (!job.rootTaskId && job.state !== "awaiting-approval") ||
      job.state === "sending" || job.failureStage === "writeback" || (job.reapproval && job.state === "failed")) return null;
  const topic = snapshot?.topics.find((candidate) => candidate.id === job.topicId);
  const allowed = topic && snapshot ? topicWorkspaceIds(topic, snapshot.tasks, snapshot.workspaces) : null;
  const workspaces = snapshot?.workspaces.filter((ws) => !ws.archivedAt && !isCommon(ws) && (!allowed || allowed.includes(ws.id))) ?? [];
  return <details className="plane-bot-replan" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>重新分析范围或基准</summary>
    <label className="stack-field">重新分析的项目
      <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} disabled={busy}>
        {workspaces.length ? workspaces.map((ws) => <option key={ws.id} value={ws.id}>{ws.name}</option>) : <option value={job.workspaceId}>当前项目</option>}
      </select>
    </label>
    {job.rootTaskId && <p className="side-note">重新分析后须明确批准新版。旧版下级和已发出的评论留作历史。</p>}
    <button type="button" className="btn-ghost small" disabled={busy || !snapshot || !workspaces.some((workspace) => workspace.id === workspaceId)} onClick={() => replan(workspaceId)}>重新分析</button>
  </details>;
}
