import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { MOCK_CLAUDE_MODEL, removeTempDir, startMockAnthropic, mockClaudeProvider } from "@amo-studio/testkit";
import { Store } from "../../store/store.js";
import { StaticCredentialReader } from "../credentials.js";
import { ClaudeRuntime } from "./claude-runtime.js";
import { leadReadOnlyHooks, leadToolAllowed, LEAD_READ_ONLY_REASON } from "./lead-policy.js";

describe("Claude leads with local files read-only", () => {
  it("allows only explicit read tools and AMO tools, and rechecks a live task's role", async () => {
    for (const tool of ["Read", "Glob", "Grep", "WebSearch", "mcp__amo__task_plan_propose", "mcp__amo__task_message", "mcp__amo__task_update", "mcp__amo__canvas_group_create", "mcp__amo__canvas_move", "mcp__amo__canvas_arrange"]) expect(leadToolAllowed(tool), tool).toBe(true);
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "Skill", "ExitPlanMode", "mcp__other__write", "mcp__amo_fake__task_message"]) expect(leadToolAllowed(tool), tool).toBe(false);
    let lead = false;
    const hook = leadReadOnlyHooks(() => lead).PreToolUse![0]!.hooks[0]!;
    const input: PreToolUseHookInput = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo unsafe" }, tool_use_id: "tool-1", session_id: "session-1", transcript_path: "unused", cwd: "unused" };
    const options = { signal: new AbortController().signal };
    expect(await hook(input, "tool-1", options)).toEqual({});
    lead = true;
    expect(await hook(input, "tool-1", options)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    lead = false;
    expect(await hook(input, "tool-1", options)).toEqual({});
  });

  it("denies writes through the real SDK even with bypass requested, while keeping file reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "amo-studio-test-claude-lead-"));
    const mock = await startMockAnthropic();
    const store = new Store(join(root, "studio.db"));
    const runtime = new ClaudeRuntime({ store, profiles: [{ id: "mock", label: "mock", runtime: "claude", provider: "mock", model: MOCK_CLAUDE_MODEL, credentialId: "mock" }], providers: { mock: mockClaudeProvider(mock.baseUrl) }, credentials: new StaticCredentialReader({ mock: "mock-key" }), claudeHome: join(root, "claude-home") });
    try {
      const workspace = store.addWorkspace({ path: root, name: "ws" });
      const task = store.createTask({ title: "lead", workspaceId: workspace.id, lead: true });
      const session = await runtime.startSession({ taskId: task.id, topicId: null, workspace, profileId: "mock", options: { permission: "bypassPermissions" } });
      expect(session.options.permission).toBe("plan");
      expect((await runtime.setOptions(session.id, { permission: "bypassPermissions" })).options.permission).toBe("plan");
      await expect(runtime.handoff(session.id)).rejects.toThrow(/主控的本地文件只读/);
      const forbidden = join(root, "forbidden.txt");
      await runtime.sendMessage(session.id, `[[shell: echo unsafe > "${forbidden.replace(/\\/g, "/")}"]]`);
      const untilIdle = async () => {
        const deadline = Date.now() + 60_000;
        while (store.getSession(session.id)!.status !== "idle") {
          if (Date.now() > deadline) throw new Error("Claude lead test timed out");
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      };
      await untilIdle();
      expect(existsSync(forbidden)).toBe(false);
      expect(store.listItems(session.id).some((item) => item.type === "approval")).toBe(false);
      expect(JSON.stringify(store.listItems(session.id))).toContain(LEAD_READ_ONLY_REASON);
      const readable = join(root, "readable.txt");
      writeFileSync(readable, "lead-read-proof", "utf8");
      await runtime.sendMessage(session.id, `[[read-image: ${readable}]]`);
      await untilIdle();
      expect(JSON.stringify(store.listItems(session.id))).toContain("lead-read-proof");
      expect(store.listItems(session.id).some((item) => item.type === "approval")).toBe(false);

      // A pending approval was issued while this was an execution task. Promoting it cannot grant that old write.
      const workerTask = store.createTask({ title: "promoted", workspaceId: workspace.id });
      const worker = await runtime.startSession({ taskId: workerTask.id, topicId: null, workspace, profileId: "mock", text: `[[shell: echo unsafe > "${forbidden.replace(/\\/g, "/")}"]]` });
      const waitFor = async (status: string) => {
        const deadline = Date.now() + 60_000;
        while (store.getSession(worker.id)!.status !== status) {
          if (Date.now() > deadline) throw new Error(`Claude lead test timed out waiting for ${status}`);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      };
      await waitFor("awaiting-approval");
      const approval = store.listItems(worker.id).find((item) => item.type === "approval" && item.state === "pending");
      if (approval?.type !== "approval") throw new Error("expected the worker's pending approval");
      store.updateTask(workerTask.id, { lead: true });
      await runtime.respondApproval(worker.id, approval.approvalId, "accept");
      await waitFor("idle");
      expect(existsSync(forbidden)).toBe(false);
      expect(store.getItem(approval.id)).toMatchObject({ state: "declined" });
    } finally {
      await runtime.closeAll();
      store.close();
      await mock.close();
      removeTempDir(root);
    }
  }, 150_000);
});
