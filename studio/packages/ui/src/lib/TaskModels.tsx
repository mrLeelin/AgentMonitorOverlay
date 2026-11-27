import type { ModelProfile, ProfileChoices, Session } from "@amo-studio/protocol";
import { Mark } from "../chat/pickers.js";
import { taskModelBadges } from "./task-models.js";
import "./task-models.css";

const LETTERS: Record<Session["runtime"], string> = { claude: "C", codex: "G", dsh: "D", pi: "P", remote: "R" };

/** One line on task cards: a running or newest main's model and a count of other current models. */
export function TaskModels({ sessions, profiles, choices }: { sessions: readonly Session[]; profiles: readonly ModelProfile[]; choices: ReadonlyMap<string, ProfileChoices | null> }) {
  const badges = taskModelBadges(sessions, profiles, choices);
  const first = badges[0];
  if (!first) return null;
  return <span className="task-models" data-testid="task-models" aria-label={`当前模型：${first.name}`}>
    <span className="task-model-badge" data-runtime={first.runtime} title={`渠道：${first.channel}\n型号：${first.name}`}>
      {first.profile ? <Mark profile={first.profile} small /> : <span className="task-model-letter" aria-hidden="true">{LETTERS[first.runtime]}</span>}
      <span className="task-model-name">{first.name}</span>
    </span>
  </span>;
}
