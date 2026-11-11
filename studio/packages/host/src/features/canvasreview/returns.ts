import { createHash } from "node:crypto";
import { REVIEW_STATUSES, splitRoleUpdate, type CanvasDoc, type CanvasItem, type CanvasReturnReceipt, type CanvasReturnStatus, type Id, type MailMessage } from "@amo-studio/protocol";
import { Feature } from "../../core/feature.js";
import { newId } from "../../store/store.js";

const KEY = "canvas.review-returns";
const fingerprint = (item: CanvasItem) => createHash("sha256").update(JSON.stringify([item.title, item.body ?? "", item.status, item.conclusion ?? "", item.refs ?? []])).digest("hex");
const settled = (item: CanvasItem) => item.status === "confirmed" || item.status === "done" || item.status === "parked";
const roundKey = (item: CanvasItem) => JSON.stringify([item.sessionId, item.groupId]);
type Round = { signature: string; itemIds: Id[]; groupId: Id | null; targetSessionId: Id; messageId?: Id; replacesItemId?: Id; text?: string; pending?: boolean; error?: string };
type TopicReturns = { seen: Record<Id, string>; receipts: Record<Id, CanvasReturnReceipt>; rounds: Record<string, Round> };
const empty = (): TopicReturns => ({ seen: {}, receipts: {}, rounds: {} });

/** Confirmation is a durable handback, not another prompt the person has to carry (2026-11-08). */
export class CanvasReturns extends Feature<"sessions"> {
  private data: Record<Id, TopicReturns> = {};
  private readonly sending = new Set<Id>();

  watch(): void {
    this.data = JSON.parse(this.store.getKv(KEY)?.value ?? "{}");
    // Installing this feature must not resume historical work merely because its cards were already confirmed.
    for (const topic of this.store.listTopics()) {
      if (this.data[topic.id]) continue;
      const state = this.data[topic.id] = empty();
      for (const item of this.store.getCanvas(topic.id)?.nodes ?? []) if (item.kind === "item") state.seen[item.id] = fingerprint(item);
    }
    this.save();
    this.host.on("event", (event) => {
      if (event.type === "canvas.updated") this.changed(event.canvas, event.actorSessionId);
    });
    for (const topicId of Object.keys(this.data)) this.deliver(topicId);
  }

  status(topicId: Id): CanvasReturnStatus {
    this.requireTopic(topicId);
    const state = this.data[topicId] ?? empty();
    return {
      receipts: Object.values(state.receipts),
      rounds: Object.values(state.rounds).filter((r) => r.messageId).map((r) => {
        const row = this.store.getItem(r.messageId!);
        const failed = !!r.error || (row?.type === "user" && row.delivery === "unsent");
        const queued = row?.type === "user" && (row.delivery === "held" || row.delivery === "waiting");
        return { groupId: r.groupId, targetSessionId: r.targetSessionId, state: failed ? "failed" : queued ? "queued" : r.pending ? "pending" : "sent", retryable: !!r.error, detail: r.error || (failed ? "继续通知未送达，请在来源会话中重新发送。" : queued ? "已进入收件箱，等待来源会话可接收时继续。" : r.pending ? "正在回传本轮结论。" : "已通知来源会话读取最新结论并继续。") };
      }),
    };
  }

  retry(topicId: Id): CanvasReturnStatus {
    const doc = this.store.getCanvas(topicId);
    this.requireLiveTopic(topicId);
    const state = this.data[topicId];
    if (doc && state) {
      // Re-evaluate only failed receipts; a retry cannot manufacture a new confirmation.
      for (const receipt of Object.values(state.receipts)) if (receipt.state === "blocked") state.seen[receipt.itemId] = "retry";
      this.changed(doc);
      for (const round of Object.values(state.rounds)) if (round.error) { round.pending = true; delete round.error; }
      this.save();
      this.deliver(topicId);
    }
    return this.status(topicId);
  }

  private changed(doc: CanvasDoc, actorSessionId?: Id): void {
    if (this.store.getTopic(doc.id)?.archivedAt) return;
    const state = this.data[doc.id] ??= empty();
    const previousStatus = JSON.stringify([state.receipts, state.rounds]);
    const items = doc.nodes.filter((n): n is CanvasItem => n.kind === "item");
    const changedRounds = new Set<string>();
    const mails: MailMessage[] = [];
    this.store.transaction(() => {
      for (const item of items) {
        const next = fingerprint(item), previous = state.seen[item.id];
        state.seen[item.id] = next;
        if (!previous || previous === next) continue;
        // A source writing its own progress already knows it. In particular, marking work done must not loop.
        if (actorSessionId && actorSessionId === item.sessionId) continue;
        if (!settled(item) && !state.receipts[item.id]) continue;
        changedRounds.add(roundKey(item));
        const source = item.sessionId ? this.store.getSession(item.sessionId) : undefined;
        const task = source?.taskId ? this.store.getTask(source.taskId) : undefined;
        const targetLabel = task?.lead ? "主控" : "来源会话";
        const receipt: CanvasReturnReceipt = { itemId: item.id, targetSessionId: source?.id ?? null, targetLabel, state: "blocked", detail: "来源会话不可用，结论已保留；恢复来源后可重试回传。", at: new Date().toISOString() };
        if (source && !source.archivedAt && source.kind !== "sub" && source.runtime !== "remote" && source.writer !== "archived" && (task ? !task.archivedAt && task.topicId === doc.id : source.topicId === doc.id)) {
          const label = REVIEW_STATUSES.find((s) => s.id === item.status)!.label;
          const mail: MailMessage = { id: newId("mail"), fromSessionId: actorSessionId ?? null, fromTaskId: actorSessionId ? this.store.getSession(actorSessionId)?.taskId ?? null : null, fromTopicId: doc.id, to: { kind: "session", sessionId: source.id }, text: `【画布结论回传】#${item.num}「${item.title}」：${label}\n${item.conclusion || item.body || "（仅确认状态，未填写结论）"}\n\n以 canvas_read 的最新内容为准；尚未收齐时先保留，整轮处理完会自动通知继续。`, state: "unread", createdAt: receipt.at, handledAt: null };
          this.store.putMail(mail);
          mails.push(mail);
          receipt.state = "returned";
          receipt.detail = settled(item) ? `结论已回传${targetLabel}，本轮收齐后自动继续。` : `问题已重新打开，已通知${targetLabel}以最新画布为准。`;
        }
        state.receipts[item.id] = receipt;
      }
      const live = new Set(items.map((item) => item.id));
      for (const id of Object.keys(state.seen)) if (!live.has(id)) { delete state.seen[id]; delete state.receipts[id]; }
      const keys = new Set(items.map(roundKey));
      for (const [key, round] of Object.entries(state.rounds)) {
        const members = items.filter((item) => roundKey(item) === key);
        if (keys.has(key) && members.every(settled) && JSON.stringify(members.map((item) => item.id).sort()) === JSON.stringify(round.itemIds)) continue;
        // A reopened/deleted question revokes a continuation that has not entered the model yet.
        const row = round.messageId ? this.store.getItem(round.messageId) : undefined;
        if (row?.type === "user" && row.delivery === "held") this.f.sessions.inbox.expire(row.id, "画布继续通知已撤回：问题已重新打开或分组内容已改变，请等待最新确认；本通知不再要求实施。");
        delete state.rounds[key];
      }
      for (const key of changedRounds) {
        const members = items.filter((item) => roundKey(item) === key);
        if (!members.length || !members.every(settled) || members.some((item) => state.receipts[item.id]?.state === "blocked")) continue;
        const source = members[0]!.sessionId;
        if (!source || source === actorSessionId) continue;
        const signature = members.map((item) => `${item.id}:${fingerprint(item)}`).sort().join("|");
        if (state.rounds[key]?.signature === signature) continue;
        const groupId = members[0]!.groupId;
        const group = doc.groups.find((g) => g.id === groupId)?.title ?? "未分组";
        const old = state.rounds[key];
        const queued = old?.messageId ? this.store.getItem(old.messageId) : undefined;
        const replacing = queued?.type === "user" && queued.delivery === "held" ? queued : undefined;
        const messageId = old?.pending && !queued ? old.messageId! : newId("i-canvas-return");
        const replacesItemId = replacing?.id ?? (old?.pending && !queued ? old.replacesItemId : undefined);
        // Enqueued rows are immutable. Carry the still-unheard role update into a new notification, without
        // copying its frozen shared-context token; the inbox captures the current requirement for the new row.
        const previousText = replacing?.text ?? (old?.pending && !queued ? old.text : undefined);
        const contextAt = previousText?.search(/^\[AMO_SHARED_CONTEXT:/m) ?? -1;
        const role = previousText ? splitRoleUpdate(contextAt < 0 ? previousText : previousText.slice(0, contextAt).trimEnd()).update : null;
        if (replacing) this.f.sessions.inbox.expire(replacing.id, "画布结论已变化；此继续通知已由最新结论替代，保留历史。");
        state.rounds[key] = { signature, itemIds: members.map((item) => item.id).sort(), groupId, targetSessionId: source, messageId, ...(replacesItemId ? { replacesItemId } : {}), pending: true, text: [
          `【画布本轮已确认】专题「${this.requireTopic(doc.id).title}」分组「${group}」的 ${members.length} 条问题已处理完。`,
          ...members.map((item) => `- #${item.num}「${item.title}」【${REVIEW_STATUSES.find((s) => s.id === item.status)!.label}】：${(item.conclusion || item.body || "仅确认状态").slice(0, 1000)}`),
          "", "请先用 canvas_read 读取最新画布（本消息可能在收件箱等待过）；只处理来源为你、属于上述分组的条目。若有重新打开的问题，先等待其确认，旧消息不代表它已确认。",
          "汇总最新结论，按原任务已经获得的授权继续推进；原任务授权实施时组织实施和测试，遵守当前角色与权限约束；只授权讨论或测试时保持原范围。搁置条目不实施，已完成的工作不重复执行；结论有变化时只处理差异。新的待决问题写回画布。无需让用户再转述已确认结论，也无需重复发邮件。",
          ...(role ? ["", role] : []),
        ].join("\n") };
      }
      this.save();
    });
    for (const mail of mails) this.publish({ type: "mail.upserted", mail });
    if (previousStatus !== JSON.stringify([state.receipts, state.rounds])) this.publish({ type: "canvas.returns.updated", topicId: doc.id });
    this.deliver(doc.id);
  }

  private save(): void { this.store.setKv(KEY, JSON.stringify(this.data)); }

  private deliver(topicId: Id): void {
    if (this.sending.has(topicId) || this.store.getTopic(topicId)?.archivedAt) return;
    this.sending.add(topicId);
    // Synchronous canvas writes in the same turn coalesce before dispatch.
    void Promise.resolve().then(async () => {
      const state = this.data[topicId];
      if (!state) return;
      for (const round of Object.values(state.rounds)) {
        if (!round.pending || !round.messageId || !round.text) continue;
        if (!Object.values(state.rounds).includes(round)) continue;
        try {
          await this.f.sessions.inbox.put(round.targetSessionId, round.text, undefined, round.messageId, { ...(round.replacesItemId ? { replacesItemId: round.replacesItemId } : {}) });
          round.pending = false;
          delete round.error;
        } catch (error) {
          round.pending = false;
          round.error = error instanceof Error ? error.message : String(error);
        }
        this.save();
        this.publish({ type: "canvas.returns.updated", topicId });
      }
    }).catch((error: unknown) => this.log(`canvas returns: ${String(error)}`)).finally(() => {
      this.sending.delete(topicId);
      if (Object.values(this.data[topicId]?.rounds ?? {}).some((r) => r.pending)) this.deliver(topicId);
    });
  }
}
