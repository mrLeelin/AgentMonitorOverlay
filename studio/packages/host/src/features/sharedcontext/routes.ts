import type { ContextApplyInput, ContextSaveInput } from "@amo-studio/protocol";
import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

export function sharedContextRoutes(service: HostService): Route[] {
  return [
    route("GET /api/tasks/:id/context", ({ params }) => service.sharedContext.get(params.id)),
    route("POST /api/shared-context/save", ({ body }) => { const input = obj(body); return service.sharedContext.save(String(input.sessionId ?? ""), input as unknown as ContextSaveInput); }),
    route("POST /api/shared-context/publish", ({ body }) => { const input = obj(body); return service.sharedContext.publishVersion(String(input.sessionId ?? ""), String(input.contextId ?? ""), input.baseRevision as number); }),
    route("POST /api/shared-context/apply", ({ body }) => { const input = obj(body); return service.sharedContext.apply(String(input.sessionId ?? ""), input as unknown as ContextApplyInput); }),
    route("POST /api/shared-context/adopt", ({ body }) => { const input = obj(body); return service.sharedContext.adopt(String(input.sessionId ?? ""), { contextId: String(input.contextId ?? ""), version: input.version as number }); }),
  ];
}
