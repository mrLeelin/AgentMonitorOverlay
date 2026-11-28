import { route, type Route } from "../../http/route.js";
import type { HostService } from "../../service.js";

export function botLeadsRoutes(host: HostService): Route[] {
  return [
    route("GET /api/bot-leads/legacy-issues", () => host.botLeads.legacyIssues()),
    route("POST /api/bot-leads/appointments", ({ body }) => host.botLeads.appoint(body)),
    route("GET /api/bot-leads/operations/:id", ({ params }) => host.botLeads.operation(params.id)),
    route("GET /api/tasks/:id/bot-lead", ({ params }) => host.botLeads.taskView(params.id)),
    route("GET /api/tasks/:id/bot-lead/terms/:termId", ({ params }) => host.botLeads.term(params.id, params.termId)),
    route("POST /api/tasks/:id/bot-lead/control", ({ params, body }) => host.botLeads.control(params.id, body)),
    route("POST /api/tasks/:id/bot-lead/legacy-bindings", ({ params, body }) => host.botLeads.bindLegacy(params.id, body)),
  ];
}
