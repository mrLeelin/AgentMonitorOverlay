import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type Route, type TestInfo } from "@playwright/test";
import type { BotLeadOperationReceipt, BotLeadTaskView, BotRequest, Session, SessionItem, StateSnapshot, StudioBot, TaskResult, TaskWorkflow, Workspace } from "@amo-studio/protocol";
import { screenshot, studioRoot, type Studio } from "./studio.js";

export async function project(studio: Studio, name: string) {
  const path = studio.workspace(name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: path, windowsHide: true, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(path, "sample.txt"), "lark\ntern\n", "utf8");
  git("-c", "core.autocrlf=false", "add", "sample.txt");
  git("-c", "user.name=Studio Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Isolated fixture");
  return studio.api<Workspace>("POST", "/api/workspaces", { path });
}

export const createBot = (studio: Studio, workspace: Workspace, name: string, profileId = "codex-mock") =>
  studio.api<StudioBot>("POST", "/api/bots", { name, purpose: "仅协调当前临时验证项目", memory: "", profileId, workspaceId: workspace.id, enabled: true });
export const snapshot = (studio: Studio) => studio.api<StateSnapshot>("GET", "/api/state");
export const leadState = (studio: Studio, taskId: string) => studio.api<BotLeadTaskView>("GET", `/api/tasks/${taskId}/bot-lead`);
export const items = (studio: Studio, sessionId: string) => studio.api<SessionItem[]>("GET", `/api/sessions/${sessionId}/items`);
export const workflow = (studio: Studio, taskId: string) => studio.api<TaskWorkflow>("GET", `/api/tasks/${taskId}/workflow`);
export const requestById = async (studio: Studio, id: string) => (await studio.api<BotRequest[]>("GET", "/api/bot-requests")).find((row) => row.id === id);

export async function workbench(page: Page) {
  if (await page.getByRole("region", { name: "Bots 工作台" }).isVisible()) return;
  await page.getByRole("button", { name: "Bot 选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "打开 Bots 工作台", exact: true }).click();
}

export async function otherWindow(studio: Studio): Promise<Page> {
  const opening = studio.app.waitForEvent("window");
  await studio.app.evaluate(({ BrowserWindow }, { url, preload }) => {
    const duplicate = new BrowserWindow({ show: false, focusable: false, x: -30000, y: -30000, width: 1200, height: 850,
      webPreferences: { preload, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    void duplicate.loadURL(url);
  }, { url: studio.page.url(), preload: join(studioRoot, "packages", "app", "dist", "preload.cjs") });
  const page = await opening;
  await page.waitForLoadState("domcontentloaded");
  return page;
}

export function holdRequest(page: Page, path: string, method: "POST" | "PUT" = "POST") {
  let arrive!: (route: Route) => void;
  let held = false;
  const arrived = new Promise<Route>((resolve) => { arrive = resolve; });
  const installed = page.route(`**${path}`, (route) => {
    if (held || route.request().method() !== method) return route.fallback();
    held = true;
    arrive(route);
  });
  return { installed, arrived };
}

export async function appointment(studio: Studio, topicTitle: string, title: string, instructions: string) {
  const { page } = studio;
  await page.getByTestId(`scope-topic-${topicTitle}`).click();
  await page.getByRole("button", { name: "画布", exact: true }).click();
  await page.getByRole("button", { name: "请机器人带队", exact: true }).click();
  const form = page.getByTestId("lead-appointment");
  await form.getByLabel("交付目标", { exact: true }).fill(title);
  await form.getByLabel("原话与相关结论", { exact: true }).fill(instructions);
  const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bot-leads/appointments" && response.request().method() === "POST");
  await form.getByRole("button", { name: "任命机器人", exact: true }).click();
  const response = await accepted;
  expect(response.ok(), await response.text()).toBe(true);
  const receipt = await response.json() as BotLeadOperationReceipt;
  if (receipt.action !== "create" || receipt.state.kind !== "appointed") throw new Error("Expected a new appointment receipt");
  return { receipt, term: receipt.state.term };
}

export async function firstSession(studio: Studio, taskId: string, timeout = 30_000): Promise<Session> {
  let matched: Session[] = [];
  await expect.poll(async () => {
    matched = (await snapshot(studio)).sessions.filter((session) => session.taskId === taskId && !session.archivedAt);
    return matched.length;
  }, { timeout }).toBe(1);
  return matched[0]!;
}

export async function submitMessage(studio: Studio, sessionId: string, text: string) {
  return studio.api("POST", `/api/sessions/${sessionId}/messages`, { text });
}

export async function resultIn(studio: Studio, taskId: string, state: TaskResult["state"], timeout: number, except?: string) {
  const latest = async () => (await workflow(studio, taskId)).results.filter((result) => result.taskId === taskId).at(-1);
  await expect.poll(async () => {
    const result = await latest();
    return result && result.id !== except ? result.state : "waiting";
  }, { timeout }).toBe(state);
  return (await latest())!;
}

export async function capture(studio: Studio, info: TestInfo, name: string) {
  const path = await screenshot(studio.app, "studio", name, studio.page);
  await info.attach(name, { path, contentType: "image/png" });
}

export async function evidence(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  await info.attach(name, { path, contentType: "application/json" });
}
