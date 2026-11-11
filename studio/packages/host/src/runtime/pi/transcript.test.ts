import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session, SessionItem } from "@amo-studio/protocol";
import { Store } from "../../store/store.js";
import { RuntimeBase } from "../runtime.js";
import { TOOL_OUTPUT_LIMIT } from "../items.js";
import { describePiTool, PiTranscript } from "./transcript.js";

class Harness extends RuntimeBase {
  constructor(store: Store) { super(store, "pi"); }
  core() { return this.makeCore(); }
}

let store: Store;
let session: Session;
let transcript: PiTranscript;
const rows = () => store.listItems(session.id);
const turn = () => rows().find((it): it is Extract<SessionItem, { type: "turn" }> => it.type === "turn")!;

beforeEach(() => {
  store = new Store(":memory:");
  const workspace = store.addWorkspace({ path: "C:/sandbox/pi", name: "pi" });
  const task = store.createTask({ title: "Pi", workspaceId: workspace.id });
  session = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "pi", profileId: "pi", workspaceId: workspace.id, title: "Pi", runtimeRef: "pi-session", status: "idle", writer: "workbench", options: {} });
  transcript = new PiTranscript(new Harness(store).core(), session.id, workspace.path);
  transcript.openTurn();
});
afterEach(() => store.close());

describe("PiTranscript", () => {
  it("keeps block ordering and replaces deltas with authoritative final content", () => {
    transcript.event({ type: "message_start", message: { role: "assistant", content: [] } });
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "先想" } });
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "完整思考" } });
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "部分" } });
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "回复" } });
    transcript.event({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "最终思考" }, { type: "text", text: "最终回复" }], stopReason: "stop" } });
    const content = rows().filter((it) => it.type === "agent" || it.type === "reasoning");
    expect(content).toMatchObject([{ type: "reasoning", text: "最终思考", streaming: false }, { type: "agent", markdown: "最终回复", streaming: false }]);
    expect(content.every((it) => it.raw?.turnId === turn().turnId)).toBe(true);
    expect(turn().state).toBe("running");
  });

  it("shows final-only messages, drops unfinished content missing from the final message and sums model-call usage", () => {
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "discard" } });
    transcript.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "toolUse", usage: { input: 10, cacheRead: 20, cacheWrite: 3, output: 4 } } });
    transcript.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop", usage: { input: 100, cacheRead: 200, cacheWrite: 30, output: 40 } } });
    expect(rows().filter((it) => it.type === "agent").map((it) => it.markdown)).toEqual(["", "first", "second"]);
    expect(turn().usage).toMatchObject({ input: 363, cachedInput: 220, output: 44, reasoning: 0, context: 370 });
  });

  it("settles a streamed block when final content changes its type", () => {
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "uncommitted" } });
    transcript.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "committed" }], stopReason: "stop" } });
    expect(rows().find((it) => it.type === "reasoning")).toMatchObject({ text: "", streaming: false });
    expect(rows().find((it) => it.type === "agent")).toMatchObject({ markdown: "committed", streaming: false });
  });

  it("classifies commands and edits and replaces partial tool output with the final tail", () => {
    transcript.event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "rg -n hello src" } });
    transcript.event({ type: "tool_execution_update", toolCallId: "call-1", partialResult: { content: [{ type: "text", text: "partial" }] } });
    expect(rows().find((it) => it.type === "tool")).toMatchObject({ kind: "search", detail: "partial", status: "running" });
    transcript.event({ type: "tool_execution_end", toolCallId: "call-1", result: { content: [{ type: "text", text: "x".repeat(TOOL_OUTPUT_LIMIT + 30) + "end" }], details: { exitCode: 1 } }, isError: true, durationMs: 25 });
    const tool = rows().find((it): it is Extract<SessionItem, { type: "tool" }> => it.type === "tool")!;
    expect(tool).toMatchObject({ status: "failed", exitCode: 1, durationMs: 25 });
    expect(tool.detail).toHaveLength(TOOL_OUTPUT_LIMIT + 2);
    expect(tool.detail?.endsWith("end")).toBe(true);
    expect(describePiTool("edit", { path: "C:/sandbox/pi/a.ts", oldText: "old", newText: "new" }, "C:/sandbox/pi")).toMatchObject({ kind: "edit", summary: "a.ts", files: [{ path: "a.ts", change: "update", added: 1, removed: 1, diff: "-old\n+new" }] });
    expect(describePiTool("mcp__amo__task_note_add", { text: "ok" })).toMatchObject({ kind: "mcp", summary: "amo · task_note_add" });
  });

  it("settles streaming content, unfinished tools and compaction when interrupted", () => {
    transcript.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "working" } });
    transcript.event({ type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "npm test" } });
    transcript.event({ type: "compaction_start", reason: "threshold" });
    transcript.closeTurn("interrupted");
    expect(rows().find((it) => it.type === "agent")).toMatchObject({ streaming: false });
    expect(rows().find((it) => it.type === "tool")).toMatchObject({ status: "failed" });
    expect(rows().find((it) => it.type === "compaction")).toMatchObject({ state: "failed" });
    expect(turn()).toMatchObject({ state: "interrupted", endedAt: expect.any(String) });
    expect(transcript.turnItemId()).toBeNull();
    transcript.closeTurn("failed", "late error");
    expect(turn().state).toBe("interrupted");
  });

  it("keeps the turn open during retries and clears an earlier model error after successful retry", () => {
    transcript.event({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" } });
    expect(transcript.failed()).toBe("overloaded");
    transcript.event({ type: "agent_end", willRetry: true });
    expect(turn().state).toBe("running");
    transcript.event({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "overloaded" });
    expect(turn().retry).toEqual({ attempt: 1, max: 3, reason: "overloaded" });
    transcript.event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" } });
    transcript.event({ type: "auto_retry_end", success: true });
    expect(transcript.failed()).toBeUndefined();
    expect(turn().retry).toBeUndefined();
    transcript.closeTurn("completed");
    expect(turn().state).toBe("completed");
  });

  it("reports compaction results in both Pi event generations and preserves a failed retry", () => {
    transcript.event({ type: "compaction_start", reason: "manual" });
    transcript.event({ type: "compaction_end", reason: "manual", result: { tokensBefore: 1000, estimatedTokensAfter: 200 } });
    transcript.event({ type: "auto_compaction_start", reason: "overflow" });
    transcript.event({ type: "auto_compaction_end", aborted: false, errorMessage: "no model" });
    expect(rows().filter((it) => it.type === "compaction")).toMatchObject([{ state: "completed", trigger: "manual", beforeTokens: 1000, afterTokens: 200 }, { state: "failed", trigger: "auto", error: "no model" }]);
    transcript.event({ type: "auto_retry_end", success: false, finalError: "retry exhausted" });
    expect(transcript.failed()).toBe("retry exhausted");
    transcript.closeTurn("failed", transcript.failed());
    expect(turn()).toMatchObject({ state: "failed", error: "retry exhausted" });
  });
});
