import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function relaysTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_message",
      title: "传话",
      description:
        "主控 assigns work or changes a plan in a managed task's session automatically, without asking the person again. It goes into the task's latest main session once the current turn ends, or starts one. Management is rechecked at delivery. Topic sessions without a lead still need confirmation unless the task accepts relays. The delivery receipt automatically returns to the lead's conversation. Submit completed work with task_submit_result for the direct lead to review; mailbox_send is for notes.",
      inputSchema: { taskId: z.string(), text: z.string() },
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
