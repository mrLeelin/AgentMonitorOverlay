import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import { HostError, MAX_NOTE_CHARS, MAX_QUESTION_CHARS, MAX_OPTION_CHARS, MAX_DECISION_OPTIONS } from "../../core/shared.js";
import { write, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";

/** The AMO MCP tools of this feature (gathered in mcp/tools.ts). */
export function collabTools({ service, caller, ownTask }: ToolContext): AmoTool[] {
  return [
    {
      name: "task_note_add",
      title: "记进度",
      description: "Add a short progress note to your own AMO task (what was done, what is next, what blocks). The person sees it on the task page. Cannot move the task between board columns.",
      inputSchema: { text: z.string().max(MAX_NOTE_CHARS) },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.collab.addTaskNote(ownTask(c), { text: args.text, kind: "progress" }, c.sessionId)),
    },
    {
      name: "handoff_submit",
      title: "提交交接",
      description: "Submit a handoff summary for your own AMO task: what is done, what is left, where the relevant files are, and anything the next session must know.",
      inputSchema: { summary: z.string().max(MAX_NOTE_CHARS) },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.collab.addTaskNote(ownTask(c), { text: args.summary, kind: "handoff" }, c.sessionId)),
    },
    {
      name: "mailbox_send",
      title: "留言",
      description:
        "Leave a message for another AMO session (toSessionId), a task (toTaskId) or a topic (toTopicId); find ids with board_list, task_get, topic_get or session_tree. It does not enter their conversation by itself: the person decides when to forward it, and the recipient can read it with mailbox_read. The exception is a managed task's message to its direct manager, which goes into the manager's conversation as a notice once the manager is free. Report routine progress in your turn's final reply instead (it reaches your manager when the turn ends), and ask for decisions with decision_request.",
      inputSchema: { toSessionId: z.string().optional(), toTaskId: z.string().optional(), toTopicId: z.string().optional(), text: z.string().max(MAX_NOTE_CHARS) },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const to =
            typeof args.toSessionId === "string"
              ? { kind: "session", sessionId: args.toSessionId }
              : typeof args.toTaskId === "string"
                ? { kind: "task", taskId: args.toTaskId }
                : typeof args.toTopicId === "string"
                  ? { kind: "topic", topicId: args.toTopicId }
                  : null;
          if (!to) throw new HostError("bad_request", "give toSessionId, toTaskId or toTopicId");
          const m = service.collab.sendMail(c.sessionId, to, args.text);
          return { id: m.id, to: m.to, state: m.state, ...(service.collab.managerSessionFor(m) ? { note: "已作为通知送进直属主控的会话（主控空闲时送进去）。日常进展写在本轮回复里即可，要拍板用 decision_request。" } : {}) };
        }),
    },
    {
      name: "checklist_check",
      title: "勾清单",
      description: "Tick (or untick with done=false) a step of your own task's checklist; find the item ids with task_get. The person sees who ticked it.",
      inputSchema: { itemId: z.string(), done: z.boolean().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const item = service.collab.setChecklistDone(String(args.itemId), args.done !== false, c.sessionId);
          return { id: item.id, text: item.text, done: item.done };
        }),
    },
    {
      name: "decision_request",
      title: "请求决策",
      description:
        // 2026-11-17: a question that carried its whole evidence went over the 2000 limit and was refused; the evidence goes in detail.
        "Ask for a business decision (offer short options). question: the decision itself in a few sentences. detail (Markdown, optional): the evidence and background behind it (files, cells, commits, what you checked); it shows folded under the question. In a managed task it automatically goes to your direct manager, who answers with task_decision_answer; only the root lead asks the person directly. It does not block your turn. The answer returns by mail during your turn and automatically through your inbox afterward: when nothing else is left to do, end your turn instead of sleeping or polling mailbox_read, and the answer starts your next one. CLI security approvals and native tool questions remain separate.",
      inputSchema: { question: z.string().max(MAX_QUESTION_CHARS), options: z.array(z.string().max(MAX_OPTION_CHARS)).max(MAX_DECISION_OPTIONS).optional(), detail: z.string().max(MAX_NOTE_CHARS).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const d = service.collab.requestDecisionFromSession(c.sessionId, args.question, args.options, args.detail);
          return { id: d.id, state: d.state, routedToTaskId: d.routedToTaskId ?? null, note: d.routedToTaskId ? "问题已交直属主控，答案将自动回到本会话。" : "问题已交给人决定，答案将自动回到本会话。" };
        }),
    },
    {
      name: "mailbox_read",
      title: "读留言",
      description: "Read the unread messages left for you or for your task or topic (they are then marked read).",
      inputSchema: {},
      readOnly: false,
      autoApprove: true,
      run: () =>
        write(caller, (c) => {
          const title = (id: Id | null) => (id ? service.store.getSession(id)?.title || "会话" : "我（人）");
          return {
            // The text first: it is what the agent needs, the routing is context.
            messages: service.collab.readMailFromSession(c.sessionId).map((m) => ({
              text: m.text,
              from: m.fromSessionId ? { sessionId: m.fromSessionId, title: title(m.fromSessionId), taskId: m.fromTaskId, topicId: m.fromTopicId ?? null } : "person",
              to: m.to,
              at: m.createdAt,
            })),
          };
        }),
    },
  ];
}
