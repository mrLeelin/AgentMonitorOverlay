import { inTurn, type ModelProfile, type ProfileChoices, type Session } from "@amo-studio/protocol";
import { activeModel, sessionModelName } from "./choices.js";

/** The task's root main session; launched sessions only stand in when no root main remains. */
export function taskModelSessions(sessions: readonly Session[]): Session[] {
  const newest = (list: readonly Session[]) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const oldest = (list: readonly Session[]) => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const live = sessions.filter((s) => !s.archivedAt);
  const main = live.filter((s) => s.kind === "main");
  const current = (list: readonly Session[]) => newest(list).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || Number(inTurn(b.status)) - Number(inTurn(a.status)));
  const rootMain = sessions.filter((s) => s.kind === "main" && !s.parentId && !s.startedBy);
  const liveRootMain = rootMain.filter((s) => !s.archivedAt);
  if (liveRootMain.length) return [oldest(liveRootMain)[0]!];
  if (main.length) return [current(main)[0]!];
  if (live.length) return [current(live)[0]!];
  const historical = rootMain.length ? rootMain : sessions.filter((s) => s.kind === "main");
  return newest(historical.length ? historical : sessions).slice(0, 1);
}

export interface TaskModelBadge {
  key: string;
  name: string;
  channel: string;
  profile: ModelProfile | undefined;
  runtime: Session["runtime"];
}

/** Distinct channel/model pairs keep parallel main sessions visible without repeating the same model. */
export function taskModelBadges(sessions: readonly Session[], profiles: readonly ModelProfile[], choices: ReadonlyMap<string, ProfileChoices | null>): TaskModelBadge[] {
  const seen = new Set<string>();
  const badges: TaskModelBadge[] = [];
  for (const session of taskModelSessions(sessions)) {
    const offered = choices.get(session.profileId) ?? null;
    const profile = profiles.find((p) => p.id === session.profileId);
    const channel = profile?.label ?? "未知渠道";
    const name = sessionModelName(offered, session.options) ?? channel;
    const model = session.options.model ?? (offered ? activeModel(offered, session.options)?.id : undefined) ?? "";
    const key = JSON.stringify([session.profileId, model]);
    if (seen.has(key)) continue;
    seen.add(key);
    badges.push({ key, name, channel, profile, runtime: session.runtime });
  }
  return badges;
}
