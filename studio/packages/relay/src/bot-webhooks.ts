import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BotWebhookEvent } from "@amo-studio/protocol";
import { RelayError } from "./store.js";

const HOUR = 3600_000;
const STATUS = new Set(["queued", "running", "waiting", "completed", "failed", "stopped"]);
const digest = (value: string) => createHash("sha256").update(value).digest();
export const botHookId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new RelayError("bad_request", "事件编号无效。");
  return value;
};

export class BotWebhooks {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS bot_hooks (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, device TEXT NOT NULL, bot_id TEXT NOT NULL, verifier TEXT NOT NULL, allow_result INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_hooks_owner ON bot_hooks(owner, device);
      CREATE TABLE IF NOT EXISTS bot_hook_events (
      hook_id TEXT NOT NULL REFERENCES bot_hooks(id) ON DELETE CASCADE, event_id TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(hook_id, event_id));
      CREATE INDEX IF NOT EXISTS bot_hook_events_created ON bot_hook_events(created_at);`);
  }

  add(owner: string, device: string, botId: string, allowResult: boolean) {
    if (this.list(owner, device).length >= 50) throw new RelayError("conflict", "此设备的 Bot Webhook 已达到上限。");
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO bot_hooks (id, owner, device, bot_id, verifier, allow_result) VALUES (?, ?, ?, ?, ?, ?)").run(id, owner, device, botId, digest(token).toString("hex"), Number(allowResult));
    return { id, botId, token, allowResult };
  }

  list(owner: string, device: string) {
    const rows = this.db.prepare("SELECT id, bot_id AS botId, allow_result FROM bot_hooks WHERE owner = ? AND device = ? ORDER BY id").all(owner, device) as unknown as { id: string; botId: string; allow_result: number }[];
    return rows.map(({ id, botId, allow_result }) => ({ id, botId, allowResult: allow_result === 1 }));
  }

  remove(owner: string, device: string, id: string, botId: string) {
    this.db.prepare("DELETE FROM bot_hooks WHERE owner = ? AND device = ? AND id = ? AND bot_id = ?").run(owner, device, id, botId);
  }

  removeOwner(owner: string) { this.db.prepare("DELETE FROM bot_hooks WHERE owner = ?").run(owner); }

  authenticate(id: string, authorization: string | undefined) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
    const row = token ? this.db.prepare("SELECT verifier FROM bot_hooks WHERE id = ?").get(id) as { verifier: string } | undefined : undefined;
    if (!token || !row || !timingSafeEqual(digest(token), Buffer.from(row.verifier, "hex"))) throw new RelayError("unauthorized", "Webhook 凭据无效。");
  }

  submit(id: string, raw: Record<string, unknown>) {
    const eventId = botHookId(raw.eventId);
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text || text.length > 20_000) throw new RelayError("bad_request", "请填写事件内容，最多 20000 个字符。");
    this.prune();
    const previous = this.read(id, eventId);
    if (previous) {
      if (previous.text !== text) throw new RelayError("conflict", "该事件编号已用于其他内容。");
    } else {
      const count = this.db.prepare("SELECT count(*) AS n FROM bot_hook_events WHERE hook_id = ?").get(id) as { n: number };
      if (count.n >= 200) throw new RelayError("conflict", "此 Webhook 的事件已达到上限。");
      this.db.prepare("INSERT INTO bot_hook_events (hook_id, event_id, text, status, created_at) VALUES (?, ?, ?, 'queued', ?)").run(id, eventId, text, this.now());
    }
    return this.lookup(id, eventId);
  }

  lookup(id: string, eventId: string) {
    this.prune();
    const event = this.read(id, eventId);
    if (!event) throw new RelayError("not_found", "事件不存在或已过期。");
    return { eventId, status: event.status, ...(event.result ? { result: event.result } : {}) };
  }

  pending(owner: string, device: string): BotWebhookEvent[] {
    this.prune();
    return this.db.prepare(`SELECT e.hook_id AS hookId, e.event_id AS eventId, h.bot_id AS botId, e.text, e.status
      FROM bot_hook_events e JOIN bot_hooks h ON e.hook_id = h.id WHERE h.owner = ? AND h.device = ?
      AND e.status IN ('queued', 'running', 'waiting') ORDER BY e.created_at LIMIT 20`).all(owner, device) as unknown as BotWebhookEvent[];
  }

  update(owner: string, device: string, raw: Record<string, unknown>) {
    const status = raw.status;
    if (typeof status !== "string" || !STATUS.has(status)) throw new RelayError("bad_request", "事件状态无效。");
    this.db.prepare(`UPDATE bot_hook_events SET status = ?, result = CASE WHEN (SELECT allow_result FROM bot_hooks WHERE id = hook_id) = 1 THEN ? ELSE NULL END
      WHERE hook_id = ? AND event_id = ?
      AND status IN ('queued', 'running', 'waiting') AND EXISTS (SELECT 1 FROM bot_hooks WHERE id = hook_id AND owner = ? AND device = ?)`)
      .run(status, typeof raw.result === "string" ? raw.result.slice(0, 4000) : null, botHookId(raw.hookId), botHookId(raw.eventId), owner, device);
  }

  private read(id: string, event: string) {
    return this.db.prepare("SELECT text, status, result FROM bot_hook_events WHERE hook_id = ? AND event_id = ?").get(id, event) as { text: string; status: string; result: string | null } | undefined;
  }

  private prune() { this.db.prepare("DELETE FROM bot_hook_events WHERE created_at < ?").run(this.now() - 24 * HOUR); }
}
