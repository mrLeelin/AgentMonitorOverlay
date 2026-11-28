import type { HostService } from "../../service.js";
import { obj, route, type Route } from "../../http/route.js";
import { importOrcaBot } from "./import-link.js";

export function botsRoutes(host: HostService): Route[] {
  return [
    route("GET /api/bot-skills/shared", () => host.bots.sharedSkills()),
    route("PUT /api/bot-skills/shared", ({ body }) => host.bots.saveSharedSkills(obj(body).skills)),
    route("POST /api/bot-skills/catalog", ({ body }) => host.bots.skillCatalog(obj(body))),
    route("POST /api/bot-mentions", ({ body }) => host.bots.mentionMany(obj(body))),
    route("POST /api/bots/:id/mentions", ({ params, body }) => host.bots.mention(params.id!, obj(body))),
    route("GET /api/bots", () => host.bots.list()),
    route("GET /api/bots/sidebar", ({ query }) => host.bots.sidebar(query.get("botId") ?? undefined)),
    route("POST /api/bots/import-link", ({ body }) => importOrcaBot(obj(body).url)),
    route("POST /api/bots", ({ body }) => host.bots.save(obj(body))),
    route("PUT /api/bots/:id", ({ params, body }) => host.bots.save(obj(body), params.id!)),
    route("PATCH /api/bots/:id", ({ params, body }) => host.bots.patch(params.id!, obj(body))),
    route("DELETE /api/bots/:id", ({ params }) => host.bots.remove(params.id!)),
    route("GET /api/bots/:id/chats", ({ params }) => host.bots.chats(params.id!)),
    route("GET /api/bots/:id/files", ({ params }) => host.bots.files(params.id!)),
    route("GET /api/bots/:id/notes/:name", ({ params }) => host.bots.note(params.id!, params.name!)),
    route("PUT /api/bots/:id/notes/:name", ({ params, body }) => host.bots.saveNote(params.id!, params.name!, obj(body))),
    route("POST /api/bots/:id/home", ({ params, body }) => host.bots.home(params.id!, obj(body).reset === true)),
    route("POST /api/bots/:id/chat", ({ params, body }) => host.bots.newChat(params.id!, obj(body))),
    route("POST /api/bots/:id/requests", ({ params, body }) => host.bots.request(params.id!, obj(body))),
    route("GET /api/bot-requests", ({ query }) => host.bots.requests(query.get("sourceSessionId"))),
    route("POST /api/bot-requests/:id/worker", ({ params, body }) => host.bots.worker(params.id!, undefined, obj(body).operationId)),
    route("GET /api/bot-groups", () => host.bots.groups()),
    route("POST /api/bot-groups", ({ body }) => host.bots.saveGroup(obj(body))),
    route("PUT /api/bot-groups/:id", ({ params, body }) => host.bots.saveGroup(obj(body), params.id!)),
    route("PATCH /api/bot-groups/:id", ({ params, body }) => host.bots.patchGroup(params.id!, obj(body))),
    route("DELETE /api/bot-groups/:id", ({ params }) => host.bots.removeGroup(params.id!)),
    route("GET /api/bot-groups/:id/posts", ({ params }) => host.bots.posts(params.id!)),
    route("POST /api/bot-groups/:id/posts", ({ params, body }) => host.bots.post(params.id!, obj(body))),
    route("POST /api/bot-groups/:id/posts/:postId/replies/:botId/stop", ({ params }) => host.bots.stopGroupReply(params.id!, params.postId!, params.botId!)),
    route("GET /api/bots/:id/webhooks", ({ params }) => host.bots.listWebhooks(params.id!)),
    route("POST /api/bots/:id/webhooks", ({ params, body }) => host.bots.addWebhook(params.id!, obj(body).allowResult === true)),
    route("DELETE /api/bots/:id/webhooks/:hookId", ({ params }) => host.bots.removeWebhook(params.id!, params.hookId!)),
  ];
}
