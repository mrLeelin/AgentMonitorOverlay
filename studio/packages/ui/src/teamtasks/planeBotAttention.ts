import type { PlaneBotAttention } from "@amo-studio/protocol";
import { useEffect } from "react";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

export function usePlaneBotAttention(link: HostLink | null) {
  const [jobs, , reload] = useLiveResource<PlaneBotAttention[]>({
    load: () => link ? call(link, "GET /api/team-board/plane/bot-attention") : Promise.resolve([]),
    initial: [], reset: true, reloadDelay: 80,
    reloadOn: (event) => event.type === "plane.bot.changed" || event.type === "data.purged" || event.type === "bots.changed",
  }, [link]);
  const waiting = jobs.some((job) => job.requesterReview === "waiting");
  useEffect(() => {
    if (!link || !waiting) return;
    // Plane comments originate outside Studio. Keep the reminder live while the person works in the project.
    const timer = setInterval(reload, 30_000);
    return () => clearInterval(timer);
  }, [link, waiting, reload]);
  return jobs;
}

export function planeBotNeedsAttention(job: Pick<PlaneBotAttention, "state" | "requesterReview">): boolean {
  return job.state === "awaiting-approval" || job.state === "awaiting-user" || job.state === "review" || job.state === "failed"
    || job.state === "sent" && job.requesterReview === "confirmed";
}

export function planeBotTaskIds(jobs: readonly PlaneBotAttention[]) {
  return new Set(jobs.flatMap((job) => [job.rootTaskId ?? job.taskId, ...(job.requestTaskIds ?? [])]));
}
