import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Session, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// 2026-11-18（用户定）：任务页侧栏最上面的「环境与上下文」——项目、上下文分项（Claude）、说明文件和 MCP；
// 其他模型只有总量，写明没有分项。折叠后记住。

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function taskWith(s: Studio, folder: string, title: string, profileId: string, text: string): Promise<Session> {
  const ws = await s.api<Workspace>("POST", "/api/workspaces", { path: s.workspace(folder) });
  const { session } = await s.api<{ task: Task; session: Session }>("POST", "/api/tasks", { title, workspaceId: ws.id, firstSession: { profileId, text } });
  await expect.poll(async () => (await s.api<StateSnapshot>("GET", "/api/state")).sessions.find((x) => x.id === session.id)?.status, { timeout: 60_000 }).toBe("idle");
  return session;
}

test("the task sidebar shows the environment, the context by category and the session's MCP (2026-11-18)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  writeFileSync(join(studio.workspace("alpha"), "CLAUDE.md"), "# 项目说明\n回答用中文。\n");
  await taskWith(studio, "alpha", "环境面板", "claude-mock", "读一下项目");
  await page.getByTestId("task-card").filter({ hasText: "环境面板" }).click();

  const panel = page.getByTestId("env-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("env-facts")).toContainText("alpha");
  await expect(panel.getByTestId("env-context-total")).toContainText("已用", { timeout: 30_000 });
  await expect(panel.getByTestId("env-categories")).toBeVisible();
  await expect(panel.getByTestId("env-cat-messages")).toBeVisible();
  const files = panel.getByTestId("env-memory-files");
  await expect(files).toContainText("说明文件 ");
  await files.locator("summary").click();
  await expect(files).toContainText("CLAUDE.md");
  await expect(panel.getByTestId("env-mcp")).toBeVisible();
  await screenshot(studio.app, "studio", "task-env-panel", page);

  // 折叠后记住。
  await panel.getByTestId("env-fold").click();
  await expect(panel.getByTestId("env-context")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("amo.envPanelFolded"))).toBe("1");
  await panel.getByTestId("env-fold").click();
  await expect(panel.getByTestId("env-context")).toBeVisible();
});

test("a model without a breakdown shows the total and says so (2026-11-18)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  await taskWith(studio, "beta", "只有总量", "codex-mock", "你好");
  await page.getByTestId("task-card").filter({ hasText: "只有总量" }).click();
  const panel = page.getByTestId("env-panel");
  await expect(panel.getByTestId("env-context-note")).toContainText("不提供分项", { timeout: 30_000 });
  await expect(panel.getByTestId("env-categories")).toHaveCount(0);
});

// 重连（2026-11-18，Claude）：一开始连不上的 MCP 修好后，点「重连」就连上，不用重开会话。
const FLAKY = `
if (require("fs").existsSync(process.argv[2])) process.exit(1);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    const result = m.method === "initialize" ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "1" } } : { tools: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  }
});
`;

test("a Claude session's MCP that could not connect reconnects from the panel (2026-11-18)", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const folder = studio.workspace("gamma");
  const script = join(folder, "..", "flaky-mcp.cjs");
  const flag = join(folder, "..", "flaky-broken.flag");
  writeFileSync(script, FLAKY);
  writeFileSync(flag, "");
  await studio.api("POST", "/api/mcp/servers", { name: "flaky", spec: { type: "stdio", command: process.execPath, args: [script, flag] }, on: true });
  await taskWith(studio, "gamma", "重连 MCP", "claude-mock", "你好");
  await page.getByTestId("task-card").filter({ hasText: "重连 MCP" }).click();

  const panel = page.getByTestId("env-panel");
  const row = panel.getByTestId("env-mcp-flaky");
  await expect(async () => {
    await panel.getByTestId("env-refresh").click();
    await expect(row).toContainText("连不上", { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await screenshot(studio.app, "studio", "task-env-mcp-failed", page);

  rmSync(flag);
  await panel.getByTestId("env-mcp-reconnect-flaky").click();
  await expect(row).toContainText("已连接", { timeout: 30_000 });
  await expect(panel.getByTestId("env-mcp-reconnect-flaky")).toHaveCount(0);
});
