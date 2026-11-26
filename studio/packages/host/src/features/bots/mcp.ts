import { z } from "zod";
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
  }];
}
