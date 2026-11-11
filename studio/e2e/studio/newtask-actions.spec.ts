import { expect, test } from "@playwright/test";
import type { StateSnapshot, Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("new-task footer opens templates at the caret and files from the bottom right", async () => {
  studio = await launchStudio();
  const { page, app } = studio;
  const alpha = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("alpha") });
  const beta = await studio.api<Workspace>("POST", "/api/workspaces", { path: studio.workspace("beta") });
  await studio.api("POST", "/api/prompt-templates", { title: "巡检", body: "检查近期改动" });
  await studio.api("POST", "/api/prompt-templates", { title: "alpha 检查", body: "alpha 专用", workspaceId: alpha.id });
  await studio.api("POST", "/api/prompt-templates", { title: "beta 检查", body: "beta 专用", workspaceId: beta.id });
  await page.getByRole("button", { name: "+ 新任务" }).click();
  await page.getByRole("group", { name: "项目", exact: true }).getByRole("button", { name: "alpha", exact: true }).click();
  const first = page.getByLabel("第一句话");
  const templates = page.getByTestId("draft-templates");
  const file = page.getByTestId("draft-file");
  await first.fill("先看后做");
  await first.press("Home");
  await first.press("ArrowRight");
  await first.press("ArrowRight");
  await templates.click();
  const dialog = page.getByTestId("prompt-dialog");
  await expect(dialog.getByTestId("prompt-item")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(first).toHaveText("先看后做");
  await expect(first).toBeFocused();
  await first.press("Home");
  await first.press("ArrowRight");
  await first.press("ArrowRight");
  await templates.click();
  await dialog.getByTestId("prompt-item").filter({ hasText: "巡检" }).click();
  await dialog.getByTestId("prompt-ok").click();
  await expect(first).toHaveText("先看\n检查近期改动\n后做");
  await expect(first).toBeFocused();

  for (const [width, theme] of [[1280, "dark"], [1280, "light"], [1000, "dark"]] as const) {
    await app.evaluate(({ BrowserWindow }, [url, size]) => { BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.setSize(size, 900); }, [page.url(), width] as const);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    const startBox = (await page.getByTestId("draft-start").boundingBox())!;
    const templateBox = (await templates.boundingBox())!;
    const fileBox = (await file.boundingBox())!;
    const composerBox = (await page.locator(".draft-composer").boundingBox())!;
    expect(Math.abs(startBox.y - fileBox.y)).toBeLessThan(3);
    expect(templateBox.x).toBeGreaterThan(startBox.x + startBox.width);
    expect(fileBox.x).toBeGreaterThan(templateBox.x + templateBox.width);
    expect(composerBox.x + composerBox.width - fileBox.x - fileBox.width).toBeLessThan(15);
    expect(composerBox.y + composerBox.height - fileBox.y - fileBox.height).toBeLessThan(15);
    await screenshot(app, "studio", `newtask-actions-${theme}-${width}`, page);
  }

  await file.click();
  const card = page.getByTestId("task-card").filter({ hasText: "先看" });
  await expect(card).toBeVisible();
  const state = await studio.api<StateSnapshot>("GET", "/api/state");
  const task = state.tasks.find((t) => t.firstMessage === "先看\n检查近期改动\n后做")!;
  expect(task).toMatchObject({ workspaceId: alpha.id, column: "todo" });
  expect(state.sessions.filter((s) => s.taskId === task.id)).toEqual([]);
});
