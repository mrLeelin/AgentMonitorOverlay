import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Workspace } from "@amo-studio/protocol";
import { launchStudio, screenshot, studioRoot, type Studio } from "../support/studio.js";

let studio: Studio | undefined;

test.afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

test("the viewer plays local video, seeks, and pauses when showing changes", async () => {
  studio = await launchStudio({ mockModel: false });
  const { app, page } = studio;
  const dir = studio.workspace("clips");
  const name = "演示 #1.MP4";
  copyFileSync(join(studioRoot, "e2e", "fixtures", "viewer-video.mp4"), join(dir, name));
  copyFileSync(join(studioRoot, "e2e", "fixtures", "viewer-video.webm"), join(dir, "clip.webm"));
  writeFileSync(join(dir, "broken.mp4"), "invalid video");
  execFileSync("git", ["-C", dir, "init", "-q"], { windowsHide: true });
  const workspace = await studio.api<Workspace>("POST", "/api/workspaces", { path: dir });
  const open = (path: string) =>
    page.evaluate((target) => (window as unknown as { amo: { openViewer(t: unknown): Promise<void> } }).amo.openViewer(target), { path, workspaceId: workspace.id });

  const newWindow = app.waitForEvent("window");
  await open(name);
  const viewer = await newWindow;
  const video = viewer.getByTestId("file-preview-video");
  await expect(video).toBeVisible();
  await expect(video).toHaveJSProperty("controls", true);
  await expect(video).toHaveJSProperty("videoWidth", 160);
  await expect(video).toHaveJSProperty("paused", true);
  await video.press("Space");
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.1);
  await video.press("Space");
  await expect(video).toHaveJSProperty("paused", true);
  // Chromium paints the native timeline near the bottom of the video, outside the page's DOM.
  const player = (await video.boundingBox())!;
  const timelineY = player.y + player.height - 22;
  await viewer.mouse.move(player.x + 45, timelineY);
  await viewer.mouse.down();
  await viewer.mouse.move(player.x + player.width * 0.65, timelineY, { steps: 5 });
  await viewer.mouse.up();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.seeking && el.readyState >= 2 && el.currentTime >= 3 && el.currentTime < 4)).toBe(true);
  await screenshot(app, "studio", "viewer-video", viewer, "viewer");

  await video.press("Space");
  await expect(video).toHaveJSProperty("paused", false);
  await viewer.getByTestId("viewer-mode-changes").click();
  await expect(video).toHaveJSProperty("paused", true);
  await viewer.getByTestId("viewer-mode-file").click();
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThanOrEqual(3);
  await viewer.getByTestId("viewer-reload").click();
  await expect(video).toHaveJSProperty("videoWidth", 160);
  await expect(video).toHaveJSProperty("currentTime", 0);

  await open("clip.webm");
  await expect(viewer.getByTestId("viewer-name")).toHaveText("clip.webm");
  await expect(video).toHaveJSProperty("videoWidth", 160);
  await video.press("Space");
  await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0.1);

  await open("broken.mp4");
  await expect(viewer.getByRole("alert")).toContainText("无法播放这个视频");
  await expect(video).toBeHidden();
  await viewer.getByTestId("viewer-back").click();
  await expect(video).toBeVisible();
  await expect(video).toHaveJSProperty("paused", true);
});
