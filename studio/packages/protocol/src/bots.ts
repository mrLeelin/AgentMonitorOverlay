import type { Id, Session, Task, Timestamp } from "./entities.js";
import type { BotLeadOperationReceipt } from "./bot-leads.js";

export interface BotInput {
  name: string;
  /** A compact square PNG data URL or `mascot:<id>`. Null selects the default avatar. */
  avatar?: string | null;
  purpose: string;
  memory: string;
  profileId: Id;
  model?: string | null;
  effort?: string | null;
  fast?: boolean | null;
  /** A permission id from this profile. Older records and null use the Bot's read-only default. */
  permission?: string | null;
  workspaceId: Id | null;
  enabled: boolean;
  /** Saved assignments for chats created from this Bot. */
  skills?: BotSkillRef[];
  preferences?: BotPreferences;
}

export interface BotPreferences {
  allowGroupAsk: boolean;
  inactiveDays: 5 | 7 | 14;
  notifications: { approval: boolean; completed: boolean; failed: boolean };
}

export const DEFAULT_BOT_PREFERENCES: BotPreferences = {
  allowGroupAsk: true, inactiveDays: 5, notifications: { approval: false, completed: false, failed: false },
};

export interface BotFiles { folder: string; notes: string[] }

export const BOT_SKILL_LIMIT = 40;
export type BotSkillSource = "global" | "project" | "plugin";

export interface BotSkillRef {
  id: string;
  name: string;
  source: BotSkillSource;
  label: string;
}

export interface BotSkillChoice extends BotSkillRef {
  description: string;
  path: string;
  unavailable?: string;
}

export interface BotSkillCatalog {
  skills: BotSkillChoice[];
  note?: string;
}

/** Orca v1.4.274's mascots, stored as `mascot:<id>` like Orca does; ids are never renamed. */
export const BOT_MASCOT_IDS = ["A1", "B1", "D1", "E1", "F1", "G1", "H1", "H2", "I1", "J1", "K2", "L2", "M1", "N1", "O1", "P3", "Q1", "R3", "S2", "T1"] as const;
export type BotMascotId = typeof BOT_MASCOT_IDS[number];
/** Orca retired S2 from its picker; a Bot that already wears it keeps it. */
export const PICKABLE_BOT_MASCOT_IDS: readonly BotMascotId[] = BOT_MASCOT_IDS.filter((id) => id !== "S2");
export const botMascotAvatar = (id: BotMascotId): string => `mascot:${id}`;
export function botMascotId(avatar: string | null | undefined): BotMascotId | null {
  const id = avatar?.startsWith("mascot:") ? avatar.slice(7) : null;
  return BOT_MASCOT_IDS.find((known) => known === id) ?? null;
}

export const supportsBotRuntime = (runtime: string): boolean => ["codex", "claude", "dsh"].includes(runtime);
export const supportsBotMemory = (runtime: string | undefined): boolean => runtime === "codex" || runtime === "claude";
export const defaultBotPermission = (runtime: string): string => runtime === "claude" ? "plan" : "read-only";

export interface StudioBot extends BotInput {
  id: Id;
  taskId: Id | null;
  homeSessionId: Id | null;
}

export type BotDraftContent = Pick<BotInput, "name" | "purpose" | "memory" | "avatar">;

export interface BotSidebarData {
  previews: Record<Id, string>;
  workers: { botId: Id; taskId: Id }[];
  /** Recent session snippets, when a single Bot is selected. */
  chatPreviews?: Record<Id, string>;
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
  /** First acceptance of the request. taskId/sessionId above continue to identify the Bot conversation. */
  acceptance?: BotLeadOperationReceipt;
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
  /** Absent for messages sent by the person, including older group history. */
  author?: { botId: Id; botName: string };
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
  "GET /api/bot-skills/shared": { req: void; res: BotSkillRef[] };
  "PUT /api/bot-skills/shared": { req: { skills: BotSkillRef[] }; res: BotSkillRef[] };
  "POST /api/bot-skills/catalog": { req: { profileId?: Id; workspaceId?: Id | null }; res: BotSkillCatalog };
  "POST /api/bot-mentions": { req: { id: Id; sourceSessionId: Id; text: string; recipients: BotRecipient[] }; res: { ok: true } };
  "POST /api/bots/:id/mentions": { req: BotRouteInput & { sourceSessionId: Id }; res: { ok: true } };
  "GET /api/bots": { req: void; res: StudioBot[] };
  "GET /api/bots/sidebar": { req: void; res: BotSidebarData };
  "POST /api/bots/import-link": { req: { url: string }; res: BotDraftContent };
  "POST /api/bots": { req: BotInput; res: StudioBot };
  "PUT /api/bots/:id": {
    req: (BotInput & { expectedFiles?: Pick<BotInput, "purpose" | "memory"> })
      | { changes: Partial<BotInput>; expectedFiles: Partial<Pick<BotInput, "purpose" | "memory">> };
    res: StudioBot;
  };
  "PATCH /api/bots/:id": { req: Partial<Pick<BotInput, "name" | "enabled">>; res: StudioBot };
  "DELETE /api/bots/:id": { req: void; res: { ok: true } };
  "GET /api/bots/:id/chats": { req: void; res: Session[] };
  "GET /api/bots/:id/files": { req: void; res: BotFiles };
  "GET /api/bots/:id/notes/:name": { req: void; res: { text: string } };
  "PUT /api/bots/:id/notes/:name": { req: { text: string; expected: string | null }; res: BotFiles };
  "POST /api/bots/:id/home": { req: { reset?: boolean }; res: Session };
  "POST /api/bots/:id/chat": { req: Pick<BotRouteInput, "id" | "text">; res: Session };
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
  "POST /api/bot-requests/:id/worker": { req: void | { operationId: Id }; res: { task: Task; session: Session | null; receipt?: Extract<BotLeadOperationReceipt, { action: "worker" }> } };
}
