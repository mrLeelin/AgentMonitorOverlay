import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEAM_TASK_FILE_COUNT, TEAM_TASK_FILE_LIMIT, TeamBoardError, type TeamBoardAction, type TeamBoardClaim, type TeamBoardEvent, type TeamBoardNotice, type TeamBoardSnapshot, type TeamBoardSummary, type TeamBoardTicket, type TeamTaskStatus } from "@amo-studio/protocol";

type Row = { id: string; title: string; description: string; creator: string; assignee: string | null; status: TeamTaskStatus; revision: number; updated: number; claim_id: string | null; previous_assignee: string | null };
type Upload = { name: string; bytes: Buffer };

export function text(value: unknown, label: string, limit: number, optional = false): string {
  if (value != null && typeof value !== "string") throw new TeamBoardError(400, `${label}格式无效`);
  const result = typeof value === "string" ? value.trim() : "";
  if (result.length > limit || (!result && !optional)) throw new TeamBoardError(400, result ? `${label}最多 ${limit} 字` : `${label}不能为空`);
  return result;
}

function uploads(value: unknown): Upload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > TEAM_TASK_FILE_COUNT) throw new TeamBoardError(400, `每次最多添加 ${TEAM_TASK_FILE_COUNT} 个附件`);
  let total = 0;
  return value.map((entry: { name?: unknown; base64?: unknown } | null) => {
    const name = text(entry?.name, "文件名", 180);
    if (/[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") throw new TeamBoardError(400, "附件文件名无效");
    const encoded = entry?.base64;
    if (typeof encoded !== "string" || encoded.length > Math.ceil(TEAM_TASK_FILE_LIMIT / 3) * 4 || encoded.length % 4 || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) throw new TeamBoardError(400, "附件大小或格式无效");
    const bytes = Buffer.from(encoded, "base64");
    total += bytes.length;
    if (total > TEAM_TASK_FILE_LIMIT) throw new TeamBoardError(400, "附件合计最多 16 MB");
    return { name, bytes };
  });
}

const summary = (row: Row): TeamBoardSummary => ({ id: row.id, title: row.title, creator: row.creator, assignee: row.assignee, status: row.status, revision: row.revision, updatedAt: row.updated });

export class TeamBoardStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
        creator TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL, revision INTEGER NOT NULL, updated INTEGER NOT NULL,
        claim_id TEXT, previous_assignee TEXT, UNIQUE(creator, request_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), actor TEXT NOT NULL, action TEXT NOT NULL,
        text TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, id);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), name TEXT NOT NULL, bytes BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS files_event ON files(event_id);
      CREATE TABLE IF NOT EXISTS review_notices (
        ticket_id TEXT PRIMARY KEY REFERENCES tickets(id), recipient TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, unread INTEGER NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private row(id: string): Row {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new TeamBoardError(404, "找不到这张团队任务");
    return row;
  }

  snapshot(name: string): TeamBoardSnapshot {
    const notices = this.db.prepare("SELECT n.ticket_id AS ticketId, t.title, n.actor, n.at, n.unread FROM review_notices n JOIN tickets t ON t.id = n.ticket_id WHERE n.recipient = ? AND t.status = 'review' ORDER BY n.at DESC").all(name) as Array<Omit<TeamBoardNotice, "unread"> & { unread: number }>;
    const tickets = this.db.prepare("SELECT * FROM tickets ORDER BY updated DESC, id DESC").all() as Row[];
    return { name, tickets: tickets.map(summary), notices: notices.map((row) => ({ ...row, unread: !!row.unread })) };
  }

  detail(id: string): TeamBoardTicket {
    const row = this.row(id);
    const events = this.db.prepare("SELECT id, actor, action, text, at FROM events WHERE ticket_id = ? ORDER BY id").all(id) as Array<Omit<TeamBoardEvent, "files">>;
    const files = this.db.prepare("SELECT f.id, f.name, length(f.bytes) AS size, f.event_id FROM files f JOIN events e ON f.event_id = e.id WHERE e.ticket_id = ? ORDER BY f.rowid").all(id) as Array<{ id: string; name: string; size: number; event_id: number }>;
    return { ...summary(row), description: row.description, events: events.map((event) => ({ ...event, files: files.filter((file) => file.event_id === event.id).map(({ id, name, size }) => ({ id, name, size })) })) };
  }

  file(id: string, fileId: string): { name: string; bytes: Uint8Array } {
    const file = this.db.prepare("SELECT f.name, f.bytes FROM files f JOIN events e ON f.event_id = e.id WHERE e.ticket_id = ? AND f.id = ?").get(id, fileId) as { name: string; bytes: Uint8Array } | undefined;
    if (!file) throw new TeamBoardError(404, "找不到这份附件");
    return file;
  }

  create(me: string, input: Record<string, unknown>, members: readonly string[]): TeamBoardTicket {
    const request = text(input.requestId, "提交编号", 64);
    const title = text(input.title, "标题", 120);
    const description = text(input.description, "说明", 4000);
    const assignee = text(input.assignee, "执行者", 120, true) || null;
    if (assignee && !members.includes(assignee)) throw new TeamBoardError(400, "请选择有效的团队成员");
    const files = uploads(input.files);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM tickets WHERE creator = ? AND request_id = ?").get(me, request);
      if (existing) return this.detail(String(existing.id));
      const id = `team-${randomUUID()}`;
      const at = Date.now();
      this.db.prepare("INSERT INTO tickets (id, request_id, title, description, creator, assignee, status, revision, updated) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)").run(id, request, title, description, me, assignee, at);
      this.event(id, me, "create", "", at, files);
      return this.detail(id);
    });
  }

  claim(me: string, id: string, revision: unknown): TeamBoardClaim {
    return this.transaction(() => {
      const row = this.row(id);
      // Retry after a lost response, or open an already imported task on the same account.
      if (row.assignee === me && row.status === "doing") return { ticket: this.detail(id), claimId: null };
      if (row.status !== "pending") throw new TeamBoardError(409, row.assignee ? `当前执行者是 ${row.assignee}，请刷新看板` : "任务已离开待定，请刷新看板");
      if (row.revision !== revision) throw new TeamBoardError(409, "团队原单已有更新，请刷新后接单");
      const claimId = randomUUID();
      const at = Date.now();
      this.db.prepare("UPDATE tickets SET status = 'doing', assignee = ?, previous_assignee = ?, claim_id = ?, revision = revision + 1, updated = ? WHERE id = ?").run(me, row.assignee, claimId, at, id);
      this.event(id, me, "claim", row.assignee && row.assignee !== me ? `原执行者 ${row.assignee}` : "", at);
      return { ticket: this.detail(id), claimId };
    });
  }

  release(me: string, id: string, claimId: unknown): void {
    this.transaction(() => {
      const row = this.row(id);
      if (row.status !== "doing" || row.assignee !== me || !row.claim_id || row.claim_id !== claimId) return;
      const at = Date.now();
      this.db.prepare("UPDATE tickets SET status = 'pending', assignee = previous_assignee, previous_assignee = NULL, claim_id = NULL, revision = revision + 1, updated = ? WHERE id = ?").run(at, id);
      this.event(id, me, "release", "本地接入未完成，已退回待定。", at);
    });
  }

  change(me: string, id: string, input: Record<string, unknown>): TeamBoardTicket {
    const action = input.action as TeamBoardAction;
    if (action === "withdraw" || !["deliver", "accept", "return", "note"].includes(action)) throw new TeamBoardError(400, "任务动作无效");
    const body = text(input.text, "评论", 6000, true);
    const files = uploads(input.files);
    if (action === "note" && !body && !files.length) throw new TeamBoardError(400, "请填写评论或添加附件");
    return this.transaction(() => {
      const row = this.row(id);
      const replacesStage = action !== "note";
      const allowed = action === "deliver" ? row.assignee === me : action === "note" ? row.creator === me || row.assignee === me : row.creator === me;
      if (!allowed) throw new TeamBoardError(403, "当前身份不能执行这个操作");
      if (row.revision !== input.revision) throw new TeamBoardError(409, "原单已有更新，请刷新后再操作");
      if (replacesStage && row.status !== (action === "deliver" ? "doing" : "review")) throw new TeamBoardError(409, "原单当前状态不能执行这个动作");
      const stage = { deliver: "review", accept: "done", return: "pending", note: row.status }[action];
      const at = Date.now();
      this.db.prepare("UPDATE tickets SET status = ?, claim_id = ?, previous_assignee = ?, revision = revision + 1, updated = ? WHERE id = ?").run(stage, replacesStage ? null : row.claim_id, replacesStage ? null : row.previous_assignee, at, id);
      this.event(id, me, action, body, at, files);
      if (action === "deliver") this.db.prepare("INSERT INTO review_notices VALUES (?, ?, ?, ?, 1) ON CONFLICT(ticket_id) DO UPDATE SET actor = excluded.actor, at = excluded.at, unread = 1").run(id, row.creator, me, at);
      if (action === "accept" || action === "return") this.db.prepare("DELETE FROM review_notices WHERE ticket_id = ?").run(id);
      return this.detail(id);
    });
  }

  readNotice(me: string, id: string): void {
    this.db.prepare("UPDATE review_notices SET unread = 0 WHERE ticket_id = ? AND recipient = ?").run(id, me);
  }

  private event(id: string, actor: string, action: TeamBoardEvent["action"], body: string, at: number, uploads: Upload[] = []): void {
    const record = this.db.prepare("INSERT INTO events (ticket_id, actor, action, text, at) VALUES (?, ?, ?, ?, ?)").run(id, actor, action, body, at);
    const insert = this.db.prepare("INSERT INTO files (id, event_id, name, bytes) VALUES (?, ?, ?, ?)");
    for (const file of uploads) insert.run(randomUUID(), record.lastInsertRowid, file.name, file.bytes);
  }
}
