import type { Id, Timestamp } from "./entities.js";

// 任务页侧栏「环境与上下文」(2026-11-18 用户定)：会话上下文的分项占用。只有运行时原生给得出分项时才有
// （Claude 的 getContextUsage）；其他运行时界面用每轮记下的总量（TurnUsage.context / contextWindow）。

/** 一行分项，例如 MCP tools、Messages、Memory files。 */
export interface ContextUsageCategory {
  /** 运行时给的稳定 id（Claude：system_prompt、mcp_tools、messages…），没有时只看 name。 */
  id?: string;
  name: string;
  tokens: number;
  /** used 占着窗口；free 剩余；buffer 压缩预留；deferred 不在窗口里（按需加载的工具说明）。 */
  kind: "used" | "free" | "buffer" | "deferred";
}

/** 会话读进上下文的说明文件（CLAUDE.md 等）。 */
export interface ContextMemoryFile {
  path: string;
  /** 运行时给的类别，例如 Project、User。 */
  type: string;
  tokens: number;
}

export interface ContextBreakdown {
  used: number;
  window: number;
  /** 0–100。 */
  percent: number;
  categories: ContextUsageCategory[];
  memoryFiles: ContextMemoryFile[];
  model?: string;
  /** 读到的时间。 */
  at: Timestamp;
}

export interface SessionContextUsage {
  sessionId: Id;
  /** 最近一次读到的分项；进程退出后保留上一次的（live 为 false）。 */
  breakdown: ContextBreakdown | null;
  /** 这次是从正在运行的进程里读的。 */
  live: boolean;
  /** 没有分项的原因，界面直接显示。 */
  unavailable?: string;
}
