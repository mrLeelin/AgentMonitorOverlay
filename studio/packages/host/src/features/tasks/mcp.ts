import { z } from "zod";
import { managementRoot } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { answer, write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { noteOwnDescription } from "../guide/role.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function tasksTools({ service, caller, model, ownTask, inOwnTopic }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_set_lead", title: "将本任务设为主控", description: "Promote your own task to lead without a separate approval. Only the task's root main session may call; no other task id is accepted. Provide summary with the concrete goal, existing results and next steps, and topicTitle naming the object plus goal/deliverable (e.g. DarkEvil-Story分支交叉检查：定位代码与资源缺陷，给出合并风险报告). Without a topic, Studio creates and binds one only after settling; omitted topicTitle freezes a meaningful task title, generic labels such as 审查/任务 are refused. The first pending request persists its summary and resolved title across restart; a different pending topicTitle is refused (cancel the pending request before requesting a different target). An existing topic is preserved and never renamed, including calls with another topicTitle after binding. If already a root lead without a topic, use task_plan_propose with topicTitle to initialize and split atomically. The lead and same-topic management ancestors receive missing canvas cards without moving existing cards. Returns pending while sessions, terminals, background work or undelivered messages remain active. Once settled, Studio archives old sessions, promotes this same task and opens a fresh read-only lead session with your summary. Finish this turn afterward. Management ownership stays unchanged; an unbound managed child must ask its root lead to initialize the topic. Retries reuse saved topic/session receipts; after a switch/start failure, a live main session can request resumption. Repeating the request does not duplicate sessions.",
      inputSchema: { summary: z.string().min(1).max(20_000), topicTitle: z.string().min(1).max(100).optional() }, readOnly: false, autoApprove: true,
      run: (args) => write(caller, (c) => service.tasks.leadPromotion.request(c.sessionId, args.summary, args.topicTitle)),
    },
    {
      name: "task_management", title: "管理范围", description: "Read a task's stored direct and recursive management tree, with unique lead/worker counts. Sharing a topic, reference cards or annotation lines grants no management rights.",
      inputSchema: { taskId: z.string().optional() }, readOnly: true, autoApprove: true,
      run: (args) => answer(() => service.tasks.management(args.taskId === undefined && caller ? ownTask(caller) : String(args.taskId))),
    },
    {
      name: "task_manager_set", title: "转交直属主控", description: "Set, transfer or clear (null) a managed task's direct manager. Leads may only transfer descendants within their management tree; initial assignment and cross-tree transfer require the user or topic session. This never changes local file permissions.",
      inputSchema: { taskId: z.string(), managerTaskId: z.string().nullable() }, readOnly: false, autoApprove: false,
      run: (args) => write(caller, (c) => service.tasks.setManager(String(args.taskId), args.managerTaskId, c.sessionId)),
    },
    {
      name: "board_list",
      title: "看板",
      description: "Tasks on the AMO board (most recently active first, archived ones left out) with their column, status, project and topic. Filter by project (id or name), topic (id or title) or column.",
      inputSchema: { workspace: z.string().optional(), topic: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.boardList(args as { workspace?: string; topic?: string; column?: "todo" | "doing" | "review" | "done" })),
    },
    {
      name: "task_get",
      title: "任务详情",
      description: "One task: its latest handoff summary, column, status, project, topic, the tasks it depends on and that depend on it, its canvas group, recent progress notes and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.taskGet(String(args.taskId))),
    },
    {
      name: "task_update",
      title: "管理任务",
      description: "Update a task's title, board column (todo/doing/review/done), or topicId (null removes it from its topic). Your own task by default. Leads manage only their stored descendants; topic sessions manage their topic. Linked ownership must be explicitly handled before moving scope. This only changes Studio metadata, never file permissions. A lead manages without a separate approval; other roles ask first.",
      inputSchema: { taskId: z.string().optional(), title: z.string().min(1).optional(), column: z.enum(["todo", "doing", "review", "done"]).optional(), topicId: z.string().nullable().optional() },
      readOnly: false,
      autoApprove: false,
      run: (args) => write(caller, (c) => {
        const session = service.store.getSession(c.sessionId)!;
        const taskId = args.taskId === undefined ? ownTask(c) : String(args.taskId);
        if (taskId !== session.taskId) {
          if (session.taskId && !service.store.getTask(session.taskId)?.lead) throw new HostError("bad_request", "执行会话只能管理自己的任务；请联系主控管理其他任务。");
          inOwnTopic(c, taskId);
        }
        const patch = { ...(args.title !== undefined ? { title: args.title } : {}), ...(args.column !== undefined ? { column: args.column } : {}), ...(args.topicId !== undefined ? { topicId: args.topicId } : {}) };
        if (!Object.keys(patch).length) throw new HostError("bad_request", "请提供任务标题、状态或专题。");
        if (args.title !== undefined && (typeof args.title !== "string" || !args.title.trim())) throw new HostError("bad_request", "任务标题不能为空。");
        if (args.column === "done" && managementRoot(service.store.listTasks(), taskId)) throw new HostError("bad_request", "管理任务的完成须经过交付验收：执行任务用 task_submit_result，直属主控用 task_review_result；总主控验收全部下辖后再提交最终交付。");
        return service.tasks.updateTask(taskId, patch);
      }),
    },
    {
      name: "task_describe",
      title: "任务说明",
      description:
        "Write a task's description: what it is about, its goal and scope, in a few lines. It shows on the task's canvas card and task page, for the person and other agents. Your own task when taskId is left out; otherwise a task of your topic. An empty description removes it.",
      inputSchema: { taskId: z.string().optional(), description: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const taskId = args.taskId === undefined ? ownTask(c) : String(args.taskId);
          if (args.taskId !== undefined && taskId !== service.store.getSession(c.sessionId)?.taskId) inOwnTopic(c, taskId);
          const task = service.tasks.updateTask(taskId, { description: args.description });
          if (taskId === service.store.getSession(c.sessionId)?.taskId) noteOwnDescription(service, c.sessionId);
          return { taskId: task.id, description: task.description ?? "" };
        }),
    },
  ];
}
