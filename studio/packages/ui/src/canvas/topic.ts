import { topicWorkspaceIds, type StateSnapshot, type Topic } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";

/** Keep the canvas and its new-task entry on the same topic, including a project's preferred canvas. */
export function canvasTopicFor(scope: Scope, state: Pick<StateSnapshot, "topics" | "tasks" | "workspaces">): Topic | undefined {
  const topics = state.topics.filter((t) => !t.archivedAt);
  const preferred = scope.kind === "topic" ? topics.find((t) => t.id === scope.id)
    : scope.kind === "workspace" ? topics.find((t) => topicWorkspaceIds(t, state.tasks, state.workspaces).includes(scope.id)) : undefined;
  return preferred ?? topics[0];
}
