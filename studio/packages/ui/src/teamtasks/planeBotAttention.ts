import type { PlaneBotAttention } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

export function usePlaneBotAttention(link: HostLink | null) {
  const [jobs, setJobs] = useLiveResource<PlaneBotAttention[]>({
    load: () => link ? call(link, "GET /api/team-board/plane/bot-attention") : Promise.resolve([]),
    initial: [], reset: true, reloadDelay: 80,
    reloadOn: (event) => event.type === "plane.bot.changed" || event.type === "data.purged" || event.type === "bots.changed",
    onError: () => setJobs([]),
  }, [link]);
  return jobs;
}

export function planeBotNeedsAttention(job: Pick<PlaneBotAttention, "state">): boolean {
  return job.state === "awaiting-approval" || job.state === "awaiting-user" || job.state === "review" || job.state === "failed";
}
