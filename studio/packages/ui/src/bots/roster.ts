import type { BotGroup, BotInput, ModelProfile, Session, StudioBot } from "@amo-studio/protocol";
import { supportsBotRuntime } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { sharedLive } from "../host/shared.js";

const NO_BOTS: readonly StudioBot[] = [];
const NO_GROUPS: readonly BotGroup[] = [];
const NO_LINK: HostLink = { url: "", token: "" };

const useBotList = sharedLive<StudioBot[]>((link) => ({
  load: () => call(link, "GET /api/bots"),
  reloadOn: (event) => event.type === "bots.changed" || event.type === "data.purged",
}));

const useGroupList = sharedLive<BotGroup[]>((link) => ({
  load: () => call(link, "GET /api/bot-groups"),
  reloadOn: (event) => event.type === "bot-groups.changed",
}));

export function useBots(link: HostLink, active = true): readonly StudioBot[] {
  return useBotList(active ? link : NO_LINK) ?? NO_BOTS;
}

export function useBotGroups(link: HostLink): readonly BotGroup[] {
  return useGroupList(link) ?? NO_GROUPS;
}

export function useBotGroup(link: HostLink, id: string): BotGroup | null | undefined {
  const groups = useGroupList(link);
  return groups?.find((group) => group.id === id) ?? (groups ? null : undefined);
}

export function groupMembers(group: BotGroup, bots: readonly StudioBot[]): StudioBot[] {
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  return group.memberIds.flatMap((id) => byId.get(id) ?? []);
}

export const botProfiles = (profiles: readonly ModelProfile[]) => profiles.filter((profile) => supportsBotRuntime(profile.runtime) && !profile.unavailable && !profile.hidden);

export function newBotDraft(profiles: readonly ModelProfile[]): BotInput {
  return { name: "", purpose: "", memory: "", profileId: botProfiles(profiles)[0]?.id ?? "", workspaceId: null, enabled: true };
}

export function botChatName(chat: Session, homeSessionId: string | null): string {
  if (chat.id === homeSessionId) return "主聊天";
  return chat.title === "主聊天" ? "原主聊天" : chat.title || "未命名聊天";
}
