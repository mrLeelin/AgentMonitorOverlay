import type { HostService } from "../../service.js";
import { route, type Route, obj } from "../../http/route.js";

/** The HTTP routes of this feature (see protocol/src/api.ts for each route's request and response). */
export function gitReviewRoutes(service: HostService): Route[] {
  return [
    route("GET /api/workspaces/:id/git/status", ({ params, query }) => service.gitReview.status(params.id!, query.get("worktree"))),
    route("GET /api/workspaces/:id/git/changes", ({ params, query }) => service.gitReview.changes(params.id!, query.get("range"), query.get("base"), query.get("label"), query.get("worktree"))),
    route("GET /api/workspaces/:id/git/diff", ({ params, query }) =>
      service.gitReview.diff(params.id!, query.get("range"), query.get("path"), query.get("oldPath"), { base: query.get("base"), untracked: query.get("untracked") }, query.get("worktree")),
    ),
    route("GET /api/workspaces/:id/git/log", ({ params, query }) => service.gitReview.log(params.id!, query.get("limit"), query.get("worktree"))),
    route("GET /api/workspaces/:id/git/commit", ({ params, query }) => service.gitReview.commit(params.id!, query.get("sha"), query.get("base"), query.get("worktree"))),
    route("POST /api/review/open", ({ body }) => service.gitReview.openReview(obj(body) as never)),
    route("GET /api/workspaces/:id/git/commit-diff", ({ params, query }) =>
      service.gitReview.commitDiff(params.id!, query.get("sha"), query.get("base"), query.get("path"), query.get("oldPath"), query.get("worktree")),
    ),
    route("GET /api/workspaces/:id/review-comments", ({ params, query }) => service.gitReview.comments(params.id!, query.get("worktree"))),
    route("POST /api/workspaces/:id/review-comments/copy", ({ params, query, body }) => service.gitReview.copy(params.id!, obj(body).ids, query.get("worktree"))),
    route("POST /api/workspaces/:id/review-comments/send", ({ params, body }) => service.gitReview.send(params.id!, obj(body).sessionId, obj(body).ids)),
    route("POST /api/workspaces/:id/review-comments", ({ params, query, body }) => service.gitReview.addComment(params.id!, obj(body) as never, query.get("worktree"))),
    route("PATCH /api/review-comments/:id", ({ params, body }) => service.gitReview.updateComment(params.id!, obj(body).note)),
    route("DELETE /api/review-comments/:id", ({ params }) => (service.gitReview.deleteComment(params.id!), { ok: true })),
  ];
}
