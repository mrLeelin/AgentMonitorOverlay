import { z } from "zod";
import { BOT_GROUP_ASK_TOOL } from "../../mcp/names.js";
import { writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

export function botsTools({ service, caller }: ToolContext): AmoTool[] {
  return [{
    name: "bot_ask", title: "联系提到的 Bot", readOnly: false, autoApprove: true,
    description: "Ask a Bot selected by the person in this conversation. Use that recipient's mentionId and include relevant context and a concrete question. When several Bots are asked, call once per requested recipient before ending your turn. Each reply arrives separately in this session.",
    inputSchema: { mentionId: z.string().max(96), text: z.string().min(1).max(20000) },
    run: (args) => writeAsync(caller, async (c) => {
      const request = await service.bots.ask(c.sessionId, String(args.mentionId), String(args.text));
      return { requestId: request.id, status: request.status, error: request.status === "failed" ? request.result : undefined };
    }),
  }, {
    name: BOT_GROUP_ASK_TOOL, title: "向同群 Bot 提问", readOnly: false, autoApprove: true,
    description: "Ask another enabled member of your current Bot group when the person requests it in the current group message. Use the requestId and botId supplied with that message. The question and the member's reply appear in the same group. A Bot's forwarded question only accepts a reply.",
    inputSchema: { requestId: z.string().regex(/^[a-f0-9]{64}$/), botId: z.string().min(1).max(80), text: z.string().min(1).max(20000) },
    run: (args) => writeAsync(caller, async (c) => {
      const post = await service.bots.askGroupMember(c.sessionId, String(args.requestId), String(args.botId), String(args.text));
      const reply = post.replies[0];
      return { postId: post.id, status: reply?.status ?? "skipped", error: reply?.status === "failed" ? reply.result : undefined };
    }),
  }];
}
