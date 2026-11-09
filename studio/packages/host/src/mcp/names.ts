// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
// Mail never enters a conversation by itself (the person forwards it), so sending and reading it need no approval.
// Asking the person a question (decision_request) only puts it in front of them.
// session_start (2026-10-22): the person chose to have a session start another in its own task without asking.
// review_open and view_open (查看包, 2026-10-23) only put something in front of the person.
// session_archive (2026-11-01, 问题 #6): only sessions the caller itself started, so putting them away is as free as starting them.
// session_send (2026-11-01): the same sessions; telling them more is as free as starting them.
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "handoff_submit", "mailbox_send", "mailbox_read", "decision_request", "task_submit_result", "task_review_result", "task_decision_answer", "checklist_check", "schedule_propose", "session_start", "session_send", "session_archive", "review_open", "view_open"] as const;

// Writes the person approves first. Codex's default ("auto") lets tools annotated as non-destructive run unasked
// (S5-05: canvas_group_create ran without a prompt), so these are set to "prompt" explicitly.
// mcp_server_save (MCP 设置, 2026-11-04): a server is a command run on this computer — never without the person's yes
// (and so never for DSH, which leaves these out).
export const PROMPTED_WRITE_TOOLS = ["canvas_group_create", "canvas_depend", "canvas_place", "canvas_arrange", "canvas_move", "task_update", "task_manager_set", "mcp_server_save"] as const;

// 2026-11-07: 主控 manages Studio's tasks and canvas directly; local files remain read-only in each runtime.
// Keep this explicit: session/terminal, settings and third-party command tools must not inherit management rights.
export const LEAD_MANAGEMENT_TOOLS = [
  "task_plan_propose", "task_describe", "task_message", "mailbox_send", "mailbox_read", "decision_request",
  "task_submit_result", "task_review_result", "task_decision_answer",
  "task_update", "task_manager_set", "task_note_add", "handoff_submit", "checklist_check", "topic_doc_write",
  "canvas_group_create", "canvas_depend", "canvas_color", "canvas_place", "canvas_arrange", "canvas_move",
  "canvas_items_post", "canvas_item_update", "canvas_callout", "canvas_callout_close",
] as const;
