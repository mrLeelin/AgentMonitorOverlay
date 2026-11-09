import type { Task, TaskResult } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { latestTaskResults } from "./task-flow.js";

/** Read once per management tree, not once per arrow; reuse the normal Host event/reconnect lifecycle. */
export function useTaskFlow(link: HostLink, tasks: readonly Task[]) {
  const live = tasks.filter((t) => !t.archivedAt && !t.remote);
  const roots = live.filter((t) => t.lead && !live.some((p) => p.id === t.managerTaskId)).map((t) => t.id).sort();
  const key = JSON.stringify(roots);
  const [data] = useLiveResource<{ results: TaskResult[]; unavailable: boolean }>({
    load: async () => {
      const responses = await Promise.allSettled(roots.map((id) => call(link, "GET /api/tasks/:id/workflow", { id })));
      return { results: responses.flatMap((r) => r.status === "fulfilled" ? r.value.results : []), unavailable: responses.some((r) => r.status === "rejected") };
    },
    initial: { results: [], unavailable: false },
    reset: true,
    reloadOn: (event) => event.type === "task.upserted" || event.type === "task.note.added",
    reloadDelay: 80,
  }, [link, key]);
  return { results: latestTaskResults(data.results), unavailable: data.unavailable };
}
