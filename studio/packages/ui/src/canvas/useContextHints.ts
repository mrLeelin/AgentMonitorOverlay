import type { Id, SharedContextView, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";

export interface ContextHint { label: "需求待更新" | "归属待核对"; detail: string }

/** A canvas hint describes the explicit requirement, never the root's latest publication. */
export function contextHint(view: SharedContextView): ContextHint | undefined {
  const binding = view.binding;
  if (!binding) return;
  if (!view.validBinding) return { label: "归属待核对", detail: "共同需求的原归属已失效，请进入任务查看，由当前主控重新明确要求。" };
  const adopted = view.receipts.some((r) => r.requirementId === binding.id && r.taskId === binding.taskId && r.contextId === binding.contextId && r.version === binding.version && r.adoptedAt);
  if (!adopted) return { label: "需求待更新", detail: `任务要求第 ${binding.version} 版共同需求，执行者尚未声明采用。进入任务可查看，主控会安排更新。` };
}

/** Fetch serially so a large canvas does not create one simultaneous request per card. */
export function useContextHints(link: HostLink, tasks: readonly Task[]) {
  const ids = tasks.filter((t) => !t.archivedAt && !t.remote).map((t) => t.id).sort();
  const key = JSON.stringify(ids);
  const [data] = useLiveResource<{ hints: Map<Id, ContextHint>; unavailable: boolean }>({
    load: async () => {
      const hints = new Map<Id, ContextHint>();
      let unavailable = false;
      for (const id of ids) {
        try {
          const hint = contextHint(await call(link, "GET /api/tasks/:id/context", { id }));
          if (hint) hints.set(id, hint);
        } catch { unavailable = true; }
      }
      return { hints, unavailable };
    },
    initial: { hints: new Map(), unavailable: false },
    reset: true,
    reloadOn: (event) => event.type === "task.upserted" && ids.includes(event.task.id) || event.type === "topic.upserted",
    reloadDelay: 150,
  }, [link, key]);
  return data;
}
