import { setTimeout as delay } from "node:timers/promises";
import type { Id, TurnCharge, TurnUsage } from "@amo-studio/protocol";
import { askSub2ApiKeyUsage, type BalanceAsk, type Sub2ApiKeyUsage } from "../balance.js";

const RETRY_DELAYS_MS = [0, 750, 1500];

interface MeteredTurn {
  sessionId: Id;
  ask: BalanceAsk;
  before: Promise<Sub2ApiKeyUsage | null> | null;
  calls: number;
  finishing: boolean;
}

/** Sub2API bills asynchronously. Use its API-key totals only when the observed requests and tokens fit this turn. */
export class CodexTurnCharges {
  private readonly turns = new Map<Id, MeteredTurn>();

  constructor(private readonly lookup: (profileId: Id) => BalanceAsk | null) {}

  start(sessionId: Id, turnItemId: Id, profileId: Id): void {
    if (this.turns.has(turnItemId)) return;
    const ask = this.lookup(profileId);
    if (ask?.config.template !== "sub2api" || !ask.key) return;
    let overlaps = false;
    for (const turn of this.turns.values()) {
      if (turn.ask.key !== ask.key) continue;
      turn.before = null;
      // Even a completed turn can still have writes pending on the billing service.
      overlaps = true;
    }
    this.turns.set(turnItemId, { sessionId, ask, before: overlaps ? null : this.read(ask), calls: 0, finishing: false });
  }

  called(turnItemId: Id): void {
    const turn = this.turns.get(turnItemId);
    if (turn && !turn.finishing) turn.calls++;
  }

  async finish(turnItemId: Id, usage?: TurnUsage): Promise<TurnCharge | null> {
    const turn = this.turns.get(turnItemId);
    if (!turn || turn.finishing) return null;
    turn.finishing = true;
    try {
      if (!usage || !turn.calls || !turn.before) return null;
      const before = await turn.before;
      if (!before) return null;
      for (const wait of RETRY_DELAYS_MS) {
        if (wait) await delay(wait);
        if (!turn.before) return null;
        const after = await this.read(turn.ask);
        if (!turn.before || !after || after.unit !== before.unit || after.cost < before.cost) return null;
        const requests = after.requests - before.requests;
        const input = after.input - before.input;
        const cached = after.cachedInput - before.cachedInput;
        const output = after.output - before.output;
        if (requests === turn.calls && input === usage.input && cached === usage.cachedInput && output === usage.output) {
          return { amount: Number((after.cost - before.cost).toPrecision(10)), unit: after.unit };
        }
        // Further billing records cannot make these monotonically increasing counters match again.
        if (requests < 0 || input < 0 || cached < 0 || output < 0 || requests > turn.calls || input > usage.input || cached > usage.cachedInput || output > usage.output) return null;
      }
      return null;
    } finally {
      if (this.turns.get(turnItemId) === turn) this.turns.delete(turnItemId);
    }
  }

  cancelSession(sessionId: Id): void {
    for (const [id, turn] of this.turns) {
      if (turn.sessionId !== sessionId) continue;
      turn.before = null;
      this.turns.delete(id);
    }
  }

  private read(ask: BalanceAsk): Promise<Sub2ApiKeyUsage | null> {
    return askSub2ApiKeyUsage({ timeoutMs: 3000, ...ask }).catch(() => null);
  }
}
