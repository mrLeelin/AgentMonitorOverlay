import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";

export function botsRoutes(host: HostService): Route[] {
  return [
    route("GET /api/bots", () => host.bots.list()),
    route("POST /api/bots", ({ body }) => host.bots.save(obj(body))),
    route("PUT /api/bots/:id", ({ params, body }) => host.bots.save(obj(body), params.id!)),
    route("GET /api/bots/:id/chats", ({ params }) => host.bots.chats(params.id!)),
    route("POST /api/bots/:id/home", ({ params, body }) => host.bots.home(params.id!, obj(body).reset === true)),
    route("POST /api/bots/:id/requests", ({ params, body }) => host.bots.request(params.id!, obj(body))),
    route("GET /api/bot-requests", ({ query }) => host.bots.requests(query.get("sourceSessionId"))),
    route("POST /api/bot-requests/:id/worker", ({ params }) => host.bots.worker(params.id!)),
    route("GET /api/bot-groups", () => host.bots.groups()),
    route("POST /api/bot-groups", ({ body }) => host.bots.saveGroup(obj(body))),
    route("PUT /api/bot-groups/:id", ({ params, body }) => host.bots.saveGroup(obj(body), params.id!)),
    route("GET /api/bot-groups/:id/posts", ({ params }) => host.bots.posts(params.id!)),
    route("POST /api/bot-groups/:id/posts", ({ params, body }) => host.bots.post(params.id!, obj(body))),
    route("GET /api/bots/:id/webhooks", ({ params }) => host.bots.listWebhooks(params.id!)),
    route("POST /api/bots/:id/webhooks", ({ params, body }) => host.bots.addWebhook(params.id!, obj(body).allowResult === true)),
    route("DELETE /api/bots/:id/webhooks/:hookId", ({ params }) => host.bots.removeWebhook(params.id!, params.hookId!)),
  ];
}
