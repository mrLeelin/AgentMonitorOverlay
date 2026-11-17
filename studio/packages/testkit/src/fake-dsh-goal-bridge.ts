import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Goal { id: string; revision: number; objective: string; phase: string; maxGoalRounds: number; roundsStarted: number; createdAt: number; updatedAt: number; activation: string; blockedReason?: { code: string; message: string } }
/** Test double for the private native-service bridge, deliberately separate from ACP prompts. */
export function startFakeDshGoals(home: string, live: (id: string) => boolean, stop: (id: string) => void): void {
  const raw = process.env.AMO_DSH_GOAL_BRIDGE;
  if (!raw) return;
  const config = JSON.parse(raw) as { socket: string; token: string; instance: string };
  delete process.env.AMO_DSH_GOAL_BRIDGE;
  const file = join(home, "fake-goals.json");
  const goals: Record<string, Goal> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const goal of Object.values(goals)) goal.activation = "disarmed";
  let bound: string | null = null;
  let epoch = 0;
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${config.token}`) return reply(403, {});
    try {
      req.setEncoding("utf8");
      let body = ""; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body) as { instance: string; sessionId: string; epoch: number; action: string; objective?: string; status?: string; roundBudget?: number };
      if (input.instance !== config.instance || !live(input.sessionId) || (bound && bound !== input.sessionId)) throw new Error("Goal session mismatch");
      bound = input.sessionId;
      if (input.action === "set" && input.epoch < epoch) throw new Error("Goal activation was cancelled");
      epoch = Math.max(epoch, input.epoch);
      let goal = goals[bound];
      if (input.action === "set") {
        if (input.objective !== undefined && (!goal || goal.phase === "complete")) goal = goals[bound] = { id: randomUUID(), revision: 0, objective: input.objective, phase: "active", maxGoalRounds: input.roundBudget ?? 256, roundsStarted: 0, createdAt: Date.now(), updatedAt: Date.now(), activation: "armed" };
        if (!goal) throw new Error("No native goal exists");
        if (input.objective !== undefined) goal.objective = input.objective;
        if (input.roundBudget !== undefined) goal.maxGoalRounds = input.roundBudget;
        if (input.status === "paused") { goal.phase = "paused"; goal.activation = "disarmed"; stop(bound); }
        else if (input.status === "active") {
          if (goal.roundsStarted >= goal.maxGoalRounds) throw new Error("Goal round budget exhausted; increase maxGoalRounds before resuming");
          goal.phase = "active"; goal.activation = "armed";
          delete goal.blockedReason;
        }
        goal.revision++; goal.updatedAt = Date.now();
      } else if (input.action === "clear") delete goals[bound];
      else if (input.action !== "get") throw new Error("Unknown Goal action");
      writeFileSync(file, JSON.stringify(goals));
      reply(200, { instance: config.instance, pid: process.pid, sessionId: bound, goal: goals[bound] ?? null });
    } catch (error) { reply(400, { error: String(error) }); }
  });
  server.listen(config.socket);
  server.unref();
}
