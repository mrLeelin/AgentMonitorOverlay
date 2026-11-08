import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";
import { checkNetwork, testNetwork } from "../../runtime/network.js";
import { HostError } from "../../core/shared.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function configRoutes(service: HostService): Route[] {
  return [
    route("GET /api/settings", () => service.config.settings()),
    route("POST /api/settings/network/apply", () => service.config.applyNetwork()),
    route("POST /api/settings/network/test", ({ body }) => {
      let settings;
      try { settings = checkNetwork(body); } catch (err) { throw new HostError("bad_request", (err as Error).message); }
      return testNetwork(settings);
    }),
    route("GET /api/usage", ({ query }) => service.config.usage(query.get("refresh") === "1")),
    route("PUT /api/settings", ({ body }) => service.config.updateSettings(obj(body))),
    route("GET /api/profiles/:id/choices", ({ params }) => service.config.choices(params.id!)),
    route("GET /api/credentials", () => service.config.credentials()),
    route("PUT /api/credentials/:id", ({ params, body }) => service.config.saveCredential(params.id!, obj(body).secret)),
    route("DELETE /api/credentials/:id", ({ params }) => service.config.removeCredential(params.id!)),
  ];
}
