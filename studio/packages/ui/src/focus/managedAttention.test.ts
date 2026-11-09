import { describe, expect, it } from "vitest";
import { exampleSessions, exampleTasks, type DecisionRequest, type Session, type Task } from "@amo-studio/protocol";
import { decisionNeedsPerson, replyNeedsPerson } from "./managedAttention.js";

const task = (id: string, lead = false, managerTaskId: string | null = null): Task => ({ ...exampleTasks[0]!, id, lead, managerTaskId });
const session = (taskId: string, status: Session["status"] = "idle"): Session => ({ ...exampleSessions[0]!, id: `s-${taskId}`, taskId, status });
const decision = (patch: Partial<DecisionRequest> = {}): DecisionRequest => ({ id: "d", sessionId: "s-worker", taskId: "worker", question: "用哪个音效？", options: ["甲", "乙"], state: "open", answer: null, createdAt: "2026-11-09T00:00:00Z", answeredAt: null, ...patch });
const tree = [task("root", true), task("sound", true, "root"), task("worker", false, "sound")];

describe("managed workflow attention", () => {
  it("only removes business decisions explicitly routed to a valid manager", () => {
    expect(decisionNeedsPerson(decision(), tree)).toBe(true);
    expect(decisionNeedsPerson(decision({ routedToTaskId: "sound" }), tree)).toBe(false);
    expect(decisionNeedsPerson(decision({ routedToTaskId: "root" }), tree)).toBe(false);
    expect(decisionNeedsPerson(decision({ routedToTaskId: "missing" }), tree)).toBe(true);
    expect(decisionNeedsPerson(decision({ routedToTaskId: "peer" }), [...tree, task("peer", true)])).toBe(true);
    expect(decisionNeedsPerson(decision({ routedToTaskId: "sound" }), tree.map((t) => t.id === "sound" ? { ...t, archivedAt: "2026-11-09T00:00:00Z" } : t))).toBe(true);
  });

  it("keeps routine managed replies with the root and exposes them if the root has no usable session", () => {
    const rootSession = session("root");
    for (const status of ["idle", "completed"] as const) expect(replyNeedsPerson(session("worker", status), tree, [rootSession])).toBe(false);
    expect(replyNeedsPerson(rootSession, tree, [rootSession])).toBe(false);
    expect(replyNeedsPerson(rootSession, tree.map((t) => t.id === "root" ? { ...t, column: "done" } : t), [rootSession])).toBe(true);
    expect(replyNeedsPerson(session("worker"), tree, [])).toBe(true);
    expect(replyNeedsPerson(session("worker"), tree, [{ ...rootSession, writer: "terminal-handoff" }])).toBe(true);
    expect(replyNeedsPerson(session("worker"), tree.filter((t) => t.id !== "sound"), [rootSession])).toBe(true);
  });

  it("preserves all runtime questions, approvals, review requests, failures and interruptions", () => {
    for (const status of ["awaiting-approval", "awaiting-answer", "awaiting-review", "error", "interrupted"] as const) expect(replyNeedsPerson(session("worker", status), tree, [session("root")])).toBe(true);
  });
});
