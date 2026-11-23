import { expect, test } from "@playwright/test";
import type { StateSnapshot, Task, Topic, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("project canvas prefers its common project and new tasks use the displayed topic", async () => {
  studio = await launchStudio();
  const { page } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("gamma") });
  await studio.api<Topic>("POST", "/api/topics", { title: "画布一" });
  await studio.api<Topic>("POST", "/api/topics", { title: "画布二" });
  const { topics } = await studio.api<StateSnapshot>("GET", "/api/state");
  const first = topics[0]!;
  const preferred = topics[1]!;
  await studio.api("PATCH", `/api/topics/${preferred.id}`, { workspaceIds: [beta.id] });
  for (const [topic, ws, title] of [[first, alpha, "默认画布任务"], [preferred, alpha, "项目专用画布任务"]] as const) {
    const { task } = await studio.api<{ task: Task }>("POST", "/api/tasks", { title, workspaceId: ws.id, topicId: topic.id });
    await studio.api("PUT", `/api/tasks/${task.id}/canvas`, { onCanvas: true });
  }
  const canvas = () => page.getByRole("button", { name: "画布", exact: true }).click();
  const cards = page.getByTestId("canvas-card");
  await page.getByTestId("scope-ws-beta").click();
  await canvas();
  await expect(cards).toContainText("项目专用画布任务");
  await screenshot(studio.app, "studio", "canvas-project-preferred", page);
  await page.getByRole("button", { name: "+ 新任务", exact: true }).click();
  await expect(page.getByRole("group", { name: "专题", exact: true }).getByRole("button", { name: preferred.title, exact: true })).toHaveAttribute("aria-pressed", "true");
  await canvas();
  await expect(cards).toContainText("项目专用画布任务");
  await page.getByTestId("scope-ws-gamma").click();
  await canvas();
  await expect(cards).toContainText("默认画布任务");
  await page.getByTestId(`scope-topic-${preferred.title}`).click();
  await expect(cards).toContainText("项目专用画布任务");
  await page.getByTestId("scope-all").click();
  await canvas();
  await expect(cards).toContainText("默认画布任务");
});
