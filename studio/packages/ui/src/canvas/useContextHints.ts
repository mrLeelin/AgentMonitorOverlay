import type { Id, Task } from "@amo-studio/protocol";

export interface ContextHint { label: "需求待更新" | "归属待核对"; detail: string }

export function canvasContextHints(tasks: readonly Task[]) {
  const hints = new Map<Id, ContextHint>();
  let unavailable = false;
  for (const task of tasks) {
    if (task.archivedAt || task.remote) continue;
    const hint = task.contextHint;
    if (hint === undefined) unavailable = true;
    if (hint?.kind === "invalid-binding") hints.set(task.id, { label: "归属待核对", detail: "共同需求的原归属已失效，请进入任务查看，由当前主控重新确认要求。" });
    if (hint?.kind === "awaiting-adoption") hints.set(task.id, { label: "需求待更新", detail: `任务要求第 ${hint.version} 版共同需求，执行者尚未声明采用。进入任务可查看。` });
  }
  return { hints, unavailable };
}
