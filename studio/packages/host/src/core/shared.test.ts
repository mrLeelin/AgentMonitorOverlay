import { describe, expect, it } from "vitest";
import type { Session, SessionGoal } from "@amo-studio/protocol";
import { sessionMoving } from "./shared.js";

const goal: SessionGoal = { threadId: "thread", objective: "Finish the task", status: "active", tokenBudget: null, tokensUsed: 10, timeUsedSeconds: 1, createdAt: 1, updatedAt: 2 };
const session: Session = { id: "s", taskId: "task", topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "codex", workspaceId: "ws", title: "Goal", status: "idle", writer: "workbench", runtimeRef: "thread", options: {}, createdAt: "2026-11-16T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", archivedAt: null };

describe("sessionMoving with native goals", () => {
  it("keeps active goals working between turns, but never revives archived sessions", () => {
    expect(sessionMoving({ ...session, goal })).toBe(true);
    expect(sessionMoving({ ...session, goal, archivedAt: session.updatedAt })).toBe(false);
  });

  it.each(["paused", "blocked", "usageLimited", "budgetLimited", "complete"] as const)("does not treat an idle %s goal as running, while its unfinished turn still counts", (status) => {
    expect(sessionMoving({ ...session, goal: { ...goal, status } })).toBe(false);
    expect(sessionMoving({ ...session, status: "running", goal: { ...goal, status } })).toBe(true);
  });
});
