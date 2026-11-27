import { TEAM_TASK_BODY_LIMIT, type PlaneBotDecision, type PlaneBotIntake, type PlanePersonalDraft, type PlaneTaskDraft, type PlaneWorkItemChange, type TeamBoardChange, type TeamTaskChange } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { bytes, obj, route, type Route } from "../../http/route.js";
import type { HostService } from "../../service.js";

export function teamTasksRoutes(service: HostService): Route[] {
  const board = service.teamTasks.board;
  const bots = service.teamTasks.planeBots;
  return [
    route("GET /api/team-board", () => board.snapshot()),
    route("GET /api/team-board/plane", () => board.connection()),
    route("POST /api/team-board/plane/connect", ({ body }) => {
      const input = body as { server?: unknown; token?: unknown } | undefined;
      return board.connect(input?.server, input?.token);
    }),
    route("POST /api/team-board/plane/select", ({ body }) => {
      const input = body as { workspace?: unknown; project?: unknown } | undefined;
      return board.select(input?.workspace, input?.project);
    }),
    route("POST /api/team-board/plane/disconnect", () => {
      const connection = board.disconnect();
      if (!service.teamTasksEnabled()) service.publish({ type: "settings.updated", settings: service.config.settings() });
      return connection;
    }),
    route("GET /api/team-board/plane/draft", () => board.draft()),
    route("GET /api/team-board/plane/work-items", () => board.projectBoard()),
    route("POST /api/team-board/plane/resolve-item", ({ body }) => board.resolveWorkItem((body as { url?: unknown } | undefined)?.url)),
    route("GET /api/team-board/plane/work-items/:id", ({ params }) => board.workItem(params.id)),
    route("POST /api/team-board/plane/work-items/:id", ({ params, body }) => board.changeWorkItem(params.id, body as PlaneWorkItemChange)),
    route("GET /api/team-board/plane/work-items/:id/bot", ({ params }) => bots.forItem(params.id)),
    route("POST /api/team-board/plane/work-items/:id/bot", ({ params, body }) => bots.intake(params.id, body as PlaneBotIntake)),
    route("POST /api/team-board/plane/work-items/:id/bot/approve", ({ params, body }) => bots.approve(params.id, body as PlaneBotDecision)),
    route("POST /api/team-board/plane/work-items/:id/bot/decline", ({ params, body }) => bots.decline(params.id, body as PlaneBotDecision)),
    route("GET /api/team-board/plane/bots/:id/jobs", ({ params }) => bots.forBot(params.id)),
    route("GET /api/team-board/local/:id/bot", ({ params }) => bots.forTask(params.id)),
    route("POST /api/team-board/local/:id/bot/retry", ({ params }) => bots.retry(params.id)),
    route("POST /api/team-board/local/:id/bot/check", ({ params, body }) => bots.check(params.id, obj(body).resultId)),
    route("POST /api/team-board/plane/work-items/:id/copy", ({ params, body }) => {
      const input = body as { source?: unknown; workspaceId?: unknown; viewerId?: unknown; topicId?: unknown; requestId?: unknown; draft?: PlanePersonalDraft } | undefined;
      if (typeof input?.source !== "string" || (input.workspaceId !== null && (typeof input.workspaceId !== "string" || !input.workspaceId)) ||
          typeof input.viewerId !== "string" || (input.topicId !== undefined && typeof input.topicId !== "string") ||
          (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId))) ||
          (input.draft !== undefined && (!input.draft || typeof input.draft !== "object" || Array.isArray(input.draft)))) {
        throw new HostError("bad_request", "请选择本地项目，再刷新团队工作项");
      }
      return board.copyWorkItem(params.id, input.source, input.workspaceId, input.viewerId, input.topicId, input.draft, input.requestId?.toLowerCase());
    }),
    route("PUT /api/team-board/plane/draft", ({ body }) => board.saveDraft((body ?? {}) as Partial<PlaneTaskDraft>)),
    route("POST /api/team-board/plane/publish", ({ body }) => board.publishDraft((body ?? {}) as Partial<PlaneTaskDraft>)),
    route("GET /api/team-board/:id", ({ params }) => board.detail(params.id)),
    route("GET /api/team-board/:id/file/:fileId", ({ params }) => board.file(params.id, params.fileId)),
    route("POST /api/team-board/:id/read", ({ params }) => board.read(params.id)),
    route("POST /api/team-board/:id/change", ({ params, body }) => board.change(params.id, readAction<TeamBoardChange>(body)), { rawBody: TEAM_TASK_BODY_LIMIT }),
    route("GET /api/team-board/local/:id", ({ params }) => board.local(params.id)),
    route("GET /api/team-board/local/:id/file/:fileId", ({ params }) => board.fileLocal(params.id, params.fileId)),
    route("POST /api/team-board/local/:id/change", ({ params, body }) => board.changeLocal(params.id, readAction<TeamBoardChange>(body)), { rawBody: TEAM_TASK_BODY_LIMIT }),
    route("GET /api/team-board/local/:id/reference", ({ params }) => board.reference(params.id)),
    route("DELETE /api/team-board/local/:id/reference", ({ params }) => board.detach(params.id)),
    route("POST /api/team-board/local/:id/link", ({ params, body }) => board.attach(params.id, (body as { url?: unknown } | undefined)?.url)),
    route("POST /api/team-board/:id/import", ({ params, body }) => {
      const input = body as { workspaceId?: unknown; topicId?: unknown; revision?: unknown; source?: unknown } | undefined;
      if (typeof input?.workspaceId !== "string" || (input.topicId !== undefined && typeof input.topicId !== "string") || typeof input.revision !== "number" || !Number.isInteger(input.revision)) throw new HostError("bad_request", "请选择本地项目，再刷新原单接入");
      if (input.source !== undefined && typeof input.source !== "string") throw new HostError("bad_request", "请刷新团队看板后重试");
      return board.import(params.id, input.workspaceId, input.revision, input.topicId, input.source);
    }),
    route("GET /api/team-tasks", () => service.teamTasks.list()),
    route("GET /api/team-tasks/:id", ({ params }) => service.teamTasks.detail(params.id)),
    route("GET /api/team-tasks/:id/file/:fileId", ({ params }) => service.teamTasks.download(params.id, params.fileId)),
    route("POST /api/team-tasks/:id/import", ({ params, body }) => {
      const input = body as { workspaceId?: unknown; topicId?: unknown } | undefined;
      if (typeof input?.workspaceId !== "string" || (input.topicId !== undefined && typeof input.topicId !== "string")) throw new HostError("bad_request", "请选择本地项目");
      return service.teamTasks.import(params.id, input.workspaceId, input.topicId);
    }),
    route("GET /api/team-tasks/local/:id", ({ params }) => service.teamTasks.local(params.id)),
    route("POST /api/team-tasks/local/:id/change", ({ params, body }) => service.teamTasks.change(params.id, readAction<TeamTaskChange>(body)), { rawBody: TEAM_TASK_BODY_LIMIT }),
  ].map((entry) => ({ ...entry, handle: (context) => {
    service.requireTeamTasks();
    return entry.handle(context);
  } }));
}

function readAction<T>(body: unknown): T {
  try {
    const input = JSON.parse(bytes(body).toString("utf8")) as T;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input;
  } catch { throw new HostError("bad_request", "任务动作格式不正确"); }
}
