import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateSnapshot, Task, TaskResultHeader, Topic, Workspace } from "@amo-studio/protocol";
import { appointmentTargets, leadTargetLabel, operationKey } from "./LeadAppointment.js";
import { readLeadResult } from "./LeadWorkflow.js";
import { canvasBridgeView, focusCanvasTarget } from "./lead-navigation.js";
import { applyEvent } from "../host/useHostState.js";
import { canvasContextHints } from "../canvas/useContextHints.js";
import { workflowRoots } from "../canvas/useTaskFlow.js";

const link = { url: "http://127.0.0.1:47979", token: "fixture" };
const task = (id: string, patch: Partial<Task> = {}): Task => ({ id, title: id, workspaceId: "project", topicId: "topic", column: "doing", createdAt: "", updatedAt: "", archivedAt: null, ...patch });
const appointed = { kind: "appointed", term: { termId: "term-a", generation: 1, botId: "bot", name: "小鲸鱼", sessionId: null, state: "active", runState: "failed" } } as const;
const topic: Topic = { id: "topic", title: "移植", workspaceIds: ["project"], createdAt: "", updatedAt: "", archivedAt: null };
const workspace: Workspace = { id: "project", name: "客户端", path: "E:/repo/client", createdAt: "" };

describe("local Bot lead UI", () => {
  it("shows active roots with project and current Bot name, and keys authorship by source IDs", () => {
    const root = task("root", { lead: true, botLead: appointed });
    expect(appointmentTargets([root, task("other", { lead: true, topicId: "other", botLead: appointed }), task("child", { lead: true, managerTaskId: root.id, botLead: appointed })], [topic])).toEqual([root]);
    expect(leadTargetLabel(root, [topic], [workspace])).toBe("移植 · root · 小鲸鱼 · 客户端（E:/repo/client）");
    expect(operationKey({ kind: "user-message", sessionId: "one", messageId: "same" })).not.toEqual(operationKey({ kind: "user-message", sessionId: "two", messageId: "same" }));
  });

  it("routes the exact source result or decision to the formal card through the existing window bridge", () => {
    const review = focusCanvasTarget("topic", "task:id", { resultId: "result-one" });
    expect(canvasBridgeView(review.topicId, review.calloutId)).toMatchObject({ kind: "canvas", topicId: "topic", taskId: "task:id", attention: { resultId: "result-one" } });
    const decision = focusCanvasTarget("topic", "task:id", { decisionId: "decision-two" });
    expect(canvasBridgeView(decision.topicId, decision.calloutId)).toMatchObject({ attention: { decisionId: "decision-two" } });
    expect(canvasBridgeView("topic", "legacy-callout")).toMatchObject({ callout: "legacy-callout" });
  });

  it("projects appointment and context state on snapshots and events without reads per card", () => {
    const root = task("root");
    const invalid = task("ordinary", { contextHint: { kind: "invalid-binding" } });
    const snapshot = { eventSeq: 1, tasks: [root, invalid], sessions: [], topics: [], workspaces: [], profiles: [] } as StateSnapshot;
    const appointedSnap = applyEvent(snapshot, { type: "bot-lead.changed", seq: 2, taskId: root.id, topicId: topic.id, state: appointed });
    expect(appointedSnap.tasks[0]?.botLead).toEqual(appointed);
    const next = applyEvent(appointedSnap, { type: "task.upserted", seq: 3, task: { ...root, lead: true, botLead: appointed, contextHint: { kind: "awaiting-adoption", version: 3 } } });
    const visible = canvasContextHints(next.tasks);
    expect(visible.unavailable).toBe(false);
    expect(visible.hints.get(root.id)?.detail).toContain("第 3 版");
    expect(visible.hints.get(invalid.id)?.label).toBe("归属待核对");
    expect(canvasContextHints(snapshot.tasks).unavailable).toBe(true);
  });

  it("resolves one summary root per valid management tree, including legacy roots, and excludes cross-topic branches and cycles", () => {
    const tasks = [task("root", { lead: true }), task("middle", { lead: true, managerTaskId: "root" }), task("leaf", { managerTaskId: "middle" }),
      task("cross", { topicId: "another", managerTaskId: "root" }), task("cycle-1", { lead: true, managerTaskId: "cycle-2" }), task("cycle-2", { lead: true, managerTaskId: "cycle-1" })];
    expect([...workflowRoots(tasks)]).toEqual([["root", "root"], ["middle", "root"], ["leaf", "root"], ["cross", null], ["cycle-1", null], ["cycle-2", null]]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("joins UTF-16 evidence pages and rejects a result changed while reading", async () => {
    const header = { id: "result", taskId: "root", updatedAt: "version-one" } as TaskResultHeader;
    const result = { ...header, verification: "已检查：🐳" };
    const body = JSON.stringify(result);
    const split = body.indexOf("🐳") + 1;
    const reply = (text: string, nextOffset: number | null, updatedAt = header.updatedAt) => new Response(JSON.stringify({ result: { ...header, updatedAt }, text, nextOffset, length: body.length }));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply(body.slice(0, split), split))
      .mockResolvedValueOnce(reply(body.slice(split), null))
      .mockResolvedValueOnce(reply(body.slice(0, split), split))
      .mockResolvedValueOnce(reply(body.slice(split), null, "version-two"));
    vi.stubGlobal("fetch", fetch);
    await expect(readLeadResult(link, "root", header)).resolves.toEqual(result);
    expect(String(fetch.mock.calls[1]?.[0])).toContain(`/workflow/results/result?offset=${split}`);
    await expect(readLeadResult(link, "root", header)).rejects.toThrow("交付状态或版本已变化");
  });
});
