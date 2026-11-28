import type { StateSnapshot } from "@amo-studio/protocol";
import { useTaskFlow } from "../canvas/useTaskFlow.js";
import type { HostLink } from "../host/client.js";

export function useLeadAttention(link: HostLink, state: StateSnapshot | null) {
  const tasks = state?.tasks ?? [];
  const roots = tasks.filter((task) => task.column === "review" && task.lead && !task.managerTaskId && !task.archivedAt && !task.remote && task.botLead?.kind === "appointed" && !!task.topicId &&
    state?.topics.some((topic) => topic.id === task.topicId && !topic.archivedAt));
  const flow = useTaskFlow(link, tasks, null, roots.map((root) => root.id));
  return roots.flatMap((task) => {
    const resultId = flow.homes.get(task.id)?.pendingUserReviewResultId;
    const row = flow.rows.get(task.id);
    return resultId && row?.latestResult?.id === resultId ? [{ task, resultId, sessionId: row.latestResult.sessionId }] : [];
  });
}
