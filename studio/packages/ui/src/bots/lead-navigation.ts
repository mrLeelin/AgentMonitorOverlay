import type { Id } from "@amo-studio/protocol";
import type { View } from "../shell/views.js";

type CanvasView = Extract<View, { kind: "canvas" }>;
const PREFIX = "studio:task-card:";
export type LeadAttentionTarget = { resultId: Id; decisionId?: never } | { decisionId: Id; resultId?: never };

export function leadCanvasView(topicId: Id, taskId: Id, attention?: LeadAttentionTarget, back?: View): CanvasView {
  return { kind: "canvas", topicId, taskId, nav: Date.now(), ...(attention ? { attention } : {}), ...(back ? { back } : {}) };
}

/** The existing cross-window canvas bridge forwards a topic and target token together. */
export function focusCanvasTarget(topicId: Id, taskId: Id, attention?: LeadAttentionTarget) {
  return { topicId, calloutId: PREFIX + JSON.stringify({ taskId, attention }) };
}

export function canvasBridgeView(topicId: Id, target?: string): CanvasView {
  if (target?.startsWith(PREFIX)) {
    try {
      const { taskId, attention } = JSON.parse(target.slice(PREFIX.length));
      if (typeof taskId === "string" && taskId) {
        const focus = typeof attention?.resultId === "string" ? { resultId: attention.resultId }
          : typeof attention?.decisionId === "string" ? { decisionId: attention.decisionId } : undefined;
        return leadCanvasView(topicId, taskId, focus);
      }
    } catch { /* A malformed workbench target is handled like an ordinary canvas link. */ }
  }
  return { kind: "canvas", topicId, ...(target ? { callout: target } : {}), nav: Date.now() };
}
