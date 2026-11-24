import { TEAM_TASK_BODY_LIMIT, type TeamTaskChange } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { bytes, route, type Route } from "../../http/route.js";
import type { HostService } from "../../service.js";

export function teamTasksRoutes(service: HostService): Route[] {
  return [
    route("GET /api/team-tasks", () => service.teamTasks.list()),
    route("GET /api/team-tasks/:id", ({ params }) => service.teamTasks.detail(params.id)),
    route("GET /api/team-tasks/:id/file/:fileId", ({ params }) => service.teamTasks.download(params.id, params.fileId)),
    route("POST /api/team-tasks/:id/import", ({ params, body }) => {
      const input = body as { workspaceId?: unknown; topicId?: unknown } | undefined;
      if (typeof input?.workspaceId !== "string" || (input.topicId !== undefined && typeof input.topicId !== "string")) throw new HostError("bad_request", "请选择本地项目");
      return service.teamTasks.import(params.id, input.workspaceId, input.topicId);
    }),
    route("GET /api/team-tasks/local/:id", ({ params }) => service.teamTasks.local(params.id)),
    route("POST /api/team-tasks/local/:id/change", ({ params, body }) => {
      let input: TeamTaskChange;
      try {
        input = JSON.parse(bytes(body).toString("utf8")) as TeamTaskChange;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      } catch {
        throw new HostError("bad_request", "任务动作格式不正确");
      }
      return service.teamTasks.change(params.id, input);
    }, { rawBody: TEAM_TASK_BODY_LIMIT }),
  ];
}
