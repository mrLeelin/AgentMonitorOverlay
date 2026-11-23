import { CanvasPage } from "./CanvasPage.js";
import { canvasTopicFor } from "./topic.js";
import type { ViewDef } from "../shell/views.js";

/** The scoped topic, a topic using the scoped project, or the first live topic. */
export const canvasView: ViewDef<"canvas"> = {
  kind: "canvas",
  tab: { label: "画布", open: () => ({ kind: "canvas" }) },
  render: (view, { link, state, scope, setView }) => {
    const topic = canvasTopicFor(scope, state);
    if (!topic) return <div className="placeholder">还没有专题。在左栏建一个专题，每个专题有一张自己的画布。</div>;
    return (
      <CanvasPage
        key={topic.id}
        link={link}
        topic={topic}
        tasks={state.tasks.filter((t) => t.topicId === topic.id && !t.archivedAt)}
        allTasks={state.tasks}
        topics={state.topics}
        sessions={state.sessions}
        workspaces={state.workspaces}
        profiles={state.profiles}
        {...(view.callout ? { openCallout: { id: view.callout, nav: view.nav ?? 0 } } : {})}
        onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { kind: "canvas" } })}
        onNewTask={() => setView({ kind: "new", topicId: topic.id, back: { kind: "canvas" } })}
      />
    );
  },
};
