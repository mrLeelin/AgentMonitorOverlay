import { z } from "zod";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function relaysTools({ service, caller }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_message",
      title: "传话",
      description:
        "主控 sends an explicit-purpose message to a managed task automatically. purpose=inquiry only asks for a read-only answer and preserves acceptance; purpose=work (default for older calls) continues work; purpose=reopen explicitly restarts work. Intent is structured, never inferred from text. It normally uses the latest main session; work or reopen from its direct manager can join a running Codex work turn. If a bound task's recorded prerequisite delivery was replaced, only its current direct manager can reopen it from the current accepted basis. This requires settled sessions, starts a fresh session in the same task, and archives the old conversations with their evidence. Retrying the same replacement instruction returns its existing relay. Management, shared requirements and prerequisites remain checked at dispatch. Topic-only coordination retains confirmation. A delivery receipt returns to the lead. Only completed work is submitted with task_submit_result.",
      inputSchema: { taskId: z.string(), text: z.string(), purpose: z.enum(["inquiry", "work", "reopen"]).optional().describe("inquiry 只读询问并保留已验收结果；work 继续派工；reopen 明确重新开始。旧调用默认 work。") },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const relay = service.relays.send(c.sessionId, args);
          const auto = !!relay.fromTaskId || service.store.getTask(relay.toTaskId)?.relayAuto;
          if (relay.state !== "pending") return { relayId: relay.id, sessionId: relay.sessionId, state: relay.state, error: relay.error, note: "这次前置换版重开已有回执。" };
          return { relayId: relay.id, note: auto ? "这个任务的传话不用确认：正在送进它的会话。" : "等人确认后送进它的会话；结果会作为留言回来（mailbox_read）。" };
        }),
    },
  ];
}
