import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEAM_TASK_FILE_COUNT, TEAM_TASK_FILE_LIMIT, type TeamTask, type TeamTaskAction, type TeamTaskEvent, type TeamTaskFile, type TeamTaskStatus, type TeamTaskSummary } from "@amo-studio/protocol";
import { RelayError, type RelayStore } from "./store.js";

type TicketRow = { id: string; title: string; project: string; creator: string; assignee: string; status: TeamTaskStatus; revision: number; updated_at: number; description: string };
type EventRow = { id: number; actor: string; action: TeamTaskEvent["action"]; text: string; at: number };
type FileRow = TeamTaskFile & { event_id: number };
type Upload = { name: string; bytes: Buffer };

function text(value: unknown, label: string, limit: number, optional = false): string {
  const out = typeof value === "string" ? value.trim() : "";
  if ((!out && !optional) || out.length > limit) throw new RelayError("bad_request", `${label}${out ? `最多 ${limit} 字` : "不能为空"}`);
  return out;
}

function uploads(value: unknown): Upload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TEAM_TASK_FILE_COUNT) throw new RelayError("bad_request", `每次最多添加 ${TEAM_TASK_FILE_COUNT} 个附件`);
  let total = 0;
  return value.map((entry: { name?: unknown; base64?: unknown } | null) => {
    const name = text(entry?.name, "文件名", 180);
    if (/[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new RelayError("bad_request", "附件文件名无效");
    if (typeof entry?.base64 !== "string" || !/^[a-z0-9+/]+={0,2}$/i.test(entry.base64) || entry.base64.length % 4 !== 0 || entry.base64.length > Math.ceil(TEAM_TASK_FILE_LIMIT / 3) * 4) {
      throw new RelayError("bad_request", "附件为空、格式无效或超过 16 MB");
    }
    const bytes = Buffer.from(entry.base64, "base64");
    total += bytes.length;
    if (total > TEAM_TASK_FILE_LIMIT) throw new RelayError("bad_request", "每次发送的附件合计最多 16 MB");
    return { name, bytes };
  });
}

function summary(row: TicketRow): TeamTaskSummary {
  return { id: row.id, title: row.title, project: row.project, creator: row.creator, assignee: row.assignee, status: row.status, revision: row.revision, updatedAt: row.updated_at };
}

/** Team intake is private to its participants, including every attachment. Legacy relay tasks are team-visible. */
export class TeamTasksStore {
  private readonly db;
  private readonly dir?: string;

  constructor(store: RelayStore, filesDir?: string) {
    this.db = store.db;
    this.dir = filesDir && join(filesDir, "team-tasks");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS team_tickets (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, creator TEXT NOT NULL REFERENCES members(name) ON UPDATE CASCADE,
        assignee TEXT NOT NULL REFERENCES members(name) ON UPDATE CASCADE,
        title TEXT NOT NULL, project TEXT NOT NULL, description TEXT NOT NULL,
        status TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(creator, request_id)
      );
      CREATE INDEX IF NOT EXISTS team_tickets_assignee ON team_tickets(assignee, updated_at);
      CREATE TABLE IF NOT EXISTS team_ticket_events (
        id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES team_tickets(id),
        actor TEXT NOT NULL REFERENCES members(name) ON UPDATE CASCADE, action TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_ticket_events_ticket ON team_ticket_events(ticket_id, id);
      CREATE TABLE IF NOT EXISTS team_ticket_files (
        id TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES team_ticket_events(id), name TEXT NOT NULL, size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS team_ticket_files_event ON team_ticket_files(event_id);
    `);
  }

  private visible(me: string, id: string): TicketRow {
    const row = this.db.prepare("SELECT * FROM team_tickets WHERE id = ? AND (creator = ? OR assignee = ?)").get(id, me, me) as TicketRow | undefined;
    if (!row) throw new RelayError("not_found", "找不到这张团队任务");
    return row;
  }

  list(me: string): TeamTaskSummary[] {
    return (this.db.prepare("SELECT * FROM team_tickets WHERE creator = ? OR assignee = ? ORDER BY updated_at DESC, id DESC").all(me, me) as TicketRow[]).map(summary);
  }

  parts(me: string): { name: string; members: { name: string; nick: string }[] } {
    const members = this.db.prepare("SELECT name, nick FROM members WHERE disabled = 0 ORDER BY rowid").all() as { name: string; nick: string }[];
    return { name: me, members };
  }

  detail(me: string, id: string): TeamTask {
    const row = this.visible(me, id);
    const files = this.db.prepare("SELECT f.* FROM team_ticket_files f JOIN team_ticket_events e ON f.event_id = e.id WHERE e.ticket_id = ? ORDER BY f.rowid").all(id) as FileRow[];
    const events = this.db.prepare("SELECT id, actor, action, text, at FROM team_ticket_events WHERE ticket_id = ? ORDER BY id").all(id) as EventRow[];
    return { ...summary(row), description: row.description, events: events.map((event) => ({ ...event, files: files.filter((file) => file.event_id === event.id).map(({ id, name, size }) => ({ id, name, size })) })) };
  }

  file(me: string, id: string, fileId: string): TeamTaskFile & { path: string } {
    this.visible(me, id);
    const file = this.db.prepare("SELECT f.id, f.name, f.size FROM team_ticket_files f JOIN team_ticket_events e ON f.event_id = e.id WHERE e.ticket_id = ? AND f.id = ?").get(id, fileId) as TeamTaskFile | undefined;
    if (!file || !this.dir) throw new RelayError("not_found", "找不到这份附件");
    return { ...file, path: join(this.dir, file.id) };
  }

  create(me: string, input: Record<string, unknown>): TeamTask {
    const requestId = text(input.requestId, "提交编号", 64);
    const prior = this.db.prepare("SELECT id FROM team_tickets WHERE creator = ? AND request_id = ?").get(me, requestId);
    if (prior) return this.detail(me, String(prior.id));
    const title = text(input.title, "标题", 120);
    const project = text(input.project, "相关项目", 120, true);
    const description = text(input.description, "说明", 4000);
    const assignee = text(input.assignee, "接收人", 120);
    if (!this.db.prepare("SELECT 1 FROM members WHERE name = ? AND disabled = 0").get(assignee)) throw new RelayError("bad_request", "接收人不存在或账号已停用");
    const files = uploads(input.files);
    const id = `team-${randomUUID()}`;
    const at = Date.now();
    this.write(files, (saved) => {
      this.db.prepare("INSERT INTO team_tickets VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)").run(id, requestId, me, assignee, title, project, description, at);
      this.event(id, me, "create", "", at, saved);
    });
    return this.detail(me, id);
  }

  change(me: string, id: string, input: Record<string, unknown>): TeamTask {
    const row = this.visible(me, id);
    const action = input.action as TeamTaskAction;
    const receiver = action === "start" || action === "deliver";
    const sender = action === "accept" || action === "return";
    if (!receiver && !sender && action !== "note") throw new RelayError("bad_request", "这个任务动作不存在");
    if ((receiver && row.assignee !== me) || (sender && row.creator !== me)) throw new RelayError("forbidden", "当前账号不能执行这个动作");
    if (action === "start" && row.status === "doing") return this.detail(me, id);
    if (input.revision !== row.revision) throw new RelayError("conflict", "原单已有更新，请刷新后再提交");
    const allowed = action === "start" ? row.status === "pending" : action === "deliver" ? row.status === "doing" : sender ? row.status === "review" : row.status !== "done";
    if (!allowed) throw new RelayError("conflict", "原单当前状态不能执行这个动作");
    const files = uploads(input.files);
    const note = text(input.text, "处理说明", 6000, !["deliver", "return"].includes(action));
    if (action === "note" && !note && !files.length) throw new RelayError("bad_request", "请填写补充说明或添加附件");
    const status = action === "accept" ? "done" : action === "deliver" ? "review" : action === "note" ? row.status : "doing";
    const at = Date.now();
    this.write(files, (saved) => {
      const changed = this.db.prepare("UPDATE team_tickets SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(status, at, id, row.revision);
      if (!changed.changes) throw new RelayError("conflict", "原单已有更新，请刷新后再提交");
      this.event(id, me, action, note, at, saved);
    });
    return this.detail(me, id);
  }

  private event(ticket: string, actor: string, action: TeamTaskEvent["action"], text: string, at: number, files: TeamTaskFile[]): void {
    const inserted = this.db.prepare("INSERT INTO team_ticket_events (ticket_id, actor, action, text, at) VALUES (?, ?, ?, ?, ?)").run(ticket, actor, action, text, at);
    const insert = this.db.prepare("INSERT INTO team_ticket_files (id, event_id, name, size) VALUES (?, ?, ?, ?)");
    for (const file of files) insert.run(file.id, inserted.lastInsertRowid, file.name, file.size);
  }

  private write(uploads: Upload[], operation: (files: TeamTaskFile[]) => void): void {
    const dir = this.dir;
    if (uploads.length && !dir) throw new RelayError("conflict", "团队服务器尚未配置附件存储");
    const saved: TeamTaskFile[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (uploads.length && dir) {
        mkdirSync(dir, { recursive: true });
        for (const upload of uploads) {
          const file = { id: randomUUID(), name: upload.name, size: upload.bytes.length };
          const fd = openSync(join(dir, file.id), "wx");
          saved.push(file);
          try { writeFileSync(fd, upload.bytes); } finally { closeSync(fd); }
        }
      }
      operation(saved);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (dir) for (const file of saved) rmSync(join(dir, file.id), { force: true });
      throw error;
    }
  }
}
