import type { Task } from "./entities.js";

export const TEAM_TASK_FILE_LIMIT = 16 * 1024 * 1024;
export const TEAM_TASK_BODY_LIMIT = 24 * 1024 * 1024;
export const TEAM_TASK_FILE_COUNT = 6;

export type TeamTaskStatus = "pending" | "doing" | "review" | "done";
export type TeamTaskAction = "start" | "deliver" | "accept" | "return" | "note";
export type TeamTaskFileInput = { name: string; base64: string };
export type TeamTaskFile = { id: string; name: string; size: number };
export type TeamTaskEvent = { id: number; actor: string; action: "create" | TeamTaskAction; text: string; at: number; files: TeamTaskFile[] };

export interface TeamTaskSummary {
  id: string;
  title: string;
  project: string;
  creator: string;
  assignee: string;
  status: TeamTaskStatus;
  revision: number;
  updatedAt: number;
}

export interface TeamTask extends TeamTaskSummary {
  description: string;
  events: TeamTaskEvent[];
}

export interface NewTeamTask {
  requestId: string;
  title: string;
  /** Older clients may still send this. The Studio project is chosen at import. */
  project?: string;
  assignee: string;
  description: string;
  files: TeamTaskFileInput[];
}

export interface TeamTaskChange {
  revision: number;
  action: TeamTaskAction;
  text?: string;
  files?: TeamTaskFileInput[];
}

export type TeamTaskPerson = { name: string; nick: string };
export type TeamTaskIdentity = { name: string; members: TeamTaskPerson[] };

export interface TeamTasksDesktop {
  identity(): Promise<TeamTaskIdentity | null>;
  list(): Promise<TeamTaskSummary[]>;
  detail(id: string): Promise<TeamTask>;
  create(input: NewTeamTask): Promise<TeamTask>;
  change(id: string, input: TeamTaskChange): Promise<TeamTask>;
  saveAttachment(id: string, file: TeamTaskFile): Promise<boolean>;
}

export type TeamTaskInboxItem = TeamTaskSummary & { localTaskId: string | null };

export interface LinkedTeamTask {
  ticket: TeamTask;
  needsStartSync: boolean;
}

export interface TeamTaskRoutes {
  "GET /api/team-tasks": { req: void; res: { name: string | null; tickets: TeamTaskInboxItem[] } };
  "GET /api/team-tasks/:id": { req: void; res: TeamTask };
  "GET /api/team-tasks/:id/file/:fileId": { req: void; res: { base64: string } };
  "POST /api/team-tasks/:id/import": { req: { workspaceId: string; topicId?: string }; res: { task: Task; existing: boolean } };
  "GET /api/team-tasks/local/:id": { req: void; res: LinkedTeamTask | null };
  "POST /api/team-tasks/local/:id/change": { req: TeamTaskChange; res: LinkedTeamTask };
}
