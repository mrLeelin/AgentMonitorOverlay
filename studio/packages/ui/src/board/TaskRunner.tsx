import type { Session } from "@amo-studio/protocol";

/** Mixed-model tasks follow the newest running main session; a running branch is the fallback. */
export function taskRunnerSkin(sessions: readonly Session[]): "claude" | "default" {
  const running = sessions.filter((s) => !s.archivedAt && s.status === "running");
  running.sort((a, b) => Number(b.kind === "main") - Number(a.kind === "main") || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return running[0]?.runtime === "claude" ? "claude" : "default";
}

export function TaskRunner({ sessions }: { sessions: readonly Session[] }) {
  return <span className="card-runner" data-skin={taskRunnerSkin(sessions)} aria-hidden="true" />;
}
