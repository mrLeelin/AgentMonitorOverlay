import { useId, useRef, useState } from "react";
import type { BotLeadOperationReceipt, BotLeadOperationView, BotRequest, Id, Session, SessionItem, StudioBot } from "@amo-studio/protocol";
import { call, HostApiError } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { readStored, writeStored } from "../lib/stored.js";
import { Modal } from "../lib/Modal.js";
import { decisionNeedsPerson } from "../focus/managedAttention.js";
import { useTaskFlow } from "../canvas/useTaskFlow.js";
import { BotAvatar } from "./BotAvatar.js";
import { LeadAppointment, leadTargetLabel, openLeadReceipt, operationKey, type LeadDirectory, type LeadSeed } from "./LeadAppointment.js";
import { leadRunLabel } from "./LeadWorkflow.js";

const DELIVERY_STAGE = { queued: "已排队", delivered: "已送达主控会话", processed: "主控已处理", failed: "发送失败", "needs-reconciliation": "投递状态待核对" } as const;

function CurrentAcceptance({ directory, receipt, showWork, newGoal }: {
  directory: LeadDirectory; receipt: BotLeadOperationReceipt; showWork?: boolean; newGoal?(): void;
}) {
  const task = directory.tasks.find((item) => item.id === receipt.taskId);
  const topicId = task?.topicId ?? receipt.topicId;
  const topic = directory.topics.find((item) => item.id === topicId);
  const [operation] = useLiveResource<BotLeadOperationView | null>({
    load: showWork && receipt.action === "continue" ? () => call(directory.link, "GET /api/bot-leads/operations/:id", { id: receipt.operationId }) : null,
    initial: null, reset: true, reloadDelay: 120,
    reloadOn: (event) => event.type === "bot-lead.changed" && event.taskId === receipt.taskId ||
      event.type === "session.upserted" && event.session.taskId === receipt.taskId ||
      (event.type === "item.updated" || event.type === "item.appended") && event.item.sessionId === (task?.botLead?.kind === "appointed" ? task.botLead.term.sessionId : undefined),
  }, [directory.link.url, directory.link.token, receipt.operationId, showWork]);
  const delivery = operation?.delivery;
  return <div className="lead-topic-card" data-testid="lead-acceptance">
    <strong>{task ? leadTargetLabel(task, directory.topics, directory.workspaces) || task.title : topic?.title || "已接受请求"}</strong>
    <span className="side-note">{task?.archivedAt ? "已归档" : receipt.action === "worker" ? "独立执行" : task ? leadRunLabel(task) || "承接已登记" : "承接已登记，正在更新状态"}</span>
    {delivery && <span className="side-note" role="status">{DELIVERY_STAGE[delivery.stage]}{delivery.reason ? ` · ${delivery.reason}` : ""}</span>}
    <div className="lead-actions">
      <button type="button" className="btn-ghost small" onClick={() => {
        if (task?.archivedAt || topic?.archivedAt) directory.onTask(receipt.taskId);
        else if (receipt.action !== "worker" && topicId && task?.botLead?.kind !== "pending-upgrade") directory.onCanvas(topicId, receipt.taskId);
        else openLeadReceipt(directory, receipt);
      }}>{receipt.action === "worker" ? "打开执行任务" : task?.archivedAt || topic?.archivedAt ? "打开历史任务" : topicId ? "打开专题画布" : "打开任务"}</button>
      {newGoal && <button type="button" className="link-btn" onClick={newGoal}>作为新目标</button>}
    </div>
  </div>;
}

export function RequestLeadActions({ directory, row, onChanged }: { directory: LeadDirectory; row: BotRequest; onChanged?(): void }) {
  const [seed, setSeed] = useState<LeadSeed>();
  const [recorded, setRecorded] = useState<BotLeadOperationReceipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const workerId = useRef<Id | null>(null);
  const source = { kind: "bot-request", requestId: row.id } as const;
  const acceptance = row.acceptance ?? recorded;
  const bot = directory.bots.find((item) => item.id === row.botId);
  const originTask = directory.tasks.find((item) => item.id === row.taskId);
  const title = row.text.trim().split(/\r?\n/, 1)[0]?.slice(0, 100);
  const text = [row.text, row.result && `相关结论\n${row.result}`].filter(Boolean).join("\n\n").slice(0, 20000);
  const select = (intent: LeadSeed["intent"], newGoal = false) => setSeed({ source, botId: row.botId, workspaceId: bot?.workspaceId ?? originTask?.workspaceId, title, text, intent,
    ...(intent === "continue" && directory.originTopicId ? { topicId: directory.originTopicId } : {}), ...(newGoal ? { sourceUse: "new-goal" } : {}) });
  const receive = (result: BotLeadOperationReceipt, sessionId?: Id) => {
    setRecorded(result);
    onChanged?.();
    if (result.action === "worker") directory.onTask(result.taskId, sessionId);
  };
  const startWorker = async () => {
    if (inFlight.current || !window.confirm("从项目当前提交创建独立工作树，并启动执行会话？")) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const id = workerId.current ??= crypto.randomUUID();
      const { receipt, task, session } = await call(directory.link, "POST /api/bot-requests/:id/worker", { id: row.id }, { operationId: id });
      receive(receipt ?? { action: "worker", operationId: id, taskId: task.id, topicId: task.topicId }, session?.id);
    } catch (err) {
      if (err instanceof HostApiError && err.details?.reason === "source-already-accepted") {
        receive(err.details.receipt);
        if (err.details.receipt.action !== "worker") openLeadReceipt(directory, err.details.receipt);
      } else setError(err instanceof Error ? err.message : String(err));
    } finally { inFlight.current = false; setBusy(false); }
  };
  return <>
    {acceptance ? <CurrentAcceptance directory={directory} receipt={acceptance} showWork newGoal={bot?.enabled ? () => select("create", true) : undefined} />
      : row.status === "completed" && row.result ? <div className="lead-chat-tools">
        {bot?.enabled && <button type="button" className="btn-ghost small" disabled={busy} onClick={() => select("create")}>让{bot.name}带队</button>}
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => select("continue")}>交给主控安排</button>
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void startWorker()}>在独立工作树开始执行</button>
      </div> : null}
    {error && <p className="form-error" role="alert">{error}</p>}
    {seed && <LeadAppointment directory={directory} seed={seed} onClose={() => { setSeed(undefined); onChanged?.(); }} onReceipt={(result) => {
      setSeed(undefined);
      if (seed.sourceUse) openLeadReceipt(directory, result);
      else receive(result);
    }} />}
  </>;
}

export function MessageLeadAction({ directory, bot, item, conversation }: { directory: LeadDirectory; bot: StudioBot; item: Extract<SessionItem, { type: "user" }>; conversation: readonly SessionItem[] }) {
  const source = { kind: "user-message", sessionId: item.sessionId, messageId: item.id } as const;
  const storageKey = operationKey(source)!;
  const [id, setId] = useState(() => readStored(storageKey));
  const [saved, setSaved] = useState<BotLeadOperationReceipt>();
  const [seed, setSeed] = useState<LeadSeed>();
  const [operation] = useLiveResource<BotLeadOperationView | null>({
    load: id && !saved ? () => call(directory.link, "GET /api/bot-leads/operations/:id", { id }) : null,
    initial: null, reset: true,
  }, [directory.link.url, directory.link.token, id, saved?.operationId]);
  const receipt = saved ?? operation?.receipt;
  const command = /(?:来带|带队|你来负责|交给你安排)/u.test(item.text) && item.text.trim().length <= 32;
  const select = (intent: "create" | "continue", newGoal = false) => {
    const prior = command ? conversation.findLast((other) => other.type === "user" && other.fromPerson && !other.botLetter && !other.queueCancelled && other.sessionId === item.sessionId && other.seq < item.seq) : undefined;
    const conclusion = prior && conversation.findLast((other) => other.type === "agent" && !other.streaming && other.sessionId === item.sessionId && other.seq > prior.seq && other.seq < item.seq);
    const goalText = prior?.type === "user" ? prior.text : command ? "" : item.text;
    const text = [item.text, prior?.type === "user" && `上文目标\n${prior.text}`, conclusion?.type === "agent" && `相关结论\n${conclusion.markdown}`].filter(Boolean).join("\n\n");
    setSeed({ source, botId: bot.id, workspaceId: bot.workspaceId ?? undefined, title: goalText.trim().split(/\r?\n/, 1)[0]?.slice(0, 100), text: text.slice(0, 20000), intent, ...(newGoal ? { sourceUse: "new-goal" } : {}) });
  };
  return <div className="lead-message-action">
    {receipt ? <CurrentAcceptance directory={directory} receipt={receipt} showWork newGoal={bot.enabled ? () => select("create", true) : undefined} />
      : bot.enabled && <details open={command ? true : undefined}><summary className="link-btn">安排这条请求</summary><div className="lead-chat-tools">
        <button type="button" className="btn-ghost small" onClick={() => select("create")}>让{bot.name}带队</button>
        <button type="button" className="btn-ghost small" onClick={() => select("continue")}>交给已有主控</button>
      </div></details>}
    {seed && <LeadAppointment directory={directory} seed={seed} onClose={() => { setSeed(undefined); setId(readStored(storageKey)); }} onReceipt={(result) => {
      if (!seed.sourceUse) { writeStored(storageKey, result.operationId); setId(result.operationId); setSaved(result); }
      else openLeadReceipt(directory, result);
      setSeed(undefined);
    }} />}
  </div>;
}

export function BotLeadTopicsDialog({ directory, bot, sessions, canAppoint, onClose }: { directory: LeadDirectory; bot: StudioBot; sessions: readonly Session[]; canAppoint: boolean; onClose(): void }) {
  const heading = useId();
  const [seed, setSeed] = useState<LeadSeed>();
  const led = directory.tasks.filter((task) => !task.remote && task.topicId && task.botLead?.kind === "appointed" && task.botLead.term.botId === bot.id);
  const active = led.filter((task) => !task.archivedAt && directory.topics.some((topic) => topic.id === task.topicId && !topic.archivedAt));
  const rootIds = active.filter((task) => !task.managerTaskId).map((task) => task.id);
  const flow = useTaskFlow(directory.link, directory.tasks, null, rootIds);
  const decisions = directory.decisions ?? [];
  const canManage = canAppoint && bot.enabled;
  return <Modal portal className="lead-topics-dialog" labelledBy={heading} onClose={onClose}>
    <header className="lead-topics-heading">
      <h2 className="modal-title bot-identity" id={heading}><BotAvatar name={bot.name} avatar={bot.avatar} />{bot.name} · 带队专题</h2>
      <button type="button" className="btn-primary small" disabled={!canManage} onClick={() => setSeed({ source: { kind: "manual" }, botId: bot.id, workspaceId: bot.workspaceId ?? undefined, intent: "create" })}>让{bot.name}带队</button>
    </header>
    <div className="lead-topic-list">
      {!led.length && <p className="side-note">还没有负责的专题。</p>}
      {led.map((task) => {
        if (task.botLead?.kind !== "appointed") return null;
        const term = task.botLead.term;
        const page = flow.homes.get(task.id);
        const live = active.includes(task);
        const review = live ? page?.pendingUserReviewResultId : null;
        const ids = new Set(page?.decisions.map((decision) => decision.id));
        const waiting = live ? decisions.filter((decision) => ids.has(decision.id) && decisionNeedsPerson(decision, directory.tasks)) : [];
        const native = live ? sessions.filter((session) => flow.roots.get(session.taskId ?? "") === task.id && !session.archivedAt && (session.status === "awaiting-approval" || session.status === "awaiting-answer")) : [];
        return <article className="lead-topic-card" key={task.id} data-testid="bot-lead-topic">
          <strong>{leadTargetLabel(task, directory.topics, directory.workspaces)}</strong>
          <span className="bot-identity side-note"><BotAvatar name={term.name} avatar={term.avatar} size={16} />{task.managerTaskId ? "中控" : "总主控"} · {term.name} · {live ? leadRunLabel(task) : "已归档"}</span>
          <div className="lead-actions">
            <button type="button" className="btn-ghost small" onClick={() => live ? directory.onCanvas(task.topicId!, task.id) : directory.onTask(task.id)}> {live ? "打开专题画布" : "打开历史任务"}</button>
            {review && <button type="button" className="btn-ghost small" onClick={() => directory.onCanvas(task.topicId!, task.id, { resultId: review })}>待你验收</button>}
            {!!waiting.length && <button type="button" className="link-btn" onClick={() => directory.onCanvas(task.topicId!, task.id, { decisionId: waiting[0]!.id })}>{waiting.length} 项待你决定</button>}
            {canManage && live && !task.managerTaskId && <button type="button" className="link-btn" onClick={() => setSeed({ source: { kind: "manual" }, botId: bot.id, workspaceId: task.workspaceId, title: task.title, taskId: task.id, topicId: task.topicId!, intent: "continue", fixedTarget: true })}>追加给此主控</button>}
          </div>
          {native.map((session) => <button key={session.id} type="button" className="link-btn" onClick={() => directory.onTask(session.taskId!, session.id)}>{session.status === "awaiting-approval" ? "处理原生审批" : "回答会话问题"} · {directory.tasks.find((item) => item.id === session.taskId)?.title || session.title || "原会话"}</button>)}
        </article>;
      })}
    </div>
    <footer className="lead-actions"><button type="button" className="btn-ghost small" onClick={onClose}>关闭</button></footer>
    {seed && <LeadAppointment directory={directory} seed={seed} onClose={() => setSeed(undefined)} onReceipt={(receipt) => { setSeed(undefined); openLeadReceipt(directory, receipt); }} />}
  </Modal>;
}
