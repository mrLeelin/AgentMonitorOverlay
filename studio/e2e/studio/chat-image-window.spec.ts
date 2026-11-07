import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;
test.afterEach(async () => { await studio?.close(); studio = undefined; });

test("message and tool pictures open in a separate viewer while the conversation stays usable", async () => {
  test.setTimeout(120_000);
  studio = await launchStudio();
  const { app, page } = studio;
  const dir = studio.workspace("图片窗口");
  const picture = join(dir, "参考图.png");
  copyFileSync(join(studioRoot, "screenshots", "studio", "board-column-new-task.png"), picture);
  const ws = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  await studio.api("POST", "/api/tasks", { title: "对话图片窗口", workspaceId: ws.id, firstSession: { profileId: "claude-mock", text: "查看参考图" } });
  await page.getByTestId("task-card").filter({ hasText: "对话图片窗口" }).click();
  await expect(page.getByTestId("msg-agent").last()).toContainText("MOCK:", { timeout: 60_000 });
  const input = page.getByLabel("输入消息");
  await input.fill("参考这张图片");
  await input.evaluate((el, b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "参考图.png", { type: "image/png" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, readFileSync(picture).toString("base64"));
  await expect(input.locator(".resource-image")).toHaveAttribute("data-state", "ready");
  await input.press("Enter");
  const thumb = page.getByTestId("msg-user").last().getByTitle("查看大图");
  const opened = app.waitForEvent("window");
  await thumb.click();
  const viewer = await opened;
  const image = viewer.getByTestId("file-preview-image");
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
  await input.fill("窗口打开时仍可写消息");
  await screenshot(app, "studio", "chat-image-window", viewer, "viewer");
  await screenshot(app, "studio", "chat-image-conversation", page);

  // The unpinned viewer is reused, and closing it leaves the draft intact.
  await thumb.click();
  expect(app.windows().filter((w) => w.url().includes("#viewer"))).toHaveLength(1);
  await viewer.close();
  await expect(input).toHaveText("窗口打开时仍可写消息");
  await expect(page.getByTestId("run-status")).toHaveCount(0, { timeout: 60_000 });
  await input.fill(`[[read-image: ${picture}]]`);
  await input.press("Enter");
  const tool = page.getByTestId("tool-images").last();
  await expect(tool.locator("img")).toBeVisible({ timeout: 60_000 });
  const toolOpened = app.waitForEvent("window");
  await tool.getByRole("button").click();
  const toolViewer = await toolOpened;
  await expect(toolViewer.getByTestId("viewer-name")).toHaveText("参考图.png");
  await expect.poll(() => toolViewer.getByTestId("file-preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(100);
  await expect(page.getByTestId("lightbox")).toHaveCount(0);
});
