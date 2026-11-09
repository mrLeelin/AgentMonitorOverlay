import type { HostService } from "../../service.js";
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
    route("POST /api/tasks/:id/workflow/submit", ({ params, body }) => { const input = obj(body); return service.orchestration.submit(own(params.id!, input), input.summary, input.verification); }),
    route("POST /api/tasks/:id/workflow/review", ({ params, body }) => { const input = obj(body); if (typeof input.accept !== "boolean") throw new HostError("bad_request", "accept 必须是布尔值。"); return service.orchestration.review(own(params.id!, input), String(input.resultId ?? ""), input.accept, input.review); }),
  ];
}
