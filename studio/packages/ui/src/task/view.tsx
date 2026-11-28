import { TaskPage } from "./TaskPage.js";
import { backTo, type ViewDef } from "../shell/views.js";
import { leadCanvasView } from "../bots/lead-navigation.js";

/** One task: its sessions and conversation, notes, mail, decisions and checklist. "←" returns where it was opened from. */
export const taskView: ViewDef<"task"> = {
  kind: "task",
  render: (view, { link, state, data, setView, teamTasksEnabled, botsEnabled }) => {
    if (view.botWorkspace && view.sessionId && !state.sessions.some((session) => session.id === view.sessionId)) {
      return <div className="placeholder" role="status">正在打开 Bot 聊天…</div>;
    }
    const task = state.tasks.find((t) => t.id === view.taskId);
    if (!task) return <div className="placeholder">任务不存在或已被删除。</div>;
    const back = backTo(view.back, teamTasksEnabled, botsEnabled);
    return (
      <TaskPage
        key={`${task.id}:${view.nav ?? 0}`}
        link={link}
        task={task}
        sessions={state.sessions}
        tasks={state.tasks}
        workspaces={state.workspaces}
        topics={state.topics}
        profiles={state.profiles}
        checklist={data.checklist.filter((i) => i.taskId === task.id)}
        {...(view.sessionId ? { initialSessionId: view.sessionId } : {})}
        {...(view.passage ? { passage: view.passage } : {})}
        {...(view.scroll !== undefined ? { restoreScroll: view.scroll } : {})}
        justCreated={!!view.created}
        inBotWorkspace={botsEnabled && !!view.botWorkspace}
        backLabel={back.label}
        onBack={() => setView(back.view)}
        onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: view.back })}
        onOpenCanvas={(topicId, taskId, review, sessionId) => setView(leadCanvasView(topicId, taskId, review, { ...view, ...(sessionId ? { sessionId } : {}) }))}
        onOpenPlaneOriginal={(originalUrl) => setView({ kind: "team", originalUrl })}
      />
    );
  },
};
