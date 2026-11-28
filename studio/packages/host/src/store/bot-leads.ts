import { createHash } from "node:crypto";
import type { BotLeadConfigSnapshot, BotLeadOperationReceipt, BotLeadSource, BotLeadTaskView, BotLeadTerm, BotLeadTermRef, BotLeadTermSummary, Id, Session } from "@amo-studio/protocol";
import { HostError } from "../core/shared.js";
import { newId, type Store } from "./store.js";

interface TermRow {
  id: Id;
  task_id: Id;
  bot_id: Id;
  generation: number;
  session_id: Id | null;
  snapshot: string;
  source: string;
  handoff: string;
  started_at: string;
  ended_at: string | null;
  run_state: BotLeadTerm["runState"];
  reason: string | null;
  launch_session_id: Id | null;
  launch_operation_id: Id | null;
  handing_off?: number;
}

export interface LeadUpgrade {
  botId: Id;
  snapshot: BotLeadConfigSnapshot;
  source: BotLeadSource;
  summary: string;
  topicTitle?: string;
  topicId: Id | null;
  managerTaskId: Id | null;
  workspaceId: Id;
  replaces?: BotLeadTermRef;
  lastError?: string;
}

export interface LeadDelivery {
  term: BotLeadTermRef;
  messageId: Id;
  text: string;
  purpose: "work" | "reopen";
}

type OperationRow = { id: Id; fingerprint: string; task_id: Id | null; bot_id: Id | null; receipt: string | null; upgrade: string | null; delivery: string | null; control: string | null };
export type LeadOperation = {
  id: Id;
  fingerprint: string;
  taskId: Id | null;
  botId: Id | null;
  receipt: BotLeadOperationReceipt | null;
  upgrade: LeadUpgrade | null;
  delivery: LeadDelivery | null;
  control: BotLeadTaskView | BotLeadTaskView[] | null;
};

export function leadTermSummary(term: BotLeadTerm): BotLeadTermSummary {
  const { termId, generation, botId, name, avatar, sessionId, state, runState, reason } = term;
  return { termId, generation, botId, name, avatar, sessionId, state, runState, ...(reason ? { reason } : {}) };
}

function toTerm(row: TermRow): BotLeadTerm {
  const snapshot = JSON.parse(row.snapshot) as BotLeadConfigSnapshot;
  return {
    termId: row.id, taskId: row.task_id, botId: row.bot_id, generation: row.generation, sessionId: row.session_id,
    snapshot, name: snapshot.name, avatar: snapshot.avatar, handoff: row.handoff, source: JSON.parse(row.source) as BotLeadSource,
    startedAt: row.started_at, endedAt: row.ended_at, state: row.ended_at ? "ended" : row.handing_off ? "handing-off" : "active",
    runState: row.run_state, ...(row.reason ? { reason: row.reason } : {}),
  };
}

function toOperation(row: OperationRow): LeadOperation {
  return {
    id: row.id, fingerprint: row.fingerprint, taskId: row.task_id, botId: row.bot_id,
    receipt: row.receipt ? JSON.parse(row.receipt) as BotLeadOperationReceipt : null,
    upgrade: row.upgrade ? JSON.parse(row.upgrade) as LeadUpgrade : null,
    delivery: row.delivery ? JSON.parse(row.delivery) as LeadDelivery : null,
    control: row.control ? JSON.parse(row.control) as LeadOperation["control"] : null,
  };
}

/** Hash the complete validated input without depending on JSON property order. */
export function leadFingerprint(input: unknown): string {
  const json = JSON.stringify(input, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
    : value);
  return createHash("sha256").update(json).digest("hex");
}

export function matchesLeadTerm(term: BotLeadTermRef | null, expected: BotLeadTermRef | null): boolean {
  return term === null || expected === null ? term === expected : term.termId === expected.termId && term.generation === expected.generation;
}

export function leadTermRef({ termId, generation }: BotLeadTermRef): BotLeadTermRef {
  return { termId, generation };
}

export const botRequestSourceKey = (id: Id): string => `request:${id}`;
export const botWorkerOperationId = (id: Id): Id => `bot-worker:${id}`;

const selectTerm = `SELECT t.*, EXISTS(SELECT 1 FROM studio_bot_lead_operations o WHERE o.task_id = t.task_id
  AND o.upgrade IS NOT NULL AND json_extract(o.upgrade, '$.replaces.termId') = t.id) AS handing_off FROM studio_bot_lead_terms t`;

/** A runtime reservation is separate from the active session pointer, which has a session foreign key. */
export class BotLeadStore {
  constructor(private readonly store: Store) {}

  currentTerm(taskId: Id): BotLeadTerm | null {
    const row = this.store.db.prepare(`${selectTerm} WHERE t.task_id = ? AND t.ended_at IS NULL`).get(taskId) as TermRow | undefined;
    return row ? toTerm(row) : null;
  }

  currentTerms(): BotLeadTerm[] {
    return (this.store.db.prepare(`${selectTerm} WHERE t.ended_at IS NULL`).all() as unknown as TermRow[]).map(toTerm);
  }

  term(termId: Id): BotLeadTerm | null {
    const row = this.store.db.prepare(`${selectTerm} WHERE t.id = ?`).get(termId) as TermRow | undefined;
    return row ? toTerm(row) : null;
  }

  terms(taskId: Id): BotLeadTerm[] {
    return (this.store.db.prepare(`${selectTerm} WHERE t.task_id = ? ORDER BY t.generation DESC`).all(taskId) as unknown as TermRow[]).map(toTerm);
  }

  end(termId: Id): void {
    this.store.db.prepare("UPDATE studio_bot_lead_terms SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(new Date().toISOString(), termId);
  }

  appoint(taskId: Id, botId: Id, snapshot: BotLeadConfigSnapshot, source: BotLeadSource, handoff: string, operationId: Id): BotLeadTerm {
    const id = newId("lead-term");
    this.store.db.prepare(`INSERT INTO studio_bot_lead_terms (id, task_id, bot_id, generation, snapshot, handoff, source, started_at, run_state, launch_operation_id)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(generation), 0) + 1 FROM studio_bot_lead_terms WHERE task_id = ?), ?, ?, ?, ?, 'pending', ?)`)
      .run(id, taskId, botId, taskId, JSON.stringify(snapshot), handoff, JSON.stringify(source), new Date().toISOString(), operationId);
    return this.term(id)!;
  }

  launch(termId: Id): { sessionId: Id | null; operationId: Id | null } {
    const row = this.store.db.prepare("SELECT launch_session_id, launch_operation_id FROM studio_bot_lead_terms WHERE id = ?").get(termId) as Pick<TermRow, "launch_session_id" | "launch_operation_id">;
    return { sessionId: row.launch_session_id, operationId: row.launch_operation_id };
  }

  reserveLaunch(termId: Id, sessionId: Id): void {
    this.store.db.prepare("INSERT INTO studio_bot_lead_sessions (session_id, term_id) VALUES (?, ?)").run(sessionId, termId);
    this.store.db.prepare("UPDATE studio_bot_lead_terms SET launch_session_id = ? WHERE id = ?").run(sessionId, termId);
  }

  bindSession(termId: Id, sessionId: Id): boolean {
    return this.store.db.prepare(`UPDATE studio_bot_lead_terms SET session_id = ?, run_state = 'idle', reason = NULL
      WHERE id = ? AND launch_session_id = ? AND ended_at IS NULL AND run_state = 'starting'`).run(sessionId, termId, sessionId).changes === 1;
  }

  setRunState(termId: Id, state: BotLeadTerm["runState"], reason?: string): void {
    this.store.db.prepare(`UPDATE studio_bot_lead_terms SET run_state = ?, reason = ?,
      session_id = CASE WHEN ? = 'pending' THEN NULL ELSE session_id END,
      launch_session_id = CASE WHEN ? = 'pending' THEN NULL ELSE launch_session_id END
      WHERE id = ? AND ended_at IS NULL`).run(state, reason ?? null, state, state, termId);
  }

  operation(id: Id): LeadOperation | null {
    const row = this.store.db.prepare("SELECT * FROM studio_bot_lead_operations WHERE id = ?").get(id) as OperationRow | undefined;
    return row ? toOperation(row) : null;
  }

  beginOperation(id: Id, fingerprint: string): LeadOperation {
    this.store.db.prepare("INSERT OR IGNORE INTO studio_bot_lead_operations (id, fingerprint) VALUES (?, ?)").run(id, fingerprint);
    const entry = this.operation(id)!;
    if (entry.fingerprint !== fingerprint) throw new HostError("conflict", "操作编号已用于其他参数，请刷新后重新操作。", { reason: "operation-conflict", operationId: id });
    return entry;
  }

  rememberBot(id: Id, botId: Id): void {
    this.store.db.prepare("UPDATE studio_bot_lead_operations SET bot_id = ? WHERE id = ?").run(botId, id);
  }

  finishOperation(id: Id, receipt: BotLeadOperationReceipt, upgrade?: LeadUpgrade, delivery?: LeadDelivery): void {
    const saved = delivery ? { ...delivery, term: leadTermRef(delivery.term) } : null;
    this.store.db.prepare("UPDATE studio_bot_lead_operations SET task_id = ?, receipt = ?, upgrade = ?, delivery = ? WHERE id = ?")
      .run(receipt.taskId, JSON.stringify(receipt), upgrade ? JSON.stringify(upgrade) : null, saved ? JSON.stringify(saved) : null, id);
  }

  finishControl(id: Id, taskId: Id, view: BotLeadTaskView | BotLeadTaskView[]): void {
    this.store.db.prepare("UPDATE studio_bot_lead_operations SET task_id = ?, control = ? WHERE id = ?").run(taskId, JSON.stringify(view), id);
  }

  beginReplacement(id: Id, taskId: Id, upgrade: LeadUpgrade): void {
    this.store.db.prepare("UPDATE studio_bot_lead_operations SET task_id = ?, upgrade = ? WHERE id = ?").run(taskId, JSON.stringify(upgrade), id);
  }

  moveQueuedDeliveries(taskId: Id, from: BotLeadTermRef, to: BotLeadTermRef, firstMessageId?: Id): void {
    this.store.db.prepare(`UPDATE studio_bot_lead_operations AS o
      SET delivery = json_set(delivery, '$.term', json(?))
      WHERE task_id = ? AND delivery IS NOT NULL AND json_extract(delivery, '$.term.termId') = ?
      AND json_extract(delivery, '$.messageId') <> ?
      AND NOT EXISTS (SELECT 1 FROM items WHERE id = json_extract(o.delivery, '$.messageId'))`)
      .run(JSON.stringify(leadTermRef(to)), taskId, from.termId, firstMessageId ?? "");
  }

  pendingUpgrade(taskId: Id): LeadOperation | null {
    const row = this.store.db.prepare("SELECT * FROM studio_bot_lead_operations WHERE task_id = ? AND upgrade IS NOT NULL").get(taskId) as OperationRow | undefined;
    return row ? toOperation(row) : null;
  }

  upgrades(): LeadOperation[] {
    return (this.store.db.prepare("SELECT * FROM studio_bot_lead_operations WHERE upgrade IS NOT NULL ORDER BY rowid").all() as unknown as OperationRow[]).map(toOperation);
  }

  setUpgrade(id: Id, upgrade: LeadUpgrade | null): void {
    this.store.db.prepare("UPDATE studio_bot_lead_operations SET upgrade = ? WHERE id = ?").run(upgrade ? JSON.stringify(upgrade) : null, id);
  }

  deliveries(taskId: Id): LeadDelivery[] {
    const rows = this.store.db.prepare(`SELECT delivery FROM studio_bot_lead_operations o WHERE task_id = ? AND delivery IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM items WHERE id = json_extract(o.delivery, '$.messageId')) ORDER BY o.rowid`).all(taskId) as { delivery: string }[];
    return rows.map((row) => JSON.parse(row.delivery) as LeadDelivery);
  }

  firstAcceptance(sourceKey: string): BotLeadOperationReceipt | null {
    const row = this.store.db.prepare(`SELECT o.receipt FROM studio_bot_lead_acceptances a
      JOIN studio_bot_lead_operations o ON o.id = a.operation_id WHERE a.source_key = ?`).get(sourceKey) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) as BotLeadOperationReceipt : null;
  }

  requestAcceptance(requestId: Id): BotLeadOperationReceipt | null {
    const receipt = this.firstAcceptance(botRequestSourceKey(requestId));
    if (receipt) return receipt;
    const row = this.store.db.prepare(`SELECT t.id, t.topic_id FROM studio_bot_workers w
      JOIN tasks t ON t.id = w.task_id WHERE w.request_id = ?`).get(requestId) as { id: Id; topic_id: Id | null } | undefined;
    return row ? { operationId: botWorkerOperationId(requestId), taskId: row.id, topicId: row.topic_id, action: "worker" } : null;
  }

  claimAcceptance(sourceKey: string, operationId: Id): void {
    this.store.db.prepare("INSERT INTO studio_bot_lead_acceptances (source_key, operation_id) VALUES (?, ?)").run(sourceKey, operationId);
  }

  releaseAcceptance(operationId: Id): void {
    this.store.db.prepare("DELETE FROM studio_bot_lead_acceptances WHERE operation_id = ?").run(operationId);
  }

  continuation(sourceKey: string, topicId: Id): BotLeadOperationReceipt | null {
    const row = this.store.db.prepare(`SELECT o.receipt FROM studio_bot_lead_continuations c
      JOIN studio_bot_lead_operations o ON o.id = c.operation_id WHERE c.source_key = ? AND c.topic_id = ?`).get(sourceKey, topicId) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) as BotLeadOperationReceipt : null;
  }

  claimContinuation(sourceKey: string, topicId: Id, operationId: Id): void {
    this.store.db.prepare("INSERT INTO studio_bot_lead_continuations (source_key, topic_id, operation_id) VALUES (?, ?, ?)").run(sourceKey, topicId, operationId);
  }
}

export function leadSessionShape(store: Store, session: Session, term: BotLeadTerm): boolean {
  const nativeProof = session.runtime === "codex" || session.runtime === "dsh" ? store.getKv(`${session.runtime}-lead-readonly:${session.id}`)?.value : session.runtimeRef;
  return session.taskId === term.taskId && session.kind === "main" && !session.parentId && !session.archivedAt && session.writer === "workbench"
    && !!session.runtimeRef && session.profileId === term.snapshot.profileId && session.runtime === term.snapshot.runtime && session.options.permission === term.snapshot.options.permission
    && nativeProof === session.runtimeRef && matchesLeadTerm(session.botLeadTerm ?? null, term);
}
