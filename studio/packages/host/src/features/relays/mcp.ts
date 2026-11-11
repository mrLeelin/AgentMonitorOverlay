import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function relaysTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_message",
      title: "传话",
      description:
        "主控 sends an explicit-purpose message to a managed task automatically. purpose=inquiry only asks for a read-only answer and preserves acceptance; purpose=work (default for older calls) continues work; purpose=reopen explicitly restarts work. Intent is structured, never inferred from text. It goes into the task's latest main session once its current turn ends, or starts one. Management, shared requirements and prerequisite evidence remain checked at actual dispatch. Topic-only coordination retains confirmation. A delivery receipt returns to the lead. Only completed work is submitted with task_submit_result; inquiries do not submit or reopen accepted results.",
      inputSchema: { taskId: z.string(), text: z.string(), purpose: z.enum(["inquiry", "work", "reopen"]).optional().describe("inquiry 只读询问并保留已验收结果；work 继续派工；reopen 明确重新开始。旧调用默认 work。") },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const relay = service.relays.send(c.sessionId, args);
          const auto = !!relay.fromTaskId || service.store.getTask(relay.toTaskId)?.relayAuto;
          return { relayId: relay.id, note: auto ? "这个任务的传话不用确认：正在送进它的会话。" : "等人确认后送进它的会话；结果会作为留言回来（mailbox_read）。" };
        }),
    },
  ];
}
