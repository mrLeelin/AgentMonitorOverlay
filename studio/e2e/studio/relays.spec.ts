import { expect, test } from "@playwright/test";
import type { Relay, Session, SessionItem, StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

// Topic sessions retain confirmation (task page or Focus); a task lead automatically dispatches managed work.

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("topic-only relays wait for confirmation and respect relayAuto", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "迁移" });
  const { task: target, session: targetSession } = await studio.api<{ task: Task; session: Session }>("POST", "/api/tasks", {
    title: "装甲车",
    workspaceId: ws.id,
    topicId: topic.id,
    firstSession: { profileId: "claude-mock", text: "开始迁移装甲车" },
  });
  const relayText = (text: string) => `[[mcp: task_message ${JSON.stringify({ taskId: target.id, text })}]]`;
  const leadSession = await studio.api<Session>("POST", `/api/topics/${topic.id}/sessions`, {
    workspaceId: ws.id,
    profileId: "claude-mock",
    text: relayText("先迁数据表，界面等我通知"),
  });
  await expect.poll(async () => (await studio!.api<Relay[]>("GET", "/api/relays")).map((r) => r.state), { timeout: 60_000 }).toEqual(["pending"]);

  // Focus shows it, answerable in place.
  const opened = studio.app.waitForEvent("window");
  await page.getByRole("button", { name: /^Focus/ }).click();
  const focus = await opened;
  await expect(focus.getByTestId("focus-relay")).toContainText("主控「主控」→「装甲车」", { timeout: 30_000 });

  // The target's page too: 发送 puts it into its session, marked as from the 主控.
  await page.getByTestId("task-card").filter({ hasText: "装甲车" }).click();
  const banner = page.getByTestId("relay-banner");
  await expect(banner).toContainText("先迁数据表，界面等我通知");
  await screenshot(studio.app, "stage-16", "S16-E-relay", page);
  await banner.getByTestId("relay-deliver").click();
  await expect(banner).toHaveCount(0);
  await expect(focus.getByTestId("focus-relay")).toHaveCount(0);
  const thread = page.getByTestId("thread");
  await expect(thread).toContainText("【主控「主控」传话】", { timeout: 30_000 });
  await expect.poll(async () => (await studio!.api<Relay[]>("GET", "/api/relays"))[0]).toMatchObject({ state: "delivered", sessionId: targetSession.id });

  // 主控传话不用确认: the next one goes straight in.
  await page.getByTestId("task-more").click();
  await page.getByTestId("task-relay-auto").click();
  await expect.poll(async () => (await studio!.api<{ tasks: Task[] }>("GET", "/api/state")).tasks.find((t) => t.id === target.id)?.relayAuto).toBe(true);
  await studio.api("POST", `/api/sessions/${leadSession.id}/messages`, { text: relayText("计划改了：先做界面") });
  await expect(thread).toContainText("计划改了：先做界面", { timeout: 60_000 });
  await expect(page.getByTestId("relay-banner")).toHaveCount(0);
  expect((await studio.api<Relay[]>("GET", "/api/relays")).map((r) => r.state)).toEqual(["delivered", "delivered"]);
});

test("concurrent managed relays automatically reuse one first target conversation", async () => {
  studio = await launchStudio();
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("relay-first-session") });
  const topic = await studio.api<Topic>("POST", "/api/topics", { title: "并发传话" });
  const lead = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "主控", workspaceId: ws.id, topicId: topic.id, lead: true });
  const target = await studio.api<{ task: Task }>("POST", "/api/tasks", { title: "执行", workspaceId: ws.id, topicId: topic.id, managerTaskId: lead.task.id });
  await Promise.all(["要求甲", "要求乙"].map((text) => studio!.api("POST", `/api/tasks/${lead.task.id}/sessions`, { profileId: "codex-mock", text: `[[mcp: task_message ${JSON.stringify({ taskId: target.task.id, text })}]]` })));
  await expect.poll(async () => (await studio!.api<Relay[]>("GET", "/api/relays")).filter((r) => r.state === "delivered").length).toBe(2);
  const relays = await studio.api<Relay[]>("GET", "/api/relays");
  const sessions = (await studio.api<StateSnapshot>("GET", "/api/state")).sessions.filter((s) => s.taskId === target.task.id);
  expect(sessions).toHaveLength(1);
  expect(relays.every((r) => r.sessionId === sessions[0]!.id)).toBe(true);
  const items = await studio.api<SessionItem[]>("GET", `/api/sessions/${sessions[0]!.id}/items`);
  for (const relay of relays) expect(items.filter((i) => i.id === `i-relay-${relay.id}`)).toHaveLength(1);
});
