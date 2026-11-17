import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startMockAnthropic, removeTempDir } from "@amo-studio/testkit";
import { AcpConnection } from "./acp.js";
import { DshGoalBridge } from "./goal-bridge.js";
import { resolveDsh } from "./install.js";

async function mockPort(): Promise<number> {
  for (let i = 0; i < 80; i++) {
    const port = 47920 + ((process.pid + i) % 80);
    const server = createServer();
    const free = await new Promise<boolean>((resolve) => { server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => resolve(true)); });
    if (free) { await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
  }
  throw new Error("No free test port in the Studio test range");
}

// Opt-in: the installed DSH runs against an isolated home and loopback mock, never a real provider or account.
describe.skipIf(process.env.AMO_DSH_GOAL_NATIVE !== "1")("installed DSH native Goal service", () => {
  it("loads the plugin and runs native rounds, pauses and resumes, then enforces the native round budget", async () => {
    mkdirSync(join(tmpdir(), "amo-studio-sandbox"), { recursive: true });
    const root = mkdtempSync(join(tmpdir(), "amo-studio-sandbox", "dsh-goal-native-"));
    const workspace = join(root, "workspace"); mkdirSync(workspace); mkdirSync(join(root, "home"));
    const mock = await startMockAnthropic({ port: await mockPort(), script: () => ({ kind: "text", text: "Offline native Goal verification.", delayMs: 150, chunks: 3 }) });
    const bridge = new DshGoalBridge(root);
    appendFileSync(bridge.patch, `\n- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(mock.baseUrl)}\n`);
    const launch = resolveDsh({ getKv: () => undefined, setKv: () => undefined }, process.env);
    if ("error" in launch) throw new Error(launch.error);
    const conn = new AcpConnection({ command: launch.command, args: [...launch.args, "--profile", "acp", "--patch", bridge.patch], cwd: workspace, env: { ...process.env, ...launch.env, DSH_HOME: join(root, "home"), DEEPSEEK_API_KEY: "offline-native-goal-test", DEEPSEEK_BASE_URL: mock.baseUrl, DSH_PERMISSION_MODE: "read-only", AMO_DSH_GOAL_BRIDGE: bridge.environment() }, logFile: join(root, "native.log") }, async () => ({ outcome: { outcome: "cancelled" } }));
    const wait = async (predicate: () => Promise<boolean> | boolean) => { const deadline = Date.now() + 15000; while (!(await predicate())) { if (Date.now() > deadline) throw new Error("Native Goal verification timed out"); await new Promise((resolve) => setTimeout(resolve, 100)); } };
    try {
      await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      const session = await conn.request<{ sessionId: string }>("session/new", { cwd: workspace, mcpServers: [] });
      bridge.bind(session.sessionId, conn.pid);
      expect(await bridge.call("get")).toBeNull();
      expect(await bridge.call("set", { objective: "Verify Goal with local mock only", roundBudget: 1, status: "active" })).toMatchObject({ phase: "active", activation: "armed", maxGoalRounds: 1 });
      await wait(() => mock.requests.length > 0);
      await bridge.call("set", { status: "paused" });
      expect(await bridge.call("get")).toMatchObject({ phase: "paused", activation: "disarmed", roundsStarted: 1 });
      await expect(bridge.call("set", { status: "active" })).rejects.toThrow(/exhausted/);
      expect(await bridge.call("set", { roundBudget: 2, status: "active" })).toMatchObject({ phase: "active", activation: "armed", maxGoalRounds: 2 });
      await wait(async () => (await bridge.call("get"))?.phase === "blocked");
      expect(await bridge.call("get")).toMatchObject({ phase: "blocked", blockedReason: { code: "round-limit" }, roundsStarted: 2 });
      expect(mock.requests.length).toBeGreaterThanOrEqual(2);
      expect(await bridge.call("clear")).toBeNull();
    } finally { await conn.close(); bridge.close(); await mock.close(); removeTempDir(root); }
  }, 60000);
});
