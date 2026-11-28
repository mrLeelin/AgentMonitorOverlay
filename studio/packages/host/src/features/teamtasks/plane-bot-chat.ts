import { z } from "zod";
import { splitRoleUpdate, type PlaneBotJob } from "@amo-studio/protocol";
import type { FeatureHost } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import { PLANE_BOT_FEEDBACK_TOOL, PLANE_BOT_ORDERS_TOOL } from "../../mcp/names.js";
import { writeAsync, type AmoTool, type McpCaller } from "../../mcp/tool-kit.js";
import { personsMessage } from "../../runtime/items.js";
import { assertBotTaskEnabled, isBotHome } from "../bots/data.js";

export function planeBotChatTools(service: FeatureHost<"bots" | "teamTasks">, caller: McpCaller | null): AmoTool[] {
  if (!service.teamTasksEnabled() || (caller && !isBotHome(service.store, caller.sessionId))) return [];
  const owner = (sessionId: string) => {
    service.requireTeamTasks();
    const chat = service.store.getSession(sessionId);
    const bot = service.bots.list().find((candidate) => candidate.homeSessionId === sessionId);
    if (!bot?.taskId || !chat || chat.archivedAt || chat.taskId !== bot.taskId || chat.kind !== "main" || chat.runtime === "remote") {
      throw new HostError("read_only", "请从接单机器人的主聊天处理 Plane 工单。");
    }
    assertBotTaskEnabled(service.store, bot.taskId);
    return bot;
  };
  const summary = (job: PlaneBotJob) => ({
    jobId: job.jobId, ...job.item, state: job.state, requesterReview: job.requesterReview,
    resultId: job.delivery?.resultId, summary: job.delivery?.summary, verification: job.delivery?.verification,
  });
  return [{
    name: PLANE_BOT_ORDERS_TOOL, title: "查看我的 Plane 工单或原单评论", readOnly: true, autoApprove: true,
    description: "In the receiving Bot's home chat, list its manual Plane work items and current deliveries. With a jobId, read its live comments newest first. Follow nextOffset for a named author and use commentId and offset for a long comment. Only return feedback relevant to the person's request.",
    inputSchema: { jobId: z.string().max(100).optional(), commentId: z.uuid().optional(), offset: z.number().int().min(0).max(9_999_999).optional() },
    run: (args) => writeAsync(caller, async ({ sessionId }) => {
      const bot = owner(sessionId);
      const jobs = (await service.teamTasks.planeBots.forBot(bot.id, true)).filter((job) => job.manualIntake && job.mode === "managed"
        && job.rootTaskId && !service.store.getTask(job.rootTaskId)?.archivedAt);
      if (!args.jobId) return jobs.map(summary);
      const job = jobs.find((candidate) => candidate.jobId === args.jobId);
      if (!job?.rootTaskId) throw new HostError("not_found", "当前机器人没有这张工单。");
      const page = await service.teamTasks.board.context(job.rootTaskId, { section: args.commentId ? "comment" : "comments",
        offset: args.offset as number | undefined, commentId: args.commentId as string | undefined });
      owner(sessionId);
      return { ...summary(job), ...(args.commentId ? { comment: page.comment } : { comments: page.comments }) };
    }),
  }, {
    name: PLANE_BOT_FEEDBACK_TOOL, title: "把用户反馈交回这张机器人工单", readOnly: false, autoApprove: true,
    description: "When the person reports a problem in the project, or asks you to act on the latest or a named author's Plane comment, return this delivery for rework on the same ticket. For an inquiry only use plane_bot_orders. Use the current jobId and resultId from plane_bot_orders. Quote the person's request verbatim. Acceptance and archival are human actions.",
    inputSchema: { jobId: z.string().min(1).max(100), resultId: z.string().min(1).max(100), request: z.string().trim().min(1).max(6000) },
    run: (args) => writeAsync(caller, async ({ sessionId }) => {
      const bot = owner(sessionId);
      const item = service.store.findItems(sessionId, "user", {}, { newest: true, limit: 1 })[0];
      // Bot requests and reminder letters also arrive as user items; only a person's own delivered message can reopen work.
      if (item?.type !== "user" || !personsMessage(item) || item.delivery || item.botLetter || item.relayFromSessionId || item.answersDecisionId
        || item.id.startsWith("bot-request:") || splitRoleUpdate(item.text).text.trim() !== args.request) {
        throw new HostError("read_only", "请引用用户在机器人主聊天中刚发送的返工要求。");
      }
      await service.teamTasks.planeFeedback.submit(bot.id, String(args.jobId), args.resultId, args.request);
      return { jobId: args.jobId, resultId: args.resultId, message: "反馈已交回同一个机器人，修改后会再次提醒工程验收。" };
    }),
  }];
}
