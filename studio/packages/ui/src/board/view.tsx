import { Fragment } from "react";
import { call } from "../host/client.js";
import { mailByTask } from "../collab/useInbox.js";
import { checklistByTask } from "../collab/ChecklistPanel.js";
import { Board } from "./Board.js";
import { featureOn } from "../lib/features.js";
import { StudioTeamInbox } from "../teamtasks/StudioTeamTasks.js";
import type { BoardPanel, ViewDef } from "../shell/views.js";

/** The board: the tasks in scope by column, under the panels other features add (scheduler proposals). */
export function boardView(panels: readonly BoardPanel[]): ViewDef<"board"> {
  return {
    kind: "board",
    tab: { label: "看板", open: () => ({ kind: "board" }), alsoFor: ["task"] },
    render: (_view, ctx) => {
      const { link, state, scope, data, setView } = ctx;
      return (
        <>
          {panels.map((panel, i) => featureOn(ctx.disabled, panel.feature) && <Fragment key={i}>{panel.render(ctx)}</Fragment>)}
          <StudioTeamInbox link={link} scope={scope} workspaces={state.workspaces} onOpen={(taskId) => setView({ kind: "task", taskId })}>
            {(teamDrop) => <Board
            link={link}
            tasks={state.tasks}
            sessions={state.sessions}
            workspaces={state.workspaces}
            topics={state.topics}
            profiles={state.profiles}
            scope={scope}
            teamDrop={teamDrop}
            onOpen={(task) => setView({ kind: "task", taskId: task.id })}
            onNew={() => setView({ kind: "new" })}
            onMove={(task, column) => void call(link, "PATCH /api/tasks/:id", { id: task.id }, { column }).catch(() => undefined)}
            onArchive={(tasks) =>
              void (async () => {
                for (const task of tasks) await call(link, "POST /api/tasks/:id/archive", { id: task.id }).catch(() => undefined);
              })()
            }
            mail={mailByTask(data.unreadMail, state.sessions)}
            decisions={data.decisionsByTask}
            checklist={checklistByTask(data.checklist)}
            />}
          </StudioTeamInbox>
        </>
      );
    },
  };
}

