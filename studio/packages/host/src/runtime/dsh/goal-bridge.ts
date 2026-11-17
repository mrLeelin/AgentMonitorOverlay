import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionGoal, SessionGoalState } from "@amo-studio/protocol";

export const DSH_GOAL_BRIDGE_ENV = "AMO_DSH_GOAL_BRIDGE";
export const DSH_GOAL_CAPABILITIES = { tokenBudget: false, roundBudget: true, pause: true, tokens: false, elapsed: false };
export const DSH_GOAL_NOTE = "DSH 暂停会中断当前回复；清除目标只停止后续目标轮。预算按续跑轮数计算。";

export interface DshNativeGoal {
  id: string; revision: number; objective: string; phase: "active" | "paused" | "blocked" | "complete";
  maxGoalRounds: number; roundsStarted: number; createdAt: number; updatedAt: number; activation: "armed" | "disarmed";
  blockedReason?: { code: string; message: string };
}

export function dshGoalState(threadId: string, goal: DshNativeGoal | null): SessionGoalState {
  const snapshot: SessionGoal | null = goal ? {
    threadId, objective: goal.objective,
    status: goal.phase === "active" && goal.activation !== "armed" ? "paused" : goal.phase === "blocked" && goal.blockedReason?.code === "round-limit" ? "budgetLimited" : goal.phase,
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: Math.floor(goal.createdAt / 1000), updatedAt: Math.floor(goal.updatedAt / 1000),
    iterations: goal.roundsStarted, roundBudget: goal.maxGoalRounds, ...(goal.blockedReason?.message ? { lastReason: goal.blockedReason.message } : {}),
  } : null;
  return { goal: snapshot, capabilities: DSH_GOAL_CAPABILITIES, note: DSH_GOAL_NOTE };
}

/** A private side channel into the same ACP process, not a text command sent to its model. */
export class DshGoalBridge {
  readonly instance = randomUUID();
  readonly socket = process.platform === "win32" ? `\\\\.\\pipe\\amo-dsh-goal-${this.instance}` : join(tmpdir(), `amo-dsh-goal-${this.instance}.sock`);
  private readonly token = randomBytes(32).toString("hex");
  private sessionId: string | null = null;
  private pid: number | undefined;
  private closed = false;
  private epoch = 0;
  readonly patch: string;
  private readonly plugin: string;

  constructor(dir: string, originalPatch?: string | null) {
    const patches = join(dir, "patches");
    mkdirSync(patches, { recursive: true });
    const plugin = this.plugin = join(patches, `amo-goal-bridge-${this.instance}.mjs`);
    writeFileSync(plugin, DSH_GOAL_PLUGIN, "utf8");
    this.patch = join(patches, `goal-${this.instance}.yml`);
    const previous = originalPatch ? readFileSync(originalPatch, "utf8").trimEnd() + "\n" : "";
    writeFileSync(this.patch, `${previous}- insert:\n    - id: amo-goal-bridge\n      name: ${JSON.stringify(pathToFileURL(plugin).href)}\n      inject: [agents, goals]\n`, "utf8");
  }

  environment(): string { return JSON.stringify({ socket: this.socket, token: this.token, instance: this.instance }); }
  bind(sessionId: string, pid: number | undefined): void { this.sessionId = sessionId; this.pid = pid; }
  stopPendingActivations(): void { this.epoch++; }
  async call(action: "get" | "set" | "clear", input: { objective?: string; status?: "active" | "paused"; roundBudget?: number } = {}): Promise<DshNativeGoal | null> {
    if (this.closed || !this.sessionId || !this.pid) throw new Error("DSH Goal 桥接尚未就绪。");
    const result = await new Promise<{ instance: string; pid: number; sessionId: string; goal: DshNativeGoal | null }>((resolve, reject) => {
      const body = JSON.stringify({ instance: this.instance, sessionId: this.sessionId, epoch: this.epoch, action, ...input });
      const req = request({ socketPath: this.socket, agent: false, method: "POST", path: "/goal", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (part: string) => { text += part; if (text.length > 64 * 1024) req.destroy(new Error("DSH Goal 回应过大。")); });
        res.on("end", () => {
          try {
            const value = JSON.parse(text) as { error?: string; instance: string; pid: number; sessionId: string; goal: DshNativeGoal | null };
            if (res.statusCode !== 200) return reject(new Error(value.error || "DSH Goal 操作失败。"));
            resolve(value);
          } catch { reject(new Error("DSH Goal 回应格式无效。")); }
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error("DSH Goal 操作超时。")));
      req.on("error", reject);
      req.end(body);
    });
    if (result.instance !== this.instance || result.pid !== this.pid || result.sessionId !== this.sessionId) throw new Error("DSH Goal 桥接的会话或进程不匹配。");
    return result.goal;
  }
  close(): void {
    this.closed = true;
    for (const file of [this.patch, this.plugin, ...(process.platform === "win32" ? [] : [this.socket])]) {
      try { rmSync(file, { force: true }); } catch { /* A locked temporary artifact must not suppress the process-exit event. */ }
    }
  }
}

// Only Node built-ins are imported: Cordis supplies its actual live agents/goals services. No DSH private package
// is copied or patched, and the single-session channel is closed with the plugin/process.
export const DSH_GOAL_PLUGIN = String.raw`import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
export const name = 'amo-goal-bridge';
export const inject = ['agents', 'goals'];
export function apply(ctx) {
  const raw = process.env.AMO_DSH_GOAL_BRIDGE;
  if (!raw) return;
  const config = JSON.parse(raw);
  delete process.env.AMO_DSH_GOAL_BRIDGE;
  let bound = null;
  let epoch = 0;
  const auth = Buffer.from('Bearer ' + config.token);
  const server = createServer(async (req, res) => {
    const incoming = Buffer.from(req.headers.authorization || '');
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'POST' || req.url !== '/goal' || incoming.length !== auth.length || !timingSafeEqual(incoming, auth)) return reply(403, { error: 'DSH Goal bridge access denied' });
    try {
      req.setEncoding('utf8');
      let rawBody = '';
      for await (const chunk of req) { rawBody += chunk; if (rawBody.length > 24000) throw new Error('Goal request too large'); }
      const input = JSON.parse(rawBody);
      if (input.instance !== config.instance || typeof input.sessionId !== 'string' || !input.sessionId || (bound && bound !== input.sessionId)) throw new Error('Goal session mismatch');
      if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new Error('Invalid Goal generation');
      if (input.action === 'set' && input.epoch < epoch) throw new Error('Goal activation was cancelled');
      epoch = Math.max(epoch, input.epoch);
      const agent = ctx.agents.get(input.sessionId);
      if (!agent || agent.session.id !== input.sessionId) throw new Error('Goal session is not live');
      bound = input.sessionId;
      let goal = ctx.goals.get(agent);
      const ref = () => ({ id: goal.id, revision: goal.revision });
      if (input.action === 'set') {
        if (input.roundBudget !== undefined && (!Number.isSafeInteger(input.roundBudget) || input.roundBudget < 1)) throw new Error('Invalid round budget');
        if (input.objective !== undefined && (typeof input.objective !== 'string' || !input.objective.trim() || [...input.objective].length > 4000)) throw new Error('Invalid goal objective');
        if (input.status !== undefined && input.status !== 'active' && input.status !== 'paused') throw new Error('Invalid goal status');
        if (input.objective !== undefined && (!goal || goal.phase === 'complete')) goal = ctx.goals.create(agent, { objective: input.objective, ...(input.roundBudget === undefined ? {} : { maxGoalRounds: input.roundBudget }) });
        else if (input.objective !== undefined || input.roundBudget !== undefined) {
          if (!goal) throw new Error('No native goal exists');
          goal = ctx.goals.edit(agent, ref(), { ...(input.objective === undefined ? {} : { objective: input.objective }), ...(input.roundBudget === undefined ? {} : { maxGoalRounds: input.roundBudget }) });
        }
        if (!goal) throw new Error('No native goal exists');
        if (input.status === 'paused' && goal.phase === 'active') goal = ctx.goals.pause(agent, ref());
        else if (input.status === 'active' && (goal.phase !== 'active' || goal.activation !== 'armed')) goal = ctx.goals.resume(agent, ref());
      } else if (input.action === 'clear') {
        if (goal) ctx.goals.clear(agent, ref());
      } else if (input.action !== 'get') throw new Error('Unknown goal action');
      reply(200, { instance: config.instance, pid: process.pid, sessionId: input.sessionId, goal: ctx.goals.get(agent) || null });
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(config.socket);
  server.unref();
  server.on('connection', (socket) => socket.unref());
  server.on('error', () => ctx.logger.warn('AMO Goal bridge could not open its private channel'));
  ctx.on('dispose', () => new Promise((resolve) => server.close(resolve)));
}
`;
