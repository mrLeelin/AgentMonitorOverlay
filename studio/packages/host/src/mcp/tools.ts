import type { HostService } from "../service.js";
import { FEATURES } from "../features/index.js";
import type { Task } from "@amo-studio/protocol";
import { isRemoteCopy } from "../core/shared.js";
import { fail, toolContext, type AmoTool, type McpCaller } from "./tool-kit.js";
import { LEAD_MANAGEMENT_TOOLS } from "./names.js";
import { currentMessagePurpose } from "../runtime/message-purpose.js";

// The AMO MCP tools, defined once: the Host serves them over HTTP at /mcp (Codex sessions), and Claude sessions get the
// same tools in-process through the SDK, so no token has to reach the Claude CLI.
// Reading is open to every caller. Writing (stage 5) is scoped to the session behind the call: Claude's in-process
// server is bound to its session; a Codex thread carries its own token in a header (spikes/RESULTS.md section j).
// Each feature declares its tools (features/<name>/mcp.ts).

export type { AmoTool, McpCaller, ToolResult } from "./tool-kit.js";

export const AMO_MCP_NAME = "amo";
/**
 * What every agent is told about AMO (stage 16, the stage 15 design): the server's instructions, which both CLIs hand
 * to the model. The role card is per session: Claude gets it appended here (each Claude session has its own server),
 * Codex as its thread's developer instructions (its server cannot tell sessions apart when it starts).
 */
export const AMO_MCP_INSTRUCTIONS = [
  "Shared requirements are explicitly bound to a management root and selected managed tasks. Use context_get for the frozen version, context_adopt to declare adoption; queued or delivered does not mean adopted. The root lead may context_save and context_publish without repeated human approval, then separately context_apply selected affected tasks. Publishing never upgrades tasks automatically. Include actual contextBasis and prerequisiteResultIds when submitting. Differences require explicit manager resolution at acceptance. Topic/group/reference proximity grants no context or authority.",
  "AMO Studio: the workbench the person uses to run and watch AI work. Work is organised as projects (a folder, usually a git repository), tasks (one piece of work in one project, optionally in a topic; each has its own sessions, a board column, a description, progress notes and a handoff) and topics (专题: related tasks, possibly across projects, on one canvas with groups, dependencies, notes, colour marks, and the topic's own documents).",
  "A task marked as 主控 (lead) coordinates and assigns work: it proposes tasks, describes their scope, sends instructions, manages task state and arranges the canvas. To lead, the task's main session calls task_set_lead once with summary (concrete goal, existing results, next steps) and topicTitle (object plus specific goal/deliverable, e.g. DarkEvil-Story分支交叉检查：定位代码与资源缺陷，给出合并风险报告), then finishes the turn. Once settled, Studio creates/binds a missing topic, places missing lead/management ancestor cards, archives old sessions and starts a fresh read-only lead session. Existing topic names, management ownership and card layout stay preserved. An unbound root lead can also provide topicTitle with task_plan_propose to initialize its topic and split work atomically; lead and child cards display derived management lines automatically. It may maintain topic documents inside Studio. Local files stay read-only: implementation and file changes happen in execution tasks. A lead cannot start sessions or subagents in its own task to bypass that restriction. Every other task's session does its own task (执行). The person decides when to branch and when to merge; Studio never does.",
  // 2026-10-22: an agent's xargs -P 12 burst and a grep -r over a big checkout made the person's desktop lag.
  "The person works on this same machine while you run, often with several agents and big game projects open, so keep your commands light: do not fan out many processes at once (xargs -P, parallel loops, more than a few background jobs), search with rg or git grep limited to the folders that matter instead of grep -r over a whole checkout or drive, and cap test runners' workers (for example vitest --maxWorkers=4, dotnet test -m:2) unless the person asks for speed.",
  "Your role card (who you are, your task, topic, its 主控 and documents) is given to you when the session starts; when you do not have it, or need the current one, call amo_whoami. amo_guide explains each part (tasks, topics, canvas, collab, lead, files). Leads manage only themselves and their stored descendants (task_management), never all same-topic tasks; reference cards and annotation lines grant no authority. Task relations are management and dependency. Initial assignment and cross-tree transfer belong to the user or topic session. For other roles, writes to other tasks or the canvas's structure ask the person first; your own task's notes, descriptions and colour marks do not.",
  // 2026-10-30: workers use the canvas when asked; 2026-11-07: leads may manage their topic's canvas directly.
  "Leads may arrange cards, groups, dependencies and colour marks within their management range, and propose execution tasks with task_plan_propose; accepted tasks receive their manager before the first session starts. Other roles use the canvas when the person asks for it, in the way amo_guide describes (section canvas). Without such a request leave the canvas as it is, and reports and reviews go in your reply as usual.",
  "Managed work returns up the explicit management tree. A lead's task_plan_propose creates and starts tasks automatically (lead:true creates a domain coordinator); task_message dispatches to descendants without routine human confirmation. Workers submit task_submit_result with verification evidence; direct managers use task_workflow and task_review_result to accept or return. Session completion alone is not acceptance. Use decision_request for business questions: it goes to the direct manager, who answers with task_decision_answer; only the root lead asks the person and delivers the final integrated result. Native tool questions and security approvals remain visible and are not automatically approved.",
  "When the person wants to review a file or saved changes, use review_open: mode=file for its current content (optional line/endLine), mode=changes for its Git diff (optional base, commit or range). It opens the person's reviewer and defaults comments back to your session; it does not perform or approve a review. Save edits before reopening to show the latest content.",
  // 会话里用中转 (2026-10-30, plans/done/relay-in-sessions.md).
  "When the work needs someone on the team other than the person you work for — a programmer to confirm an implementation, an interface or the work it takes, or to check a plan — ask them with team_ask (AMO 中转; team_members lists who does what). It usually waits for the person's OK in Studio (the answer says), goes as the person marked as their AI's, and the reply comes back into this conversation by itself: end your turn after it instead of going on in the unconfirmed direction; then team_followup to ask again, team_done once settled. (task_message is different: it talks to another task's session inside Studio.)",
].join("\n\n");

/**
 * 设置 → 功能 → 命令行适配 (2026-11-06, agent-env.ts has the survey): what goes wrong on Windows besides encoding — quotes
 * and heredocs (Claude's Bash, 158 times), backslashes lost on the way (Claude's Bash tool turned `\\` into `\` even in
 * single quotes and quoted heredocs, seen 2026-11-06; PowerShell's did not), and bash habits in PowerShell (Codex: `&&`
 * and heredocs in Windows PowerShell 5.1, 635 parse errors). Added to the instructions while the switch is on.
 */
export const SHELL_HELP_INSTRUCTIONS =
  "Commands on Windows: in Bash (Git Bash) write Windows paths with forward slashes (G:/PROJECT/...). Backslashes can be halved before bash sees them — `\\\\` in a path, regex or escape may arrive as `\\`, even inside single quotes or a quoted heredoc — so a script with backslashes, regexes or quotes inside quotes goes into a file (written with your file tool) and is run from there, not inline through node -e, python -c or a heredoc. In PowerShell use PowerShell syntax only (no heredocs, no head/tail/grep, no && in Windows PowerShell 5.1) and read and write text with -Encoding utf8. Python prints UTF-8 here (PYTHONUTF8=1 is set for you).";

/** The instructions as this Studio gives them: the shared part, plus the Windows command help while it is on. */
export function amoInstructions(service: HostService): string {
  return service.config.shellHelp() ? `${AMO_MCP_INSTRUCTIONS}\n\n${SHELL_HELP_INSTRUCTIONS}` : AMO_MCP_INSTRUCTIONS;
}

/** Every AMO tool for one caller (null: reading only): the features' tools, reading ones first; none of a feature turned off. */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ctx = toolContext(service, caller);
  const off = new Set<string>(service.config.disabledFeatures());
  const tools = FEATURES.filter((f) => !off.has(f.name)).flatMap((f) => f.tools?.(ctx) ?? [])
    .filter((t) => !isLeadCaller(service, caller) || leadMayUse(t))
    .map((t) => keepLeadReadOnly(service, caller, keepOffRemoteCopies(service, t)));
  return [...tools.filter((t) => t.readOnly), ...tools.filter((t) => !t.readOnly)];
}

// 2026-11-07, the person: 主控 assigns implementation and may manage tasks/canvas; task.lead includes forks/subagents.
// mailbox_read marks messages read, so it is a write in MCP despite being a reading capability.
const leadManagementTools = new Set<string>(LEAD_MANAGEMENT_TOOLS);
const leadMayUse = (tool: AmoTool): boolean => tool.readOnly || leadManagementTools.has(tool.name);

function isLeadCaller(service: HostService, caller: McpCaller | null): boolean {
  const taskId = caller ? service.store.getSession(caller.sessionId)?.taskId : null;
  return !!taskId && service.store.getTask(taskId)?.lead === true;
}

/** Recheck when invoked: an SDK server or a cached tool may predate the task being marked as 主控. */
function keepLeadReadOnly(service: HostService, caller: McpCaller | null, tool: AmoTool): AmoTool {
  const wasLead = isLeadCaller(service, caller);
  return {
    ...tool,
    autoApprove: tool.autoApprove || (isLeadCaller(service, caller) && leadMayUse(tool)),
    run: (args) => {
      if (caller) {
        if (!tool.readOnly && currentMessagePurpose(service.store, caller.sessionId) === "inquiry") return fail("本轮是只读询问，不能修改任务、提交交付或执行其他写操作；需要继续工作时由主控明确派工。");
        const session = service.store.getSession(caller.sessionId);
        const task = session?.taskId ? service.store.getTask(session.taskId) : null;
        const topic = session?.topicId ? service.store.getTopic(session.topicId) : task?.topicId ? service.store.getTopic(task.topicId) : null;
        if (!tool.readOnly && (!session || session.archivedAt || task?.archivedAt || topic?.archivedAt)) return fail("调用会话、任务或专题已归档，不能继续写入。");
      }
      const lead = isLeadCaller(service, caller);
      if (wasLead && !lead && !tool.readOnly) return fail("主控身份已取消，旧工具的自动批准已失效；请刷新会话工具后按执行任务权限操作。");
      return lead && !leadMayUse(tool)
        ? fail("主控可以管理任务和画布，本地文件只读，不能在主控任务里另开执行会话或修改执行设置。请把具体实现和文件修改分配给执行任务。")
        : tool.run(args);
    },
  };
}

/**
 * 远程 (2026-10-29): a copy of a task another computer granted this one (Task.remote, sessions running "remote") is that
 * computer's task — agents here neither read nor change it (no notes, 说明, mail, sessions, canvas). Any tool given the id
 * of such a task or of one of its sessions answers so; board_list leaves them out (read-model.ts).
 */
function keepOffRemoteCopies(service: HostService, tool: AmoTool): AmoTool {
  return {
    ...tool,
    run: (args) => {
      const copy = remoteCopyNamed(service, args);
      if (!copy?.remote) return tool.run(args);
      return fail(`「${copy.title || "未命名任务"}」是 ${copy.remote.name}（${copy.remote.account}）授权给这台电脑的远程任务，在那台电脑上运行：这里的 AMO 工具不读也不改它（只能由人在 Studio 里打开它操作）。`);
    },
  };
}

/** The remote copy whose id (a task's or a session's) is among a call's arguments, if any. */
export function remoteCopyNamed(service: HostService, args: unknown): Task | null {
  const ids = new Set<string>();
  const collect = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      if (v.length <= 100) ids.add(v);
    } else if (depth < 2 && Array.isArray(v)) for (const x of v) collect(x, depth + 1);
    else if (depth < 2 && v && typeof v === "object") for (const x of Object.values(v)) collect(x, depth + 1);
  };
  collect(args, 0);
  for (const id of ids) {
    const task = service.store.getTask(id);
    if (task?.remote) return task;
    const session = task ? undefined : service.store.getSession(id);
    if (isRemoteCopy(session) && session?.taskId) {
      const owner = service.store.getTask(session.taskId);
      if (owner?.remote) return owner;
    }
  }
  return null;
}
