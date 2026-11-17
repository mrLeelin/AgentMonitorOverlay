import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRpcClient, RpcError, type ServerNotification, type ThreadSettingsUpdate } from "./rpc-client.js";

const settings: ThreadSettingsUpdate = { threadId: "goal-thread", model: "selected-model", effort: "high", approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false }, serviceTier: null };
const effective = { model: settings.model, reasoningEffort: settings.effort, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, sandbox: settings.sandboxPolicy, serviceTier: null };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function notify(client: CodexRpcClient, threadId: string, actual: Record<string, unknown>) {
  client.emit("notification", { method: "thread/settings/updated", params: { threadId, threadSettings: actual } } as unknown as ServerNotification);
}

describe("Goal settings acknowledgement", () => {
  it("reads back unchanged settings when Codex deduplicates the notification", async () => {
    const client = new CodexRpcClient();
    const request = vi.spyOn(client, "request").mockImplementation(((method: string) => Promise.resolve(method === "thread/resume" ? effective : {})) as typeof client.request);
    await client.updateThreadSettings(settings);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update", "thread/resume"]);
    expect(request.mock.calls[1]?.[1]).toEqual({ threadId: "goal-thread", excludeTurns: true });
    expect(client.listenerCount("notification")).toBe(0);
  });

  it("accepts a matching notification before the response without an unnecessary readback", async () => {
    const client = new CodexRpcClient();
    const request = vi.spyOn(client, "request").mockImplementation((() => {
      notify(client, "goal-thread", { ...settings });
      return Promise.resolve({});
    }) as typeof client.request);
    await client.updateThreadSettings(settings);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/settings/update"]);
    expect(client.listenerCount("notification")).toBe(0);
  });

  it("waits through another thread, stale settings and a stale readback until the requested settings match", async () => {
    const client = new CodexRpcClient();
    const request = vi.spyOn(client, "request").mockImplementation(((method: string) => {
      if (method === "thread/settings/update") notify(client, "goal-thread", { ...settings, model: "old-model" });
      return Promise.resolve(method === "thread/resume" ? { ...effective, reasoningEffort: "low" } : {});
    }) as typeof client.request);
    let finished = false;
    const applying = client.updateThreadSettings(settings).then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(finished).toBe(false);
      notify(client, "another-thread", { ...settings });
      await Promise.resolve();
      expect(finished).toBe(false);
      notify(client, "goal-thread", { ...settings, sandboxPolicy: { type: "dangerFullAccess" } });
      await Promise.resolve();
      expect(finished).toBe(false);
    } finally {
      notify(client, "goal-thread", { ...settings, disabledPluginIds: [] });
    }
    await applying;
    expect(finished).toBe(true);
    expect(client.listenerCount("notification")).toBe(0);
  });

  it.each(["thread/settings/update", "thread/resume"] as const)("does not mask a %s failure as acknowledged settings", async (failingMethod) => {
    const client = new CodexRpcClient();
    vi.spyOn(client, "request").mockImplementation(((method: string) => method === failingMethod ? Promise.reject(new RpcError(method, -32603, "Settings unavailable")) : Promise.resolve({})) as typeof client.request);
    await expect(client.updateThreadSettings(settings)).rejects.toThrow("Settings unavailable");
    expect(client.listenerCount("notification")).toBe(0);
  });

  it("times out instead of unlocking Goal after only a mismatched readback", async () => {
    vi.useFakeTimers();
    const client = new CodexRpcClient();
    vi.spyOn(client, "request").mockImplementation(((method: string) => Promise.resolve(method === "thread/resume" ? { ...effective, model: "old-model" } : {})) as typeof client.request);
    const assertion = expect(client.updateThreadSettings(settings)).rejects.toThrow("Goal 未开启");
    await vi.advanceTimersByTimeAsync(10001);
    await assertion;
    expect(client.listenerCount("notification")).toBe(0);
  });
});
