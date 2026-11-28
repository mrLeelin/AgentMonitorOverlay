import type { Id } from "@amo-studio/protocol";
import { appointmentRequired } from "../../core/bot-lead-access.js";
import { Feature } from "../../core/feature.js";
import { HostError } from "../../core/shared.js";
import { isPlaneBotWorker } from "../../store/plane-bot.js";

const KEY = "tasks.lead-promotions";
export type LegacyPromotion = {
  taskId: Id;
  sourceSessionId: Id;
  summary: string;
  topicTitle?: string;
  oldSessionIds: Id[];
  state: "pending" | "switching" | "starting" | "done" | "failed";
  sessionId?: Id;
  error?: string;
  retryState?: "pending" | "switching" | "starting";
};

/** Old approvals and handoff text are retained as evidence. The user supplies a Bot before advancing them. */
export class TaskLeadPromotion extends Feature {
  request(sessionId: Id, _summary: unknown, _topicTitle?: unknown): never {
    const source = this.requireSession(sessionId);
    if (source.kind !== "main" || source.parentId || !source.taskId) throw new HostError("bad_request", "请打开要交接的任务，再选择机器人带队。");
    if (isPlaneBotWorker(this.store, source.taskId)) throw new HostError("conflict", "Plane Bot 执行任务由用户直接验收，不能设为主控。");
    appointmentRequired(source.taskId);
  }

  status(taskId: Id): LegacyPromotion | null {
    return this.records()[taskId] ?? null;
  }

  completeLegacyBinding(taskId: Id): void {
    const records = this.records();
    const previous = records[taskId];
    if (previous && previous.state !== "done") this.store.setKv(KEY, JSON.stringify({ ...records, [taskId]: { ...previous, state: "done" } }));
  }

  records(): Record<Id, LegacyPromotion> {
    return JSON.parse(this.store.getKv(KEY)?.value ?? "{}") as Record<Id, LegacyPromotion>;
  }
}
