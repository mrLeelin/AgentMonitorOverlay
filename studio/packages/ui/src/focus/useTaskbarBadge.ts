import { useEffect, useState } from "react";
import { remoteHeldTasks } from "@amo-studio/protocol";
import type { HostState } from "../host/useHostState.js";
import { useOpenDecisions } from "../collab/DecisionPanel.js";
import { usePendingProposals } from "../planning/ProposalsPanel.js";
import { useTaskPlans } from "../taskplans/TaskPlans.js";
import { useRelays } from "../relays/Relays.js";
import { useTeamSends } from "../teamrelay/TeamRelay.js";
import { useWaitingQuestionList } from "../canvas/useCallouts.js";
import { useSettings } from "../settings/useSettings.js";
import { useRemote } from "../remote/remote.js";
import { unseenSessions, useSessionSeen, withGrants } from "../lib/sessionSeen.js";
import { needsPerson } from "../lib/status.js";
import { useStoredIds } from "../lib/storedIds.js";
import { ALSO_MINE_KEY } from "./pins.js";
import { decisionNeedsPerson, replyNeedsPerson } from "./managedAttention.js";

const NO_LINK = { url: "", token: "" };

/** Same pending items as Focus, owned by the workbench so closing Focus cannot stop the badge. */
export function useTaskbarBadge(host: HostState): void {
  const live = host.kind === "ready" ? host.state : null;
  const link = host.kind === "ready" ? host.link : null;
  const noLink = link ?? NO_LINK;
  const decisions = useOpenDecisions(noLink);
  const proposals = usePendingProposals(noLink);
  const plans = useTaskPlans(noLink);
  const relays = useRelays(noLink);
  const sends = useTeamSends(link);
  const questions = useWaitingQuestionList(link);
  const settings = useSettings(noLink);
  const remote = useRemote(link);
  const seenHere = useSessionSeen();
  const alsoMine = useStoredIds(ALSO_MINE_KEY);
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (!remote?.grants.length) return;
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [remote?.grants.length]);
  const held = remoteHeldTasks(remote, clock);
  const mine = (s: { taskId?: string | null }) => !s.taskId || !held.has(s.taskId) || alsoMine.has(s.taskId);
  const seen = live ? withGrants(seenHere, live.tasks, live.sessions) : seenHere;
  const waiting = live?.sessions.filter((s) => !s.archivedAt && needsPerson(s.status) && mine(s)) ?? [];
  const finished = live ? unseenSessions(live.sessions, seen).filter((s) => !waiting.includes(s) && mine(s) && replyNeedsPerson(s, live.tasks, live.sessions)) : [];
  const count = live ? waiting.length + finished.length
    + decisions.filter((d) => decisionNeedsPerson(d, live.tasks) && live.sessions.some((s) => s.id === d.sessionId && !s.archivedAt)).length
    + (settings?.disabledFeatures.includes("planning") ? 0 : proposals.length)
    + plans.filter((p) => p.state === "open").length + relays.filter((r) => r.state === "pending").length
    + sends.filter((s) => s.state === "pending").length
    + Object.keys(questions).filter((id) => live.topics.some((t) => t.id === id && !t.archivedAt)).length
    + (remote?.incoming.length ?? 0) + (remote?.taskRequests.length ?? 0) : 0;
  useEffect(() => {
    window.amo?.setTaskbarBadge?.(count, badgeImage(count));
  }, [count]);
}

/** Windows overlays are raster images; draw at twice their nominal size for high DPI taskbars. */
export function badgeImage(count: number): string | null {
  if (count <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#303238";
  ctx.beginPath();
  ctx.arc(16, 16, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${count > 99 ? 14 : count > 9 ? 18 : 23}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count > 99 ? "99+" : String(count), 16, 17);
  return canvas.toDataURL("image/png");
}
