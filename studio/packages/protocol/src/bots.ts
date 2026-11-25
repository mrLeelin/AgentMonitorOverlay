import type { Id, Session, Task, Timestamp } from "./entities.js";

export interface BotInput {
  name: string;
  /** A compact square PNG data URL. Null selects the default avatar. */
  avatar?: string | null;
  purpose: string;
  memory: string;
  profileId: Id;
  workspaceId: Id | null;
  enabled: boolean;
}

export interface StudioBot extends BotInput {
  id: Id;
  taskId: Id | null;
  homeSessionId: Id | null;
}

export type BotDestination = "home" | "new" | { sessionId: Id };

export interface BotRequest {
  id: Id;
  botId: Id;
  botName: string;
  sourceSessionId: Id | null;
  destination: BotDestination;
  sessionId: Id | null;
  taskId?: Id;
  text: string;
  createdAt: Timestamp;
  status: "queued" | "running" | "waiting" | "completed" | "stopped" | "failed";
  result?: string;
}

export interface BotRouteInput {
  id: Id;
  sourceSessionId?: Id;
  destination?: BotDestination;
  text: string;
}

export interface BotGroup {
  id: Id;
  name: string;
  memberIds: Id[];
}

export interface BotGroupPost {
  id: Id;
  text: string;
  targetIds: Id[];
  createdAt: Timestamp;
  replies: BotRequest[];
}

export interface BotWebhook {
  id: Id;
  botId: Id;
  url: string;
  allowResult: boolean;
}

export interface BotWebhookEvent {
  hookId: Id;
  eventId: Id;
  botId: Id;
  text: string;
  status: BotRequest["status"];
  result?: string;
}

export interface BotRoutes {
  "GET /api/bots": { req: void; res: StudioBot[] };
  "POST /api/bots": { req: BotInput; res: StudioBot };
  "PUT /api/bots/:id": { req: BotInput; res: StudioBot };
  "GET /api/bots/:id/chats": { req: void; res: Session[] };
  "POST /api/bots/:id/home": { req: { reset?: boolean }; res: Session };
  "POST /api/bots/:id/requests": { req: BotRouteInput; res: BotRequest };
  "GET /api/bot-requests": { req: void; res: BotRequest[] };
  "GET /api/bot-groups": { req: void; res: BotGroup[] };
  "POST /api/bot-groups": { req: Omit<BotGroup, "id">; res: BotGroup };
  "PUT /api/bot-groups/:id": { req: Omit<BotGroup, "id">; res: BotGroup };
  "GET /api/bot-groups/:id/posts": { req: void; res: BotGroupPost[] };
  "POST /api/bot-groups/:id/posts": { req: Pick<BotGroupPost, "id" | "text" | "targetIds">; res: BotGroupPost };
  "GET /api/bots/:id/webhooks": { req: void; res: BotWebhook[] };
  "POST /api/bots/:id/webhooks": { req: { allowResult?: boolean }; res: BotWebhook & { token: string } };
  "DELETE /api/bots/:id/webhooks/:hookId": { req: void; res: { ok: true } };
  "POST /api/bot-requests/:id/worker": { req: void; res: { task: Task; session: Session | null } };
}
