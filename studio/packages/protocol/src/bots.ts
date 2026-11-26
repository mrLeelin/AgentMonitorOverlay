import type { Id, Session, Task, Timestamp } from "./entities.js";

export interface BotInput {
  name: string;
  /** A compact square PNG data URL. Null selects the default avatar. */
  avatar?: string | null;
  purpose: string;
  memory: string;
  profileId: Id;
  model?: string | null;
  effort?: string | null;
  workspaceId: Id | null;
  enabled: boolean;
}

export const supportsBotRuntime = (runtime: string): boolean => ["codex", "claude", "dsh"].includes(runtime);

export interface StudioBot extends BotInput {
  id: Id;
  taskId: Id | null;
  homeSessionId: Id | null;
}

export type BotDraftContent = Pick<BotInput, "name" | "purpose" | "memory" | "avatar">;

export interface BotSidebarData {
  previews: Record<Id, string>;
  workers: { botId: Id; taskId: Id }[];
}

export type BotDestination = "home" | "new" | { sessionId: Id };
export interface BotRecipient { botId: Id; destination: BotDestination }

/** Display and routing metadata stored with the inbox item, independent of model-visible prose. */
export type BotLetter =
  | { kind: "mention"; botId: Id; destination: BotDestination; text: string; others?: BotRecipient[] }
  | { kind: "request" | "reply"; heading: string; text: string };

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
  settledAt?: Timestamp;
  status: "queued" | "running" | "waiting" | "completed" | "stopped" | "failed";
  result?: string;
  /** Only requests dispatched by the source agent return a message to that agent. */
  reportToSource?: boolean;
  reported?: boolean;
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
  dispatchComplete?: boolean;
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
  "POST /api/bot-mentions": { req: { id: Id; sourceSessionId: Id; text: string; recipients: BotRecipient[] }; res: { ok: true } };
  "POST /api/bots/:id/mentions": { req: BotRouteInput & { sourceSessionId: Id }; res: { ok: true } };
  "GET /api/bots": { req: void; res: StudioBot[] };
  "GET /api/bots/sidebar": { req: void; res: BotSidebarData };
  "POST /api/bots/import-link": { req: { url: string }; res: BotDraftContent };
  "POST /api/bots": { req: BotInput; res: StudioBot };
  "PUT /api/bots/:id": { req: BotInput; res: StudioBot };
  "PATCH /api/bots/:id": { req: Partial<Pick<BotInput, "name" | "enabled">>; res: StudioBot };
  "DELETE /api/bots/:id": { req: void; res: { ok: true } };
  "GET /api/bots/:id/chats": { req: void; res: Session[] };
  "POST /api/bots/:id/home": { req: { reset?: boolean }; res: Session };
  "POST /api/bots/:id/requests": { req: BotRouteInput; res: BotRequest };
  "GET /api/bot-requests": { req: void; res: BotRequest[] };
  "GET /api/bot-groups": { req: void; res: BotGroup[] };
  "POST /api/bot-groups": { req: Omit<BotGroup, "id">; res: BotGroup };
  "PUT /api/bot-groups/:id": { req: Omit<BotGroup, "id">; res: BotGroup };
  "PATCH /api/bot-groups/:id": { req: Partial<Omit<BotGroup, "id">>; res: BotGroup };
  "DELETE /api/bot-groups/:id": { req: void; res: { ok: true } };
  "GET /api/bot-groups/:id/posts": { req: void; res: BotGroupPost[] };
  "POST /api/bot-groups/:id/posts": { req: Pick<BotGroupPost, "id" | "text" | "targetIds">; res: BotGroupPost };
  "POST /api/bot-groups/:id/posts/:postId/replies/:botId/stop": { req: void; res: { ok: true } };
  "GET /api/bots/:id/webhooks": { req: void; res: BotWebhook[] };
  "POST /api/bots/:id/webhooks": { req: { allowResult?: boolean }; res: BotWebhook & { token: string } };
  "DELETE /api/bots/:id/webhooks/:hookId": { req: void; res: { ok: true } };
  "POST /api/bot-requests/:id/worker": { req: void; res: { task: Task; session: Session | null } };
}
