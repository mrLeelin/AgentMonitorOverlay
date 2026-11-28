import { CanvasPage } from "./CanvasPage.js";
import { canvasTopicFor } from "./topic.js";
import type { ViewDef } from "../shell/views.js";

/** The scoped topic, a topic using the scoped project, or the first live topic. */
export const canvasView: ViewDef<"canvas"> = {
  kind: "canvas",
  tab: { label: "画布", open: () => ({ kind: "canvas" }) },
  render: (view, { link, state, scope, setView, botsEnabled, online }) => {
    const topic = view.topicId ? state.topics.find((item) => item.id === view.topicId) : canvasTopicFor(scope, state);
    const archived = view.taskId ? state.tasks.find((item) => item.id === view.taskId && item.archivedAt) : undefined;
    if (archived) return <div className="placeholder"><p>{archived.title || "未命名任务"} · 已归档</p><button type="button" className="btn-ghost" onClick={() => setView({ kind: "task", taskId: archived.id, ...(view.back ? { back: view.back } : {}) })}>打开历史任务</button></div>;
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
        botsEnabled={botsEnabled}
        online={online}
        {...(view.taskId ? { focusTask: { id: view.taskId, nav: view.nav ?? 0, attention: view.attention } } : {})}
        {...(view.back ? { onBack: () => setView(view.back!), backLabel: view.back.kind === "task" ? "原对话" : view.back.kind === "bots" ? "Bots" : "看板" } : {})}
        {...(view.callout ? { openCallout: { id: view.callout, nav: view.nav ?? 0 } } : {})}
        onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { ...view, topicId: topic.id } })}
        onNewTask={() => setView({ kind: "new", topicId: topic.id, back: { ...view, topicId: topic.id } })}
      />
    );
  },
};
