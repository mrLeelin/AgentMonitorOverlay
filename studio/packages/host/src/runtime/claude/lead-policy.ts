import type { HookCallbackMatcher, HookEvent, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

export const LEAD_READ_ONLY_REASON = "主控只能读取和分配任务，不能执行命令、修改文件、启动执行代理或使用其他写入工具。请把实施工作分配给执行任务。";

// 2026-11-07: plan mode alone is insufficient: ExitPlanMode and an Agent's mode can unlock writes. Deny tools
// before the CLI's approval rules, including already-approved shell commands and third-party MCP tools.
const LEAD_READ_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "AskUserQuestion", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool"]);

export function leadToolAllowed(toolName: string): boolean {
  // The AMO server checks a separate allocation-only allowlist on every call, including cached tool handles.
  return LEAD_READ_TOOLS.has(toolName) || toolName.startsWith("mcp__amo__");
}

/** Resolve the role on every tool call, so changing a running task into a lead cannot leave an old bypass alive. */
export function leadReadOnlyHooks(isLead: () => boolean): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [async (input): Promise<SyncHookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse" || !isLead() || leadToolAllowed(input.tool_name)) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: LEAD_READ_ONLY_REASON } };
    }] }],
  };
}
