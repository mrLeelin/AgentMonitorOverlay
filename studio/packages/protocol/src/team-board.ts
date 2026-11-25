import type { Session, Task } from "./entities.js";
import type { NewTaskInput } from "./api.js";
import type { TeamTaskFile, TeamTaskFileInput, TeamTaskIdentity, TeamTaskStatus } from "./team-tasks.js";

export const TEAM_BOARD_PORT = 47121;
export type TeamBoardAction = "deliver" | "accept" | "return" | "withdraw" | "note";
export type TeamBoardEvent = { id: number | string; actor: string; actorId?: string | null; action: TeamBoardAction | "create" | "claim" | "release"; text: string; at: number; files: TeamTaskFile[] };
export type TeamBoardSummary = { id: string; title: string; creator: string; creatorId?: string | null; assignee: string | null; assigneeId?: string | null; status: TeamTaskStatus; revision: number; updatedAt: number };
export type TeamBoardTicket = TeamBoardSummary & { description: string; events: TeamBoardEvent[]; webUrl?: string; intakeTodo?: boolean };
export type TeamBoardNotice = { ticketId: string; title: string; actor: string; at: number; unread: boolean };
export type TeamBoardSnapshot = { name: string | null; viewerId?: string; source?: string; writable?: boolean; intake?: "todo"; tickets: Array<TeamBoardSummary & { localTaskId?: string }>; notices: TeamBoardNotice[]; unclaimProject?: string; linkedTaskIds?: string[] };
export type NewTeamBoardTicket = { requestId: string; title: string; description: string; assignee?: string | null; files?: TeamTaskFileInput[] };
export type TeamBoardChange = { action: TeamBoardAction; revision: number; source?: string; text?: string; files?: TeamTaskFileInput[] };
export type TeamBoardClaim = { ticket: TeamBoardTicket; claimId: string | null };

export type PlaneBoardIdentity = { id: string; name: string };
export type PlaneTaskReference = { url: string; number?: string; title?: string; creator?: string; creatorAvatarUrl?: string | null };
export type PlanePersonalDraft = Pick<NewTaskInput, "title" | "lead" | "firstMessage" | "firstSession" | "worktree">;
export type PlanePersonalTask = { task: Task; session: Session | null; existing: boolean; assignee: string };
export type PlaneBoardProject = { id: string; name: string; writable: boolean; missing: string[] };
export type PlaneBoardWorkspace = { slug: string; name: string; projects: PlaneBoardProject[] };
export type PlaneBoardCatalog = { identity: PlaneBoardIdentity; workspaces: PlaneBoardWorkspace[] };
export type PlaneBoardSelection = { workspace: string; project: string };
export type PlaneBoardConnection = {
  available: boolean;
  legacy: boolean;
  server: string | null;
  selected: PlaneBoardSelection | null;
  catalog: PlaneBoardCatalog | null;
  error?: string;
};
export type TeamBoardUnclaim = { revision: number; reason: string };
export type PlaneTaskDraft = { title: string; description: string; stateId?: string; publishing?: { requestId: string; source: string; viewerId: string } };
export type PlanePriority = "urgent" | "high" | "medium" | "low" | "none";
export type PlaneState = { id: string; name: string; color: string; group: string; default: boolean };
export type PlaneLabel = { id: string; name: string; color: string };
export type PlaneWorkItem = {
  id: string; number: string; title: string; stateId: string | null; priority: PlanePriority;
  assigneeIds: string[]; labelIds: string[]; startDate: string | null; dueDate: string | null; revision: number; archived: boolean;
};
export type PlaneWorkItemDetail = PlaneWorkItem & {
  description: string; creator: string; creatorAvatarUrl?: string | null; url: string;
  canDelete: boolean; files: TeamTaskFile[];
  comments: Array<{ id: string; author: string; at: number; text: string; canEdit: boolean; canDelete: boolean; files: TeamTaskFile[] }>;
};
export const PLANE_CONTEXT_SECTIONS = ["children", "relations", "comments", "activity", "files", "links", "description", "comment"] as const;
export type PlaneContextSection = typeof PLANE_CONTEXT_SECTIONS[number];
export type PlaneContextQuery = { section?: PlaneContextSection; offset?: number; commentId?: string };
export type PlaneContextItem = { id: string; url: string; number: string; title: string; state: string | null; assignees: string[] };
export type PlaneItemContext = {
  viewerId: string;
  readAt: number;
  item: PlaneContextItem;
  [section: string]: unknown;
};
export type PlaneProjectBoard = {
  name: string; viewerId: string; source: string; writable: boolean;
  states: PlaneState[]; members: PlaneBoardIdentity[]; labels: PlaneLabel[]; items: PlaneWorkItem[];
};
export type PlaneWorkItemEdit = { title?: string; description?: string; stateId?: string; priority?: PlanePriority; assigneeIds?: string[]; labelIds?: string[]; startDate?: string | null; dueDate?: string | null; beforeId?: string | null };
export type PlaneWorkItemChange = { source: string; revision: number } & (
  { action: "edit"; fields: PlaneWorkItemEdit } |
  { action: "archive" | "restore" | "delete" } |
  { action: "comment"; text: string; commentId?: string } |
  { action: "delete-comment"; commentId: string }
);
export type LinkedTeamBoardTicket = { ticket: TeamBoardTicket; name: string; viewerId?: string; writable?: boolean };
export const PLANE_BOARD_API = "/api/v1/amo-team-board";
export const PLANE_WORK_ITEM_DRAG = "application/x-amo-plane-work-item";

export class TeamBoardError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The standalone service uses the same operations from the browser and the Studio Host. */
export class TeamBoardClient {
  constructor(readonly base = "", readonly key?: string, private readonly prefix = "/api/board", private readonly plane = false) {}

  get source(): string { return this.plane ? this.base + this.prefix : this.base; }

  private headers(): Record<string, string> {
    if (!this.key) return {};
    return this.plane ? { "x-api-key": this.key } : { authorization: `Bearer ${this.key}` };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${this.prefix}${path}`, {
      method, redirect: "error", headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => null) as (T & { message?: string }) | null;
    if (!response.ok || value === null) throw new TeamBoardError(response.status, (typeof value?.message === "string" ? value.message : this.plane && [401, 403].includes(response.status) ? "Plane 授权无效或没有访问权限" : "团队看板服务返回了无效响应"));
    return value;
  }

  login(name: string, password: string): Promise<{ name: string }> { return this.call("POST", "/login", { name, password }); }
  logout(): Promise<{ ok: true }> { return this.call("POST", "/logout", {}); }
  identity(): Promise<TeamTaskIdentity> { return this.call("GET", "/identity"); }
  catalog(): Promise<PlaneBoardCatalog> { return this.call("GET", "/catalog/"); }
  resolve(workspace: string, identifier: string, number: number): Promise<{ project: string; ticketId: string }> {
    return this.call("GET", `/workspaces/${encodeURIComponent(workspace)}/resolve/${encodeURIComponent(identifier)}/${number}`);
  }
  snapshot(): Promise<TeamBoardSnapshot> { return this.call("GET", ""); }
  statuses(ids: string[]): Promise<{ viewerId: string; tickets: Array<{ id: string; status: TeamTaskStatus; intakeTodo: boolean; assigneeId: string | null }> }> {
    return this.call("POST", "/statuses", { ids });
  }
  detail(id: string): Promise<TeamBoardTicket> { return this.call("GET", `/tickets/${encodeURIComponent(id)}`); }
  projectBoard(): Promise<Omit<PlaneProjectBoard, "source">> { return this.call("GET", "/work-items"); }
  workItem(id: string): Promise<PlaneWorkItemDetail> { return this.call("GET", `/work-items/${encodeURIComponent(id)}`); }
  workItemContext(id: string, query: PlaneContextQuery): Promise<PlaneItemContext> {
    const params = new URLSearchParams();
    if (query.section) params.set("section", query.section);
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    if (query.commentId) params.set("commentId", query.commentId);
    return this.call("GET", `/work-items/${encodeURIComponent(id)}/context?${params}`);
  }
  async contextFile(id: string, fileId: string): Promise<{ viewerId: string | null; name: string; bytes: ArrayBuffer }> {
    const response = await fetch(`${this.base}${this.prefix}/work-items/${encodeURIComponent(id)}/context/files/${encodeURIComponent(fileId)}`, {
      headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      throw new TeamBoardError(response.status, body?.message ?? "无法读取 Plane 附件");
    }
    return { viewerId: response.headers.get("x-plane-viewer"), name: decodeURIComponent(response.headers.get("x-plane-filename") ?? "file"), bytes: await response.arrayBuffer() };
  }
  createWorkItem(input: NewTeamBoardTicket & { stateId?: string }): Promise<PlaneWorkItem> { return this.call("POST", "/work-items", input); }
  changeWorkItem(id: string, input: PlaneWorkItemChange): Promise<{ item: PlaneWorkItemDetail | null }> {
    return this.call("POST", `/work-items/${encodeURIComponent(id)}`, input);
  }
  create(input: NewTeamBoardTicket): Promise<TeamBoardTicket> { return this.call("POST", "/tickets", input); }
  change(id: string, input: TeamBoardChange): Promise<TeamBoardTicket> { return this.call("POST", `/tickets/${encodeURIComponent(id)}/change`, input); }
  unclaim(id: string, input: TeamBoardUnclaim): Promise<TeamBoardTicket> { return this.call("POST", `/tickets/${encodeURIComponent(id)}/change`, { action: "unclaim", revision: input.revision, text: input.reason }); }
  claim(id: string, revision: number): Promise<TeamBoardClaim> { return this.call("POST", `/tickets/${encodeURIComponent(id)}/claim`, { revision }); }
  release(id: string, claimId: string): Promise<{ ok: true }> { return this.call("POST", `/tickets/${encodeURIComponent(id)}/release`, { claimId }); }
  readNotice(id: string): Promise<{ ok: true }> { return this.call("POST", `/notices/${encodeURIComponent(id)}/read`, {}); }
  fileUrl(id: string, fileId: string): string { return `${this.base}${this.prefix}/tickets/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`; }
  async file(id: string, fileId: string): Promise<ArrayBuffer> {
    const response = await fetch(this.fileUrl(id, fileId), { headers: this.headers(), redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new TeamBoardError(response.status, "无法下载团队任务附件");
    return response.arrayBuffer();
  }
}

export interface TeamBoardHostRoutes {
  "GET /api/team-board": { req: void; res: TeamBoardSnapshot };
  "GET /api/team-board/plane": { req: void; res: PlaneBoardConnection };
  "POST /api/team-board/plane/connect": { req: { server: string; token: string }; res: PlaneBoardConnection };
  "POST /api/team-board/plane/select": { req: PlaneBoardSelection; res: PlaneBoardConnection };
  "POST /api/team-board/plane/disconnect": { req: void; res: PlaneBoardConnection };
  "GET /api/team-board/plane/draft": { req: void; res: PlaneTaskDraft | null };
  "PUT /api/team-board/plane/draft": { req: Omit<PlaneTaskDraft, "publishing">; res: PlaneTaskDraft };
  "POST /api/team-board/plane/publish": { req: Omit<PlaneTaskDraft, "publishing">; res: Pick<PlaneWorkItem, "id" | "title"> };
  "GET /api/team-board/plane/work-items": { req: void; res: PlaneProjectBoard };
  "POST /api/team-board/plane/resolve-item": { req: { url: string }; res: { id: string; source: string; number: string; title: string } };
  "GET /api/team-board/plane/work-items/:id": { req: void; res: PlaneWorkItemDetail };
  "POST /api/team-board/plane/work-items/:id": { req: PlaneWorkItemChange; res: { item: PlaneWorkItemDetail | null } };
  "POST /api/team-board/plane/work-items/:id/copy": { req: { source: string; workspaceId: string | null; viewerId: string; topicId?: string; draft?: PlanePersonalDraft; requestId?: string }; res: PlanePersonalTask };
  "GET /api/team-board/:id": { req: void; res: TeamBoardTicket };
  "GET /api/team-board/:id/file/:fileId": { req: void; res: { base64: string } };
  "POST /api/team-board/:id/change": { req: TeamBoardChange; res: TeamBoardTicket };
  "POST /api/team-board/:id/read": { req: void; res: { ok: true } };
  "POST /api/team-board/:id/import": { req: { workspaceId: string; topicId?: string; revision: number; source?: string }; res: { task: Task; ticket: TeamBoardTicket; existing: boolean } };
  "GET /api/team-board/local/:id": { req: void; res: LinkedTeamBoardTicket | null };
  "GET /api/team-board/local/:id/file/:fileId": { req: void; res: { base64: string } };
  "POST /api/team-board/local/:id/change": { req: TeamBoardChange; res: TeamBoardTicket };
  "POST /api/team-board/local/:id/link": { req: { url: string }; res: { url: string } };
  "GET /api/team-board/local/:id/reference": { req: void; res: PlaneTaskReference | null };
  "DELETE /api/team-board/local/:id/reference": { req: void; res: { ok: true } };
}
