import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";
import { HostError } from "../../core/shared.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function maintenanceRoutes(service: HostService): Route[] {
  return [
    route("GET /api/maintenance", () => service.maintenance.info()),
    route("GET /api/maintenance/clis", () => service.maintenance.clis.list()),
    route("POST /api/maintenance/clis/check", () => service.maintenance.clis.check()),
    route("POST /api/maintenance/clis/update", ({ body }) => {
      const cli = obj(body).cli;
      if (cli !== "claude" && cli !== "codex" && cli !== "pi") throw new HostError("bad_request", "cli must be claude, codex or pi");
      return service.maintenance.clis.update(cli);
    }),
    route("POST /api/maintenance/terminal", ({ body }) => {
      const cli = obj(body).cli ?? "claude";
      if (cli !== "claude" && cli !== "codex") throw new HostError("bad_request", "cli must be claude or codex");
      return service.maintenance.openTerminal(cli);
    }),
  ];
}
