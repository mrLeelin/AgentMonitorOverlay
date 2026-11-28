// Schema migrations, applied in order inside one transaction each. Never edit a shipped migration; add a new one.
// A migration that rebuilds tables other tables point at runs with foreign keys off (checked again afterwards).

export type Migration = string | { sql: string; foreignKeysOff: true };

export const MIGRATIONS: readonly Migration[] = [
  // 1: initial schema
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'area')),
    workspace_id TEXT REFERENCES workspaces(id),
    column_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((scope_kind = 'workspace') = (workspace_id IS NOT NULL))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    parent_id TEXT REFERENCES sessions(id),
    kind TEXT NOT NULL,
    runtime TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    writer TEXT NOT NULL,
    runtime_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE UNIQUE INDEX sessions_runtime_ref ON sessions(runtime, runtime_ref) WHERE runtime_ref IS NOT NULL;

  -- Items are never deleted and seq is never reused; a row's body may be replaced (streaming finished, approval answered).
  CREATE TABLE items (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  -- Global host event log for the WS stream (resume with ?since=seq).
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    item_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX annotations_session ON annotations(session_id);

  CREATE TABLE canvas_docs (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 2: small key/value settings (scratchpad and other per-install values)
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 3: collaboration (stage 5): task notes and handoffs, mail between sessions, decision requests
  `
  CREATE TABLE task_notes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX task_notes_task ON task_notes(task_id, created_at);

  CREATE TABLE mail (
    id TEXT PRIMARY KEY,
    to_session TEXT,
    to_task TEXT,
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_to_session ON mail(to_session, created_at);
  CREATE INDEX mail_to_task ON mail(to_task, created_at);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX decisions_state ON decisions(state, created_at);
  `,
  // 4: task checklists from extension pack templates (stage 6)
  `
  CREATE TABLE checklist_items (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    position INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX checklist_task ON checklist_items(task_id, position);
  `,
  // 5: scheduler proposals (stage 7)
  `
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL,
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX proposals_state ON proposals(state, created_at);
  `,
  // 6: per-session model, reasoning effort and permissions (stage 9), as JSON
  `
  ALTER TABLE sessions ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  `,
  // 7: structure v2 (design/structure.md): topics, the common space as a built-in workspace, tasks with exactly one
  // workspace and at most one topic, sessions owned by a task or a topic. Tasks from the old cross-workspace area keep
  // a NULL workspace here; the Host resolves them at start-up, where it knows the common space's folder.
  {
    foreignKeysOff: true,
    sql: `
  ALTER TABLE workspaces ADD COLUMN builtin TEXT;

  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE tasks_v7 (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id),
    topic_id TEXT REFERENCES topics(id),
    column_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  INSERT INTO tasks_v7 (id, title, workspace_id, topic_id, column_name, created_at, updated_at, archived_at)
    SELECT id, title, workspace_id, NULL, column_name, created_at, updated_at, NULL FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v7 RENAME TO tasks;
  CREATE INDEX tasks_topic ON tasks(topic_id);

  CREATE TABLE sessions_v7 (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    topic_id TEXT REFERENCES topics(id),
    parent_id TEXT REFERENCES sessions(id),
    kind TEXT NOT NULL,
    runtime TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    writer TEXT NOT NULL,
    runtime_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    CHECK ((task_id IS NULL) <> (topic_id IS NULL))
  );
  INSERT INTO sessions_v7 (id, task_id, topic_id, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at, options)
    SELECT id, task_id, NULL, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at, options FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_v7 RENAME TO sessions;
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE INDEX sessions_topic ON sessions(topic_id);
  CREATE UNIQUE INDEX sessions_runtime_ref ON sessions(runtime, runtime_ref) WHERE runtime_ref IS NOT NULL;

  CREATE TABLE decisions_v7 (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    task_id TEXT REFERENCES tasks(id),
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO decisions_v7 (id, session_id, task_id, state, body, created_at) SELECT id, session_id, task_id, state, body, created_at FROM decisions;
  DROP TABLE decisions;
  ALTER TABLE decisions_v7 RENAME TO decisions;
  CREATE INDEX decisions_state ON decisions(state, created_at);

  ALTER TABLE mail ADD COLUMN to_topic TEXT;
  CREATE INDEX mail_to_topic ON mail(to_topic, created_at);
  `,
  },
  // 8: Git Review line comments (stage 11, S11-D), per project; the comment itself is the JSON body.
  `
  CREATE TABLE review_comments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    path TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX review_comments_workspace ON review_comments(workspace_id, created_at);
  `,
  // 9: file marks (stage 12, S12-D): a marked file or folder with a note; workspace_id NULL for 其他 (outside every
  // project). The mark itself is the JSON body.
  `
  CREATE TABLE file_marks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX file_marks_workspace ON file_marks(workspace_id, position);
  `,
  // 10: archived projects (2026-10-14): hidden from every list until restored; permanent deletion only once archived.
  `
  ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
  `,
  // 11: a project's own note (2026-10-14): what it is, for the person and for agents (project_context).
  `
  ALTER TABLE workspaces ADD COLUMN description TEXT;
  `,
  // 12: a topic's own note (2026-10-15), like a project's: what it is about, for the person and for agents.
  `
  ALTER TABLE topics ADD COLUMN description TEXT;
  `,
  // 13: what wakes a Claude session by itself (2026-10-16, stage 15): its /loop and a usage limit. JSON, NULL = nothing.
  `
  ALTER TABLE sessions ADD COLUMN wake TEXT;
  `,
  // 14: a task's own description (2026-10-17, stage 16): on its canvas card and task page; NULL = none.
  `
  ALTER TABLE tasks ADD COLUMN description TEXT;
  `,
  // 15: 主控 (stage 16): the task the person marks as coordinating its topic; and the topics' own documents.
  `
  ALTER TABLE tasks ADD COLUMN lead INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE topic_docs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX topic_docs_topic ON topic_docs(topic_id, created_at);
  `,
  // 16: 主控's proposals to split work into tasks (stage 16); JSON like the other documents.
  `
  CREATE TABLE task_plans (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX task_plans_state ON task_plans(state, created_at);
  `,
  // 17: 传话 (stage 16): a 主控's messages to other tasks' sessions, and the tasks that take them without asking.
  `
  ALTER TABLE tasks ADD COLUMN relay_auto INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE relays (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX relays_state ON relays(state, created_at);
  `,
  // 18: 书签 (2026-10-19): file marks are kept under a topic (NULL: 未归专题), and passages of conversations are
  // bookmarked too (the mark is the JSON body, as for files).
  `
  ALTER TABLE file_marks ADD COLUMN topic_id TEXT;
  CREATE TABLE chat_marks (
    id TEXT PRIMARY KEY,
    topic_id TEXT,
    session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX chat_marks_topic ON chat_marks(topic_id, position);
  `,
  // 19: 委派 (2026-10-22): the session that started this one with session_start; the session list shows it under that one.
  `
  ALTER TABLE sessions ADD COLUMN started_by TEXT;
  `,
  // 20: session_start's report (2026-10-22): the session its turns are reported to, kept across restarts.
  `
  ALTER TABLE sessions ADD COLUMN report_to TEXT;
  `,
  // 21: 查看包 (2026-10-23): what agents hand the person to look at (view_open); JSON like the other documents.
  `
  CREATE TABLE view_packs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    workspace_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX view_packs_session ON view_packs(session_id, updated_at);
  `,
  // 22: 画布审阅 (2026-10-27): agents' remarks and questions on a topic's canvas cards, beside the canvas document.
  `
  CREATE TABLE canvas_callouts (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX canvas_callouts_topic ON canvas_callouts(topic_id, state, created_at);
  `,
  // 23: 远程 step 2 (2026-10-29): this computer's copy of a task a paired device granted it (JSON: where it runs, whether
  // it is still granted, what new sessions may run on); NULL for every task of its own.
  `
  ALTER TABLE tasks ADD COLUMN remote TEXT;
  `,
  // 24: when a session's last turn ended (2026-11-04): Focus's 完成待审核 follows it instead of updated_at, which
  // renaming, settings, archiving and restoring move too. Sessions already ended take updated_at, as Focus read before.
  `
  ALTER TABLE sessions ADD COLUMN ended_at TEXT;
  UPDATE sessions SET ended_at = updated_at WHERE status IN ('idle', 'completed', 'interrupted', 'error');
  `,
  // 25: 放进待办 keeps its first sentence (2026-11-05): it was cut to the title and the rest dropped.
  `
  ALTER TABLE tasks ADD COLUMN first_message TEXT;
  `,
  // 26: Explicit management only. Existing tasks stay unassigned; canvas layout never implies ownership.
  `
  ALTER TABLE tasks ADD COLUMN manager_task_id TEXT REFERENCES tasks(id);
  CREATE INDEX tasks_manager ON tasks(manager_task_id);
  `,
  // 27: The person removed canvas collaboration (2026-11-09). Do not turn it into an arrow or a dependency.
  `
  UPDATE canvas_docs
  SET body = json_set(body,
    '$.links', json((SELECT json_group_array(json(value)) FROM json_each(canvas_docs.body, '$.links') WHERE json_extract(value, '$.kind') IS NOT 'collaboration')),
    '$.version', COALESCE(json_extract(body, '$.version'), 0) + 1,
    '$.updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (SELECT 1 FROM json_each(canvas_docs.body, '$.links') WHERE json_extract(value, '$.kind') = 'collaboration');
  `,
  // 28: Board review reminders need a stable round, independent of title/settings edits.
  `
  ALTER TABLE tasks ADD COLUMN review_entered_at TEXT;
  UPDATE tasks SET review_entered_at = updated_at WHERE column_name = 'review';
  `,
  // 29: Latest native Goal snapshot, so automatic turn gaps do not finish a still-active task.
  `
  ALTER TABLE sessions ADD COLUMN goal TEXT;
  `,
  // 30: A fork can continue in its own Git worktree while keeping its original project.
  `
  ALTER TABLE sessions ADD COLUMN cwd TEXT;
  `,
  // 31: Keeping the source link and local task in the same transaction makes repeated drops safe.
  `
  CREATE TABLE local_team_tickets (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    server TEXT NOT NULL, ticket_id TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0,
    awaiting_review INTEGER NOT NULL DEFAULT 0, UNIQUE(server, ticket_id)
  );
  `,
  // 32: A shared board can be opened with another team account on the same Studio data directory.
  `
  CREATE TABLE local_team_board_links (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    server TEXT NOT NULL, account TEXT NOT NULL, ticket_id TEXT NOT NULL, UNIQUE(server, account, ticket_id)
  );
  `,
  // 33: Restore a returned team's original task when the same person claims it again.
  `
  ALTER TABLE local_team_board_links ADD COLUMN returned INTEGER NOT NULL DEFAULT 0;
  `,
  // 34: Keep the Plane work item's original details available even when the server is offline.
  `
  ALTER TABLE local_team_board_links ADD COLUMN plane_context TEXT;
  `,
  // 35: Each confirmed Plane draft owns a separate local task. Retrying that draft finds the same task.
  `
  ALTER TABLE local_team_board_links RENAME TO local_team_board_links_old;
  CREATE TABLE local_team_board_links (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    server TEXT NOT NULL, account TEXT NOT NULL, ticket_id TEXT NOT NULL,
    returned INTEGER NOT NULL DEFAULT 0, plane_context TEXT, request_id TEXT
  );
  INSERT INTO local_team_board_links (task_id, server, account, ticket_id, returned, plane_context)
    SELECT task_id, server, account, ticket_id, returned, plane_context FROM local_team_board_links_old;
  DROP TABLE local_team_board_links_old;
  CREATE UNIQUE INDEX local_team_board_original ON local_team_board_links (server, account, ticket_id) WHERE request_id IS NULL;
  CREATE UNIQUE INDEX local_team_board_request ON local_team_board_links (server, account, ticket_id, request_id) WHERE request_id IS NOT NULL;
  `,
  // 36: Bot identity and requests live independently of the projects and conversations they point to.
  `
  CREATE TABLE studio_bots (
    id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
    home_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
  );
  CREATE TABLE studio_bot_requests (
    id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES studio_bots(id),
    source_session_id TEXT, session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL, data TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX studio_bot_requests_source ON studio_bot_requests (source_session_id, created_at DESC);
  CREATE INDEX studio_bot_requests_session ON studio_bot_requests (session_id);
  CREATE TABLE studio_bot_workers (
    request_id TEXT PRIMARY KEY REFERENCES studio_bot_requests(id), task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
  );
  CREATE TABLE studio_bot_groups (
    id TEXT PRIMARY KEY, name_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL
  );
  CREATE TABLE studio_bot_group_posts (
    id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES studio_bot_groups(id), created_at TEXT NOT NULL, data TEXT NOT NULL,
    dispatched INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX studio_bot_group_posts_group ON studio_bot_group_posts(group_id, created_at DESC);
  CREATE TABLE studio_bot_group_chats (
    group_id TEXT NOT NULL REFERENCES studio_bot_groups(id), bot_id TEXT NOT NULL REFERENCES studio_bots(id),
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, PRIMARY KEY(group_id, bot_id)
  );
  `,
  // 37: Manual Plane intake and the durable comment delivery state.
  `
  CREATE TABLE plane_bot_jobs (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, viewer_id TEXT NOT NULL, item_id TEXT NOT NULL,
    bot_id TEXT NOT NULL, workspace_id TEXT NOT NULL, topic_id TEXT,
    prompt TEXT NOT NULL, item_data TEXT NOT NULL, task_id TEXT UNIQUE,
    sent_result_id TEXT, comment_id TEXT, error TEXT,
    UNIQUE(source, viewer_id, item_id)
  );
  `,
  // 38: Keep a native Plane comment attempt durable even when the response is lost.
  `
  CREATE TABLE plane_bot_native_attempts (
    result_id TEXT PRIMARY KEY
  );
  `,
  // 39: An old intake never recorded the Git baseline of its analysis, so ask for a fresh plan before starting it.
  `
  ALTER TABLE plane_bot_jobs ADD COLUMN base_commit TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN plan TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN plan_hash TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN approved_at TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN declined_at TEXT;
  UPDATE plane_bot_jobs SET error = '升级前的接单没有记录基准提交，请重试接单。' WHERE task_id IS NULL;
  `,
  // 40: Keep the delivery and its Bot request together so a check can be deduplicated after a restart.
  `
  ALTER TABLE plane_bot_jobs ADD COLUMN check_result_id TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN check_request_id TEXT;
  `,
  // 41: New-task drafts can keep their uploaded images with the first sentence until the first session.
  `
  ALTER TABLE tasks ADD COLUMN first_message_attachments TEXT;
  `,
  // 42: Clear Plane intake records for workers permanently deleted by older Hosts.
  `
  DELETE FROM plane_bot_jobs WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
  `,
  // 43: A Bot may lead several tasks. Keep each appointment, including its original identity and configuration.
  `
  CREATE TABLE studio_bot_lead_terms (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    bot_id TEXT NOT NULL REFERENCES studio_bots(id),
    generation INTEGER NOT NULL CHECK (generation > 0),
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    snapshot TEXT NOT NULL,
    handoff TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE(task_id, generation)
  );
  CREATE UNIQUE INDEX studio_bot_lead_current_task ON studio_bot_lead_terms(task_id) WHERE ended_at IS NULL;
  CREATE UNIQUE INDEX studio_bot_lead_session ON studio_bot_lead_terms(session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX studio_bot_lead_current_bot ON studio_bot_lead_terms(bot_id) WHERE ended_at IS NULL;
  `,
  // 44: Durable local acceptance, handoff, and the identity reserved before crossing the runtime boundary.
  `
  ALTER TABLE studio_bot_lead_terms ADD COLUMN source TEXT NOT NULL DEFAULT '{"kind":"legacy-binding"}';
  ALTER TABLE studio_bot_lead_terms ADD COLUMN run_state TEXT NOT NULL DEFAULT 'needs-reconciliation';
  ALTER TABLE studio_bot_lead_terms ADD COLUMN reason TEXT;
  ALTER TABLE studio_bot_lead_terms ADD COLUMN launch_session_id TEXT;
  ALTER TABLE studio_bot_lead_terms ADD COLUMN launch_operation_id TEXT;
  CREATE TABLE studio_bot_lead_sessions (
    session_id TEXT PRIMARY KEY,
    term_id TEXT NOT NULL REFERENCES studio_bot_lead_terms(id) ON DELETE CASCADE
  );
  INSERT INTO studio_bot_lead_sessions SELECT session_id, id FROM studio_bot_lead_terms WHERE session_id IS NOT NULL;
  CREATE TABLE studio_bot_lead_operations (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    bot_id TEXT REFERENCES studio_bots(id),
    receipt TEXT,
    upgrade TEXT,
    delivery TEXT,
    control TEXT
  );
  CREATE UNIQUE INDEX studio_bot_lead_pending_upgrade ON studio_bot_lead_operations(task_id) WHERE upgrade IS NOT NULL;
  CREATE INDEX studio_bot_lead_task_delivery ON studio_bot_lead_operations(task_id) WHERE delivery IS NOT NULL;
  CREATE TABLE studio_bot_lead_acceptances (
    source_key TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES studio_bot_lead_operations(id) ON DELETE CASCADE
  );
  CREATE TABLE studio_bot_lead_continuations (
    source_key TEXT NOT NULL,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL REFERENCES studio_bot_lead_operations(id) ON DELETE CASCADE,
    PRIMARY KEY(source_key, topic_id)
  );
  `,
  // 45: Plane managed roots keep approved plans and per-delivery writeback receipts.
  `
  ALTER TABLE plane_bot_jobs ADD COLUMN root_task_id TEXT REFERENCES tasks(id);
  ALTER TABLE plane_bot_jobs ADD COLUMN approved_plan_hash TEXT;
  ALTER TABLE plane_bot_jobs ADD COLUMN planned_project_path TEXT;
  CREATE UNIQUE INDEX plane_bot_root ON plane_bot_jobs(root_task_id) WHERE root_task_id IS NOT NULL;
  CREATE UNIQUE INDEX plane_bot_managed_item ON plane_bot_jobs(source, item_id) WHERE root_task_id IS NOT NULL;
  CREATE TABLE plane_bot_approvals (
    job_id TEXT NOT NULL REFERENCES plane_bot_jobs(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    project_path TEXT NOT NULL,
    target TEXT NOT NULL,
    approved_at TEXT NOT NULL,
    PRIMARY KEY(job_id, plan_hash)
  );
  CREATE TABLE plane_bot_writebacks (
    job_id TEXT NOT NULL REFERENCES plane_bot_jobs(id) ON DELETE CASCADE,
    result_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    comment_id TEXT,
    sent_at TEXT,
    PRIMARY KEY(job_id, result_id)
  );
  CREATE TABLE plane_bot_managed_members (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL REFERENCES plane_bot_jobs(id) ON DELETE CASCADE,
    plan_hash TEXT NOT NULL
  );
  INSERT INTO plane_bot_writebacks (job_id, result_id, started_at, comment_id, sent_at)
    SELECT id, sent_result_id, COALESCE(approved_at, ''), comment_id, NULL FROM plane_bot_jobs
    WHERE sent_result_id IS NOT NULL AND comment_id IS NOT NULL;
  `,
];
