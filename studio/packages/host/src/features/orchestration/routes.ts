import type { HostService } from "../../service.js";
import type { TaskResult } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { route, obj, type Route } from "../../http/route.js";

export function orchestrationRoutes(service: HostService): Route[] {
  const own = (taskId: string, input: Record<string, unknown>) => {
    const sessionId = String(input.sessionId ?? "");
    if (service.store.getSession(sessionId)?.taskId !== taskId) throw new HostError("bad_request", "会话不属于这个任务。");
    return sessionId;
  };
  return [
    route("GET /api/tasks/:id/workflow", ({ params }) => service.orchestration.workflow(params.id!)),
    route("GET /api/tasks/:id/workflow/summary", ({ params, query }) => service.orchestration.workflowSummaryPage(params.id!, { parentTaskId: query.get("parentTaskId") ?? undefined, cursor: query.get("cursor") ?? undefined, limit: optionalInteger(query, "limit") }, {
      waitingFor: (id) => service.taskPlans.waitingFor(id).map((task) => task.id),
      waitingForWorktree: (id) => service.taskPlans.worktreeIntegrations(id).waiting,
    })),
    route("GET /api/tasks/:id/workflow/results/:resultId", ({ params, query }) => service.orchestration.readResult(params.id!, params.resultId!, optionalInteger(query, "offset"))),
    route("POST /api/tasks/:id/workflow/user-review", ({ params, body }) => { const input = obj(body); if (typeof input.accept !== "boolean") throw new HostError("bad_request", "accept 必须是布尔值。"); if (input.contextExplanation !== undefined && typeof input.contextExplanation !== "string") throw new HostError("bad_request", "contextExplanation 必须是文字。"); return service.orchestration.reviewByUser(params.id!, String(input.resultId ?? ""), input.accept, input.review, input.contextExplanation as string | undefined); }),
    route("POST /api/tasks/:id/workflow/retry-notice", async ({ params, body }) => { await service.orchestration.retry(params.id!, String(obj(body).noticeId ?? "")); return { ok: true }; }),
    route("POST /api/tasks/:id/workflow/submit", ({ params, body }) => { const input = obj(body); return service.orchestration.submit(own(params.id!, input), input.summary, input.verification, input as Pick<TaskResult, "contextBasis" | "prerequisiteResultIds" | "worktrees">); }),
    route("POST /api/tasks/:id/workflow/review", ({ params, body }) => { const input = obj(body); if (typeof input.accept !== "boolean") throw new HostError("bad_request", "accept 必须是布尔值。"); if (input.contextExplanation !== undefined && typeof input.contextExplanation !== "string") throw new HostError("bad_request", "contextExplanation 必须是文字。"); return service.orchestration.review(own(params.id!, input), String(input.resultId ?? ""), input.accept, input.review, input.contextExplanation as string | undefined); }),
  ];
}

function optionalInteger(query: URLSearchParams, key: string): number | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HostError("bad_request", `${key} 必须是非负整数。`);
  return Number(value);
}
