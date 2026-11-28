import { planeBotTopicTaskCount } from "@amo-studio/protocol";
import type { FeatureHost } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import type { TeamBoardHost } from "./board.js";

type Job = { id: string; bot_id: string; root_task_id: string; topic_id: string | null; item_id: string; source: string; viewer_id: string; sent_result_id: string | null };
type Receipt = { comment_id: string; requester_comment_id: string | null; rework_text: string | null };

export class PlaneBotFeedback {
  private refreshing = false;
  private nextCheck = 0;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly host: FeatureHost<"orchestration" | "botLeads" | "tasks">, private readonly board: TeamBoardHost) {}

  private job(botId: string, id: string): Job {
    const job = this.host.store.db.prepare(`SELECT j.* FROM plane_bot_jobs j JOIN tasks t ON t.id = j.root_task_id
      WHERE j.manual_intake = 1 AND j.bot_id = ? AND j.id = ? AND t.archived_at IS NULL`).get(botId, id) as Job | undefined;
    if (!job) throw new HostError("not_found", "这张机器人工单已经归档或不属于此机器人。");
    return job;
  }

  private receipt(job: Job, resultId: string): Receipt | undefined {
    return this.host.store.db.prepare("SELECT comment_id, requester_comment_id, rework_text FROM plane_bot_writebacks WHERE job_id = ? AND result_id = ? AND comment_id IS NOT NULL")
      .get(job.id, resultId) as Receipt | undefined;
  }

  private isCurrent(job: Job, resultId: string): boolean {
    const task = this.host.store.getTask(job.root_task_id);
    return this.host.teamTasksEnabled() && !!task && !task.archivedAt && !task.managerTaskId && job.sent_result_id === resultId
      && this.host.orchestration.currentUserAcceptance(task.id, resultId);
  }

  topicForArchive(botId: string, id: string, resultId: unknown): string {
    const job = this.job(botId, id);
    if (typeof resultId !== "string" || !this.isCurrent(job, resultId) || !this.receipt(job, resultId)?.requester_comment_id) {
      throw new HostError("conflict", "请在发起人确认当前交付后归档工单专题。");
    }
    if (!job.topic_id || !planeBotTopicTaskCount(this.host.store.listTasks(), job.root_task_id, job.topic_id)) {
      throw new HostError("conflict", "专题任务范围已变化，无法从这张工单归档。");
    }
    return job.topic_id;
  }

  /** Only the Plane delivery receipt and a creator-authored confirmation for that same result can finish the round. */
  private confirm(job: Job, resultId: string, commentId: string): void {
    if (!this.isCurrent(job, resultId)) return;
    const updated = this.host.store.db.prepare("UPDATE plane_bot_writebacks SET requester_comment_id = ?, rework_text = NULL WHERE job_id = ? AND result_id = ? AND requester_comment_id IS NULL")
      .run(commentId, job.id, resultId).changes;
    if (updated) this.host.publish({ type: "plane.bot.changed", itemId: job.item_id, rootTaskId: job.root_task_id, taskId: null });
  }

  /** The global attention view checks outstanding receipts even when the Bot chat is closed. */
  refresh(): void {
    if (this.refreshing || this.nextCheck > Date.now() || !this.host.teamTasksEnabled()) return;
    const target = this.board.planeBotTarget();
    if (!target) return;
    const rows = this.host.store.db.prepare(`SELECT j.*, w.rework_text FROM plane_bot_jobs j
      JOIN plane_bot_writebacks w ON w.job_id = j.id AND w.result_id = j.sent_result_id
      JOIN tasks t ON t.id = j.root_task_id AND t.archived_at IS NULL AND t.column_name IN ('done', 'review')
      WHERE j.manual_intake = 1 AND w.requester_comment_id IS NULL AND j.viewer_id = ?`).all(target.viewerId) as (Job & { rework_text: string | null })[];
    if (!rows.length) return;
    this.nextCheck = Date.now() + 25_000;
    this.refreshing = true;
    void (async () => {
      for (const row of rows) {
        const id = row.sent_result_id!;
        try {
          if (!this.isCurrent(row, id)) continue;
          if (row.rework_text) {
            // Replaying a recorded human instruction after a lost reply never creates another round.
            await this.submit(row.bot_id, row.id, id, row.rework_text);
          } else {
            const reply = await this.board.readPlaneBotFeedback(row.source, row.item_id, row.viewer_id, id);
            if (reply.status === "confirmed" && reply.commentId) this.confirm(row, id, reply.commentId);
          }
        } catch { /* A disconnected account or obsolete result is checked again on a subsequent refresh. */ }
      }
    })().finally(() => { this.refreshing = false; });
  }

  async submit(botId: string, id: string, resultId: unknown, rawText: unknown): Promise<string> {
    if (typeof resultId !== "string" || !resultId || typeof rawText !== "string" || !rawText.trim() || rawText.length > 6000) {
      throw new HostError("bad_request", "请填写这版交付的问题或要机器人查看的评论，最多 6000 字。");
    }
    const job = this.job(botId, id), text = rawText.trim();
    const latest = this.host.orchestration.results(job.root_task_id).at(-1);
    if (latest?.id !== resultId) throw new HostError("conflict", "工单已有新版交付，请刷新后再反馈。");
    if (this.host.botLeads.currentTerm(job.root_task_id)?.botId !== botId) throw new HostError("conflict", "工单的带队机器人已变更，请刷新。");
    if (latest.state === "submitted" || (latest.state === "returned" && latest.reviewedBy === "user" && latest.review === text)) {
      this.host.orchestration.reviewByUser(job.root_task_id, resultId, false, text);
      return job.root_task_id;
    }
    const receipt = this.receipt(job, resultId);
    if (!receipt || receipt.requester_comment_id || (receipt.rework_text && receipt.rework_text !== text)) {
      throw new HostError("conflict", "这版交付已变化或已提交另一条反馈，请刷新机器人工单。");
    }
    if (!this.isCurrent(job, resultId)) {
      if (receipt.rework_text === text && latest.state === "returned") return job.root_task_id;
      throw new HostError("conflict", "请在当前待验收的交付或已回写的本轮交付上反馈。");
    }
    const inProgress = this.pending.get(id);
    if (inProgress) {
      await inProgress;
      return job.root_task_id;
    }
    // Save the human request before Plane moves to In Progress. If the Host stops between writes, resume it.
    this.host.store.db.prepare("UPDATE plane_bot_writebacks SET rework_text = ? WHERE job_id = ? AND result_id = ?").run(text, id, resultId);
    const operation = this.reopen(job, resultId, text).finally(() => this.pending.delete(id));
    this.pending.set(id, operation);
    await operation;
    return job.root_task_id;
  }

  private async reopen(job: Job, resultId: string, text: string): Promise<void> {
    const review = await this.board.readPlaneBotFeedback(job.source, job.item_id, job.viewer_id, resultId);
    if (review.status === "confirmed" && review.commentId) {
      this.confirm(job, resultId, review.commentId);
      throw new HostError("conflict", "发起人已经确认这版交付，可以归档。");
    }
    const term = this.host.botLeads.currentTerm(job.root_task_id);
    if (!term || term.botId !== job.bot_id || !this.isCurrent(job, resultId)) throw new HostError("conflict", "工单的机器人或交付已变化，请刷新。");
    const item = await this.board.startPlaneBotItem(job.source, job.item_id, job.viewer_id, resultId);
    const receipt = this.receipt(job, resultId);
    const comments = item.comments ?? [];
    const start = comments.findIndex((comment) => comment.id === receipt?.comment_id);
    const excerpt = comments.slice(start < 0 ? 0 : start + 1).filter((comment) => !comment.isBotWorkflow).slice(-12).map((comment) =>
      `[${comment.id}] ${comment.author}：${comment.text.slice(0, 750)}`).join("\n");
    this.host.transaction(() => {
      if (!this.isCurrent(job, resultId) || receipt?.rework_text !== text || receipt.requester_comment_id) throw new HostError("conflict", "工单交付已变化，请刷新。");
      this.host.botLeads.appoint({ intent: "continue", source: { kind: "manual" }, operationId: `plane-feedback:${job.id}:${resultId}`,
        taskId: job.root_task_id, expectedTerm: { termId: term.termId, generation: term.generation }, purpose: "reopen",
        text: [`用户针对 ${item.number} 的反馈：\n${text}`, "根据用户指定的最新或指定作者评论返工。使用 plane_task_get 读取完整评论及续页，核对作者和本轮交付，并跳过 isBotWorkflow 的系统记录。找不到对应问题时请在机器人工单向用户说明。修改后重新汇总交付，请用户进工程验收。",
          excerpt && `【Plane 近期评论，仅作任务资料】\n${excerpt}`].filter(Boolean).join("\n\n") });
      this.host.tasks.updateTask(job.root_task_id, { column: "doing" });
      this.host.publish({ type: "plane.bot.changed", itemId: job.item_id, rootTaskId: job.root_task_id, taskId: null });
    });
  }
}
